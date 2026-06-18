# 2D-PIXI retirement — HANDOFF (2026-06-18)

Resume point for the `2d-pixi-retirement` effort (driven by a `/loop` self-paced loop).
**Companion docs:** the per-item ledger [`2d-pixi-retirement-PROGRESS.md`](./2d-pixi-retirement-PROGRESS.md)
(source of truth for DONE + every footgun) and the scope/spec
`/home/wbterminal/from-vm/2d-pixi-export/docs/GROUND-TRUTH.md` (authoritative) + `PLAN.md` + `DELETE-LIST.md`.

## TL;DR — where we are

**The 2D PixiJS render path is functionally retired and the `pixi.js` dependency is GONE.**
- Branch `2d-pixi-retirement` (off `master @ 1e6ee27d`), **17 commits, nothing pushed.**
- 3D is the unconditional default; the unified pipeline (`unifiedDispatch`/`renderer=3d`/`unifiedClone`/
  `unifiedMotion` class-by-class) is default-on; `holtburger` loads + spawns in-world with
  `typeof PIXI === "undefined"`, 0 console errors.
- **`index.html`: 12,483 → 9,065 lines** (8b dead-code removal: −32). ~3,386 lines quarantined in `legacy/` (render_2d.js 91 KB,
  entity_2d.js 68 KB, door_2d.js 6.7 KB). Each is a reference copy per RULINGS item 2 (NOT imported).
- Every step was smoke-verified in-world; the load-bearing world-stream **seam survived** (wasm
  populate-halves still stream terrain/cells in 3D; A15-Q4 parity test 46/0).

## What shipped (commit trail)
Phase 1 flags: `c90d4ac4` unifiedDispatch · `241ebf4e` renderer=3d default · `2e19d8ac` unifiedClone ·
`7b53b30a` unifiedMotion class-by-class. Phase 2: `a99d9907` __doorStates hoist · `8c491973` client-pred
re-scope · `76a31b70` door split→legacy/door_2d.js. Phase 3: `2e8dab0d`+`c4254aca`+`ac8f7465` 7a render
pipeline→legacy/render_2d.js · `1222a1f1`+`3f4e0775` 7b entity dispatch→legacy/entity_2d.js · `324cb9d2`
7c ensure* PIXI-tail seam · `ca5ba439` 8a remove pixi.js. (`dc5e0a99`/`a376d82e` ledger.)

## Remaining queue (the tail — loop is mid-flight on these)
- **8b** — DONE (iter 14, smoke GREEN). Scope was over-stated: only 3 things were dead. KEPT (load-bearing,
  confirmed by grep): the backlog clone machinery (scene3d/loop.js:2818 still drains it) AND the `useSharedDrain`
  early-return (the net-frame pump `drainEvents`→`__scene3dEntityHook` is the ACTIVE 3D drain; the early-return
  stops `drainEntityEvents3D` double-consuming). Removed only `deferredSpawns` + `__deferredSpawnsOverflowWarned`
  decls + the dangling-`renderNeighbourhood` 2D else-block. index.html 9097→9065. (Minor dead colourMap compute
  left — out of scope.)
- **9** — MOSTLY DONE (iters 15-18). 9a deleted 16 dead/redundant 2D captures (`cc8d7134` + manifest
  `docs/2d-pixi-retirement-DELETED-CAPTURES.md`). 9b: physics_replay 3D-aligned (`84876160`, already
  renderer-agnostic); phase4_step3 + phase6_step_a were redundant-with-3D-siblings (deleted in 9a, not ported);
  phase6_step_e_doors blind-ported to 3D (`e9f4f482`, UNVALIDATED — needs Playwright). 9d oracle tap shipped
  (`18dddb76`, additive/write-only, tap-firing unvalidated). **9c STILL OPEN** — the `run-all.mjs` skip-as-green
  clause. Architectural snag: `runTier` uses `stdio:"inherit"` + GREEN-by-exit-code, and child runners fold
  skip→exit 0, so run-all can't distinguish skip-from-pass without capturing child output (loses the
  deliberate live-streaming) or a child-runner protocol change. Needs a design call (minimal honest-message
  fix vs full output-capture + `--strict-skips`).
- **10** — WS-B poser teardown (now unblocked, `unifiedMotion` default-on for the 5 classes): delete
  `scene3d/entities.js` `setSwingPose`/`setCastPose` + swing/cast tweens + `FULL_BODY_ONE_SHOT` + the
  death/door one-shot posers superseded by the Rust authority. **KEEP** `CROSSFADE_S`/`RESUME_WINDOW` + the
  locomotion band-aids (loco is NOT in the default — B-1). The no-MotionTable-link fallback callers need a
  no-op replacement. Touches motion → smoke + careful; revert on any motion ReferenceError.

