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
  (`18dddb76`, additive/write-only, tap-firing unvalidated). **9c DONE** (`025deab1`) — capture + `--strict-skips`:
  `runTier` captures child output (re-printed, buffered per-tier), scans for tier-level skip banners
  (`SERVER_DOWN`/`PLAYWRIGHT_MISSING`/`cargo-absent`/`print-only`) → new SKIP status; gate = GREEN / "GREEN
  (with skips)" / RED; `--strict-skips` escalates SKIP→RED. **Item 9 COMPLETE.**
- **10** — WS-B vibe-poser teardown **DONE** (`f39a8c77`, smoke GREEN, motion behavior UNVALIDATED). Removed
  `setSwingPose`/`setCastPose` + ALL swing/cast tween machinery (caller-first: 6 internal fallbacks → no-op
  return; 3 external callers auto-no-op via their typeof/`?.` guards). **KEPT** `CROSSFADE_S`/`RESUME_WINDOW`
  + `_jumpPoseTween`/`_tickJumpPoseTween` (jump retail-correct). **DEFERRED `FULL_BODY_ONE_SHOT`** — on
  inspection it's the real full-body-OVERLAY flag (default-ON, gates `_suppressBaseCycleForOverlay` on live
  motions), NOT a dead vibe-poser; removing it is a behavior-affecting flag-hardcode best done with overlay
  validation. There was no separate `setDeathPose` (door → unified `playDoorMotion`, KEPT). Static grep +
  node --check eliminate the ReferenceError risk; swing/cast *behavior* needs a 1070 eye-test / motion capture.

## Remaining (small, optional)
- **`FULL_BODY_ONE_SHOT` flag-hardcode — DONE** (smoke GREEN, overlay behavior UNVALIDATED). Removed the
  default-ON flag + its `?fullBodyOneShot=off` escape; the full-body one-shot overlay (base-cycle weight → 0
  via `_suppressBaseCycleForOverlay`, no legs-out crossfade) is now unconditional. url-flags.md row marked
  RETIRED. Static grep 0 refs + node --check + Tier-1 baseline + boot smoke (EntityManager + 46 entities,
  `_suppressBaseCycleForOverlay` present, 0 errors). Overlay *behavior* needs a 1070 eye-test.
- **Playwright + 1070 validation pass** (the only thing left) — run `capture_physics_replay` (validates the
  9d oracle tap) + the ported `capture_phase6_step_e_doors` in a Playwright env; eye-test item-10 swing/cast
  + the FULL_BODY_ONE_SHOT overlay on the 1070. All retirement CODE is shipped; this is verification only.

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
