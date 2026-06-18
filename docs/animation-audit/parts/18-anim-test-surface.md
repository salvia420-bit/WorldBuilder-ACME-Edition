I now have a complete, evidence-grounded picture. The "other runner" matches are just test files containing path strings in comments — there is no package.json test script and no glob runner. `run-js-headless.mjs`'s hardcoded 18-entry PLAN is the only aggregate gate. Here is the audit.

---

## What exists

The animation test/verification surface has **three layers**, only one of which runs in practice:

**1. The orchestrator + gate** (`harness/run-all.mjs`)
- Three tiers: `--js` (host-Node units), `--rust` (cargo), `--playwright` (in-browser). Registry at `run-all.mjs:103-128`. Default is `--js` (`run-all.mjs:177`), the only tier with `needsServer:false, needsRebuild:false` — "THIS IS THE GATE THAT WORKS TODAY" (`run-all.mjs:19-20`).

**2. The host-JS gate** (`harness/run-js-headless.mjs`) — a **hardcoded 18-entry PLAN**: 15 Tier-1 (`run-js-headless.mjs:71-87`) + 3 Tier-4 (`:91-95`). The animation-relevant members are `test_hook_windows`/`test_hook_fire_queue` (AnimationHook time-window math), `test_a5_p3_root_motion`, `test_a9_stage2_setup_rig`, and the cjs `jump_charge_parity`/`remote_interp_ownership`. There is **no package.json test script and no glob runner** — anything not in this list is never run by any gate.

**3. The in-browser leg** (`harness/playwright/drive.mjs` + `flags.anim.mjs`) — 7 descriptors: `mtQueue` (`:64`), `jumpParity` (`:128`), `retailRunKeys` (`:245`), `rootMotionObject` (`:320`), `getLink` (`:411`), `placementId` (`:492`), `particleDegrade` (`:612`).

**4. The runtime diagnostic surface** (`scene3d/diag/motion.js`, wired at `scene3d/diag.js:460`) exposed as `window.__diag.motion`:
- `onMotionApplied(guid, inst)` (`motion.js:150`) — hooked from `entities.js:6884` after `crossFadeTo`, records locomotion transitions into `byGuid`/`globalHistory`.
- `onMotionLinkPlayed(meta)` (`motion.js:230`) — hooked from `entities.js:8312-8324`, captures the **attack/cast/gesture link-clip path** into a *separate* `linkPlays` ring (because `_tryPlayLink` raw-plays without touching `currentActionKey`).
- `coverageMatrix()` (`:310`), `coverageByCategory()` (`:383`, buckets into locomotion/jump/swing/cast/emote/reaction/death-reaction/door-interaction/…), `coverageSummary()` (`:334`), `stuckEntities()` (`:270`, cross-refs `__diag.wire.tail`), `reset()`/`coverageReset()`.

## How it works (file:line)

- **JS gate execution**: `run-js-headless.mjs:192-222` spawns each PLAN file as `node <file>`, exit 0 = PASS. Missing files are tolerated by default (`:194-195`, `:331`) — only `--strict-missing` makes a MISSING a FAIL.
- **Playwright dispatch**: `drive.mjs:277` boots once per merged query, gates on `inWorld`, then `await d.assertBrowser(helpers)` (`:345`). `inWorld` is defined weakly as `window.__bootState !== "error"` (`boot.mjs:238`).
- **Helper surface** the descriptors get (`boot.mjs:440-448`): `readGetter` (`:276`, calls a wasm `SessionHandle` method), `readDiag` (`:343`, **JSON-clones a debug global — can read `__diag.motion`**), `evalInPage` (`:261`), `consoleErrors` (`:421`), `waitMs` (`:429`).
- **Result classification** (`assert.mjs:17`): `pass | fail | skip | rebuild-pending`. Only `fail` is nonzero.
- **The full-body fix it should guard**: `entities.js:8298-8299` gates `_suppressBaseCycleForOverlay` (`:8338`) on `FULL_BODY_ONE_SHOT` — the literal fix for "attacks only swing the upper body" (three.js normalizes overlay + base cycle to ~50/50 → half-amplitude swings, `:8333-8337`).

## Fragility & workarounds

