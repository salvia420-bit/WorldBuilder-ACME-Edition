# 2D-PIXI retirement — execution ledger

Branch: `2d-pixi-retirement` (off `master` @ 1e6ee27d). Driven by the `/loop` self-paced loop.
Spec: `/home/wbterminal/from-vm/2d-pixi-export/docs/GROUND-TRUTH.md` (authoritative) + `PLAN.md` + `DELETE-LIST.md`.
Bar per item: local build green + no NEW test failures + (where runnable) bare-default loads/spawns/0-errors. **No 1070 eye-test.**

## Baseline (pre-existing, NOT caused by this work)
Tier-1 `run-all.mjs --js` is RED at branch point with **5 pre-existing failures** (verified by stashing all edits and re-running — identical set):
`test_a14_i1_input_controller.mjs`, `test_a14_i3_run_keys.mjs`, `tests/jump_charge_parity.test.cjs`, `test_a11_s0_blocking_particle.mjs`, `test_a11_s5_default_script_spawn.mjs`.
→ The per-item bar is therefore **"zero NEW failures vs this baseline"**, not absolute green.

Environment note: **playwright is ABSENT** on this box, so the harness `--playwright` in-world spawn-smoke SKIPs. Browser loads/spawns/0-errors smoke is deferred as a single **batched browser pass** before Phase 3 (the physical strip). Per-item validation leans on the dedicated headless tests + the JS-tier baseline diff.

## Queue
### PHASE 1 — flip unified pipeline DEFAULT-ON (W6)
- [x] **1. unifiedDispatch default-on** — `index.html:4669` `v === "on"…` → `v?.toLowerCase() !== "off"` (mirrors `scene3d/loop.js:291`); comment + `docs/url-flags.md` row reconciled to default-ON. Verify: dedicated `test_a15_q4_renderer_neutral_core.mjs` **46/0 PASS**; Tier-1 JS baseline-identical (zero new fails); flag logic unit-checked (missing→ON, `=off`→OFF). Browser smoke: PENDING (batched). Commit: `<pending>`.
- [ ] 2. renderer=3d unconditional default (invert gate ~7333; keep `?renderer=2d` escape) + url-flags.md
- [ ] 3. flip rest default-on: unifiedClone, unifiedClientEvent, singleDriver, unifiedMotion=on, worldLifecycle=on + url-flags.md reconcile
### PHASE 2 — strip prerequisites (correctness refactors)
- [ ] 4. `__doorStates` module-scope hoist (GROUND-TRUTH §3.1) — must precede door split
- [ ] 5. client-prediction refactor (§3.2) — re-home `setLastClientPrediction` outside the sprite guard
- [ ] 6. DoorStateChanged surgical split (§6.1) — 2D branch + findClosestBuildingPart + __doorBuildingParts → legacy/
### PHASE 3 — physical strip to legacy/
- [ ] 7. move 57 DELETE_2D regions + PIXI-render tails of ensure* (KEEP wasm halves + 3 shared Sets)
- [ ] 8. remove pixi.js import (1258) + importmap (931); delete backlog clone machinery + useSharedDrain early-return + deferredSpawns
- [ ] 9. move/delete 2D captures; port 4 coverage-critical captures to 3D; fix run-all.mjs:417-422 skip-as-green
### PHASE 4 — WS-B motion teardown (AFTER unifiedMotion=on shipped + smoke)
- [ ] 10. delete setSwingPose/setCastPose/tweens/FULL_BODY_ONE_SHOT/CROSSFADE_S/RESUME_WINDOW

## Open / tracked (do NOT block the loop)
- **B-1** locomotion movement-integrator overshoot (Walk→Stop→Walk) — movement-layer bug, fix at wasm `MovementSystem`/`get_state_velocity`; never re-add the band-aids.
- **Batched browser smoke** — run once (loads/spawns/0-errors across the flipped defaults) before Phase 3; needs playwright install or the chrome-devtools driver + ACE up.
- **§9 human decisions** — per-entity portal swirl; unifiedMotion flip granularity.

## Log
- iter 1 — branch created; ledger created; item 1 (unifiedDispatch default-on) shipped.
