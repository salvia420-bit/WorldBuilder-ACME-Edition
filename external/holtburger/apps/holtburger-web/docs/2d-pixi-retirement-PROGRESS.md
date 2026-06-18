# 2D-PIXI retirement — execution ledger

Branch: `2d-pixi-retirement` (off `master` @ 1e6ee27d). Driven by the `/loop` self-paced loop.
Spec: `/home/wbterminal/from-vm/2d-pixi-export/docs/GROUND-TRUTH.md` (authoritative) + `PLAN.md` + `DELETE-LIST.md`.
Bar per item: local build green + no NEW test failures + (where runnable) bare-default loads/spawns/0-errors. **No 1070 eye-test.**

## Baseline (pre-existing, NOT caused by this work)
Tier-1 `run-all.mjs --js` is RED at branch point with **5 pre-existing failures** (verified by stashing all edits and re-running — identical set):
`test_a14_i1_input_controller.mjs`, `test_a14_i3_run_keys.mjs`, `tests/jump_charge_parity.test.cjs`, `test_a11_s0_blocking_particle.mjs`, `test_a11_s5_default_script_spawn.mjs`.
→ The per-item bar is therefore **"zero NEW failures vs this baseline"**, not absolute green.

Environment note: **playwright is ABSENT**, BUT the live stack is up (serve.py:8765 + wsbridge:8080 + ACE on UDP 9000/9001) and the **chrome-devtools MCP driver works** for a real browser smoke. App URL: `http://127.0.0.1:8765/apps/holtburger-web/`; bare-default smoke = that URL + `?nosw=1&autoLogin=1&account=tailnet1&password=tailnet1&autoSpawn=first` (NO `renderer` flag, to prove the 3D default). **SW-CACHE FOOTGUN (important):** the page registers a service worker that caches the app shell — a plain load serves a STALE `index.html` and your edits won't appear. ALWAYS append `?nosw=1` (unregisters SW + clears caches + cold-reloads once) for the smoke. Reliable in-page 3D signals: `canvas.getContext("webgl2")` truthy + `window.liveScene` falsy (2D skipped) + `getLocalPlayerGuid()` non-null (spawned); NOTE `__USE_RENDERER_3D`/`liveScene3d` are module-scoped, NOT window globals — don't probe them. Viewport renders dark under swiftshader (expected; visual fidelity is the 1070's job, not the smoke). **GHOST-SESSION FOOTGUN:** `tailnet1` is single-login — if a prior smoke's WS is still alive when the next connects, ACE thrashes both ("Account In Use / booting currently connected account") → boot `error`, no spawn (NOT a code bug). Before each smoke: navigate the tab to `about:blank`, `sleep 18 & wait` for ACE to drop the session, THEN connect once. Confirm via ACE log `~/...ace-0612-restart.log` / wsbridge `~/...wsbridge-0611.log`. (Foreground `sleep` is blocked; use `sleep N & wait`.)

## Queue
### PHASE 1 — flip unified pipeline DEFAULT-ON (W6)
- [x] **1. unifiedDispatch default-on** — `index.html:4669` `v === "on"…` → `v?.toLowerCase() !== "off"` (mirrors `scene3d/loop.js:291`); comment + `docs/url-flags.md` row reconciled to default-ON. Verify: dedicated `test_a15_q4_renderer_neutral_core.mjs` **46/0 PASS**; Tier-1 JS baseline-identical (zero new fails); flag logic unit-checked (missing→ON, `=off`→OFF). Browser smoke: PENDING (batched). Commit: `c90d4ac4`.
- [x] **2. renderer=3d unconditional default** — inverted all **6** `get("renderer") === "3d"` → `!== "2d"` (sites 2343/4614/6038/7304/7336/7547) + comment + url-flags.md row. `?renderer=2d` = escape. Verify: logic (missing→3D, =2d→2D, =3d→3D); Tier-1 JS baseline-identical (zero new); **REAL browser smoke GREEN** via chrome-devtools + `?nosw=1` — bare default → webgl2 canvas + `liveScene` null + spawned in-world (localGuid 1342177287) + channel-join + **0 console errors**. Commit: `241ebf4e`.
- 3. flip rest default-on (SPLIT per-flag for bisectability):
  - [x] **3a. unifiedClone default-on** + doc-reconcile unifiedClientEvent/singleDriver (already on in code). `index.html:4638` → `v?.toLowerCase() !== "off"`. Verify: logic; dedicated `test_a15_q2_entity_update_clone.mjs` **21/0**; Tier-1 baseline-identical; browser smoke GREEN (clean connect → in-world 19.6s, 0 console errors). Commit: `2e19d8ac`.
  - [x] **3b. unifiedMotion default-on, CLASS-BY-CLASS** (user §9 ruling: defer locomotion for B-1). New `"default"` mode in scene3d/entities.js (UNIFIED_MODE `null→"default"`, +`UNIFIED_DEFAULT`; attack/death/cast/door/missile gates OR it; LOCO stays `=locomotion`/`=on` only) + animation.js `UNIFIED_MOTION_ON` (`(v??"")!=="off"`) + url-flags.md. `=off` all-off, `=on` all incl loco. Verify: gate-logic table; Tier-1 baseline-identical incl. both unifiedMotion tests PASS; browser smoke GREEN (in-world 19.8s, webgl2, 0 console errors, unifiedMotion null=default). Commit: `<pending>`.
  - [ ] 3c. worldLifecycle=on default (Rust/lib.rs → capped wasm rebuild).
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
- iter 2 — item 2 (renderer=3d default) shipped; real browser smoke GREEN via chrome-devtools+nosw=1; discovered the SW app-shell cache footgun (see Environment note).
- iter 3 — item 3a (unifiedClone default-on + doc reconcile) shipped; first smoke hit the ghost-session account-in-use race (diagnosed via ACE log, NOT the flag); clean re-connect GREEN. Split item 3 → 3a/3b/3c.
- iter 4 — reached item 3b (unifiedMotion). §9 decision surfaced; user chose CLASS-BY-CLASS (defer loco). Implemented the `"default"` all-but-loco mode; smoke GREEN. Shipped 3b.