1. **The `__diag.motion` surface is never asserted by anything.** Grep for `__diag.motion`/`onMotionLinkPlayed`/`coverageMatrix`/`coverageByCategory`/`stuckEntities` across all `*.mjs`/`*.cjs` outside `scene3d/` returns **zero**. The coverage matrix is explicitly designed for an "input-matrix drill exit gate" (`motion.js:300-309`) but that gate is **operator-driven in the devtools console** — no test calls it. The richest signal for this exact class of bug is built and unused.

2. **The host-JS gate never touches the real mixer.** No PLAN test imports `scene3d/entities.js` to drive `setMotion`/`crossFadeTo`/`_tryPlayLink`. The two cjs tests that *mention* importing it disclaim it: `entity_anim_targets.test.cjs:4-8` — *"we can't import scene3d/entities.js directly (it needs THREE + a DOM + the wasm exports). Instead we **re-implement** the small pure contracts… **Keep these in sync with** scene3d/entities.js"*. The test asserts a **hand-copied duplicate** of the production logic (`:41-147`); a refactor that changes `entities.js` leaves the test green against its stale copy. This is the precise mechanism by which "a consolidation refactor silently re-breaks motion."

3. **The runtime-tight assertion is explicitly deferred and never built.** `test_ac_jump_clip_plays.mjs:16-20`: *"A truly runtime-tight test would assert `mixer.time > 0` after `mixer.update(dt)`… That requires a Three.js scene… deferred to Phase 6.3 (1070 Ti Playwright capture)."* The test only checks DAT data shape via a cargo example (`:88-98`), and `:232-238` re-confirms the mixer-advance assertion was never implemented. `test_ac_cast_over_locomotion.mjs:26-31` similarly: *"It does NOT exercise the runtime `playCastSequence`… or the AnimationMixer."*

4. **The animation tests that exist are orphaned from the gate.** Not in any PLAN: `test_ac_attack_type_for_weapon`, `test_ac_aim_level_for_velocity` (missile aim), `test_ac_cast_over_locomotion`, `test_ac_spell_cast_sequence`, `test_ac_spell_shape`, `test_ac_locomotion_dispatch`, `test_ac_locomotion_per_stance`, `test_ac_motion_inventory`, `test_ac_jump_clip_plays`, `test_ac_floaty_frame`, `test_phase7_4a_animation_clip`, `test_diag_combat_giveup`, `tests/entity_anim_targets`, `tests/emote_table`. They run **only by hand** (`node test_x.mjs`). And those that exist test the **input/classifier side** (which u32 MotionCommand to pick — `test_ac_attack_type_for_weapon.mjs:33-43`, `test_ac_aim_level_for_velocity.mjs:32-41`), never the **output side** (did the rig play it).

5. **`flags.anim.mjs` tests none of the four named fragilities.** Its 7 descriptors cover jump-charge, autorun, root-motion, link-resolver, placement, particle-degrade — **no attack-full-body, no missile fire, no monster-death, no door**. And most self-classify to `skip`/`rebuild-pending`/presence-only even when run (e.g. `mtQueue:111`, `jumpParity:171/228`, `rootMotionObject:393`, `placementId:579-589`).

6. **The in-browser leg almost never runs.** It needs serve.py + ACE + wsbridge + a wasm rebuild; `SERVER_DOWN`/`PLAYWRIGHT_MISSING` mark every descriptor `skip` and exit 0 (`drive.mjs:280-296`), and a stalled boot → `skip` (`:311-339`). The gate folds `skip`/`rebuild-pending`/`print-only` into **GREEN** (`run-all.mjs:417-422`). **Net: a fully-skipped playwright tier + green re-implemented JS units = GREEN gate while attack/death/door are 100% untested.**

7. **No guard for the exact shipped fixes.** Grep for `FULL_BODY|fullBody|suppressBaseCycle|one_shot|upper.?body|half.?amplitude` across tests → **NONE**. Grep for door/monster-death *animation* tests → none (matches are unrelated status/object-property code). The F15-1 full-body fix and any door/death motion can regress with a fully green gate.

8. **A real known bug is parked in a non-gating test.** `test_ac_jump_clip_plays.mjs:202-228` documents that the Jump clip is absent from every motion table → "the rig holds its idle pose during the entire jump arc" — but since the test isn't in the PLAN, this finding never trips CI.