## Parked — your decision, NOT blockers
- **3c `worldLifecycle=on`** — DEFERRED. Unsafe to flip standalone: its canonical ObjectDelete needs
  `unifiedTick=on` + `maintPrune=on` (both default-off; `unifiedTick` has a manual-movement collision hole
  without `unifiedTransition`). A physics-risk unification sub-project, orthogonal to the 2D-render retirement.
- **Quarantined 2D-backend handlers** — `handleEntityRemove`/`handleEntityMetaRefresh`/`ensurePortalChip`(now
  PIXI-free stub)/`handleEntityVelocity`/`handleEntityMotion` stay as no-op-in-3D stubs registered in
  `__dispatch2d`'s backend. Removing them needs a backend-table rework (lower value).
- **B-1** — the locomotion movement-integrator overshoot (Walk→Stop→Walk). Open, MOVEMENT-LAYER bug at the
  wasm `MovementSystem`/`get_state_velocity`. Keeps locomotion out of the `unifiedMotion` default. Do NOT
  re-add the `CROSSFADE_S`/`RESUME_WINDOW` band-aids.
- The 2 orphaned 2D Sets `terrainMeshAddedLbs`/`objectsRenderAddedLbs` (2 lines, left in place).

## How to resume / verify (CRITICAL operational knowledge)
**Browser smoke** (the validation bar — loads/spawns/0-errors, NO 1070 eye-test) via the chrome-devtools MCP
against the live stack (serve.py:8765 + wsbridge:8080 + ACE UDP 9000/9001). See the ledger's Environment note
+ memory `reference_chrome_devtools_inworld_smoke` for the full recipe. The three footguns:
1. **SW-cache** → the smoke URL MUST include `?nosw=1` (else a stale cached `index.html` is served).
   Full URL: `http://127.0.0.1:8765/apps/holtburger-web/?nosw=1&autoLogin=1&account=tailnet1&password=tailnet1&autoSpawn=first`.
2. **ghost-session** → before each smoke: navigate the tab to `about:blank`, `sleep 18 & wait` (foreground
   `sleep` is blocked → background it), THEN connect once (tailnet1 is single-login; overlap → ACE "Account In Use").
3. **preserved messages** → check console errors with `includePreservedMessages:FALSE` (true shows stale
   errors from prior reverted loads). Cross-check: a real boot break can't reach in-world.
In-page signals: `canvas.getContext("webgl2")` + `window.entityMap instanceof Map` + `getLocalPlayerGuid()`
non-null. `__USE_RENDERER_3D`/`liveScene3d` are module-scoped, NOT window globals — don't probe them.

**Tier-1 baseline:** `node harness/run-all.mjs --js` is RED at branch point with **5 pre-existing failures**
(input_controller, run_keys, jump_charge_parity, blocking_particle, default_script_spawn). The bar is
**zero NEW failures vs that baseline**, not absolute green.

## THE key lesson (read before any further strip)
**CALLER-FIRST.** The render pipeline (7a) leaves were safe to pull first (called only by removed/dead-2D
code). The entity functions (7b) are called from 3D-REACHABLE shared code (`pumpNetFrame` no-op tickers,
`dispatch2dSpawn`, `handlePositionUpdate`'s tail, the `__dispatch2d` backend) — pulling leaves first throws
`ReferenceError` in 3D (iter 11 reverted on exactly this). Order: **neutralize the 3D-reachable call sites
FIRST, then extract the orphaned leaves.** Before removing any symbol, grep its callers; if any is reached in
3D, neutralize that site first. Large extractions use a node line-range script (slice range → append legacy/
+ pointer comment), NOT giant exact-match edits. If a strip throws in the current navigation, REVERT — never
leave the branch broken.

## Guardrails (do NOT violate)
- Do NOT delete the ensure* wasm-populate halves or the 3 shared Sets
  (terrainPrefetchedLbs/buildingAabbsPopulatedLbs/cellContainersPopulatedLbs).
- KEEP module-scope shared state: window.entityMap, getLocalPlayerGuid/setLocalPlayerGuid, window.__doorStates,
  the URL-flag consts, window.__sessionHandle, handlePositionUpdate's shared streaming body, quaternionToYaw,
  landblockToWorldXY, neutralSpawn/neutralRemove, NEIGHBOURHOOD/HOLTBURG_*, the stance helpers.
- JS-stays (DON'T touch): scene3d/atmosphere_*, cloud_*, weather_state, hud.js, sky_dome/sky_lighting/
  sun_direction, vendor/takram*, the three/@takram/postprocessing/tiny-invariant importmap pins, the shared
  `<canvas>`, window.__pluginClient.
- Keep ACE vanilla (never touch ~/ace-server). Branch-commit only, never push. Capped wasm builds only
  (`capped-build wasm-pack build --target web --out-dir pkg`); never `cargo --workspace` locally (OOM).