9. **Tier-4 silent absence.** `run-js-headless.mjs:194-195/331` treats a missing test file as a non-failing MISSING row by default, so a deleted/never-authored animation test degrades to green silently.

## Retail (acclient) comparison

Retail has a **single motion authority**, and that is exactly what makes it testable with one oracle:
- `CMotionTable::GetObjectSequence` (`acclient.c:6893`) and `DoObjectMotion` (`:6899`) produce a `CSequence` of anims for **any** motion+state — attacks, deaths, doors, missiles flow through the identical entry point. `StopObjectMotion`/`StopObjectCompletely` (`:6900-6901`) and `get_link` (`:6892`, the two-hop resolver already ported as the `getLink` flag) are the only paths.
- `CMotionInterp::MotionDone(success)` (`:7098`) is the **single completion callback** for every interpreted motion; `DoInterpretedMotion`/`StopInterpretedMotion` (`:7108-7109`) the single drive. There is one place where "the motion finished" is decided.

Because retail funnels every animated object through one interpreter producing one sequence, a **single parity oracle** — *"given motion M and state S, `GetObjectSequence` yields anim list [...]"* — would cover attacks, deaths, doors, and missiles uniformly. Holtburger has **no equivalent single function**: motion is split across `setMotion`→`crossFadeTo` (locomotion, `entities.js:6884`), `_tryPlayLink` (attacks/casts, `:8312`), `_suppressBaseCycleForOverlay` (full-body, `:8338`), `playCastSequence`/`setSwingMotion`. That scatter is *why* the tests are per-path, re-implement contracts, and leave death/door uncovered — there is no one seam to assert against. The three.js `AnimationMixer` weight-blend (the source of half-amplitude swings) has **no retail analog**; retail just plays the sequence the table emits, so retail never had a "swing plays at 50%" failure mode to test for in the first place.

## Consolidation recommendations

1. **Build the deferred headless mixer harness — it does not need a GPU.** three.js `AnimationMixer` is pure JS math; instantiate the real mixer (or a faithful stub) in Node, import the real `entities.js` motion seam, drive `setMotion`/`_tryPlayLink`, and assert: `mixer.time` advances under `update(dt)`; the overlay's `'finished'` event restores the base-cycle weight (the F15-1 contract at `entities.js:8338`); per-bone weight of a swing overlay reaches the **whole** skeleton, not upper-body-only. This is the never-built "Phase 6.3" and it is the single highest-value addition.

2. **Promote `__diag.motion` from console toy to automated assertion.** Add one `flags.anim.mjs` descriptor that, in-world, scripts attack/cast/jump/death/door inputs, then via `helpers.readDiag('__diag.motion…')`/`evalInPage` asserts `coverageByCategory().swing > 0`, `.cast > 0`, `.reaction > 0` (death-taken), `.interaction > 0` (door), `.unknown === 0`, and `stuckEntities()` filtered to `recentWireEventsForGuid > 0` is empty. The surface already computes all of this (`motion.js:383-505`); only the assertion is missing.

3. **Adopt a single "motion oracle" parity test as the consolidation spine.** Mirror retail's `GetObjectSequence`: feed (motion, state) to both the JS pipeline and the Rust DAT port and assert identical anim sequences. One test then covers every motion class — the same property retail gets from having one interpreter.

4. **Fold the orphaned `test_ac_*` animation tests into the run-js-headless PLAN**, and gate the ones that must always exist with `--strict-missing`. Pair the input-side classifier tests (already written) with the new output-side mixer test so "picked the right command" and "actually played it" are both gated.

5. **Stop scoring a skipped animation leg as GREEN.** For animation specifically, require the in-world leg to have *run* (≥1 `pass`, not all-`skip`) before the gate is green — otherwise `SERVER_DOWN`→GREEN (`run-all.mjs:417-422`) hides total non-coverage. At minimum, surface "anim in-world leg: 0 ran" prominently in the final gate.

6. **Add explicit regression guards for the four named fragilities** so the consolidation refactor can't silently re-break them: (a) attack swing animates the full body, (b) missile/bow fire plays a clip (non-empty `linkPlays` after a shoot command), (c) monster death plays and **holds its final frame** (no STOP-clobber, the `motion.js:9-15` "drudge did not play damage-taken" case), (d) door open/close plays. Each maps to a `coverageByCategory` bucket that already exists but is never read.
