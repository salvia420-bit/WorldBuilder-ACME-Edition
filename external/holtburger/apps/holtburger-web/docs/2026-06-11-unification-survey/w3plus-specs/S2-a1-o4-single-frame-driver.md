# S2 — A1-O4 single frame driver (`?singleDriver=on`) — execution-grade spec

Agent S2 · 2026-06-11 · W3+ deep-spec sweep · item A1-O4 (the 2D-loop retirement seam).
Repo paths relative to `external/holtburger/` unless prefixed; retail truth =
`/home/wbterminal/ac-headers/acclient.c`.

---

## 1. read-HEAD + W2 assumptions

- **read-HEAD:** `61bea82f` (holtburger: W2/Batch-R2 buildbox dispatch manifest). Mid-read,
  `3172c03e` (A4-Q1 MotionTableManager queue core) landed; A4-Q1 is movement-crate-only
  (ROADMAP §5 Batch R2) and touches none of this item's files
  (`apps/holtburger-web/index.html`, `scene3d/index.js`, `scene3d/loop.js`). All `our
  file:line` cites below were taken at `61bea82f` and re-verified by symbol, not just line.
- **W2 in-flight assumptions:** A1-O4 assumes **none** of A4-Q1 / A3-D2 / A2-P1 /
  A7-R1/R2/R3/R6 / A9-Stage1 land in the three JS frame-driver files. Verified at read time:
  all five families are Rust-crate / lib.rs batches (ROADMAP §5 Batches R2/R3/R4); the only
  lib.rs item among them (A9-Stage1 placement-id plumb) does not touch the
  `SessionCommand::TickMovement` arm or any JS. If that changes, only line numbers rot, not
  the design.
- **HARD SEQUENCING DEPENDENCY (non-negotiable, ROADMAP §2 "2D-path seam" + §3 `loop.js`
  row):** A1-O4 is **BLOCKED until A15-Q4 (S3's spec) and A8-M3 (S4's spec) land**, and must
  serialize after A15-Q3 in the `scene3d/loop.js` conflict column. Required order in
  `loop.js`: A15-Q3 → A8-M3 → A15-Q4 → **A1-O4** → A11-S3. None of Q3/M3/Q4 are in-tree at
  read-HEAD (verified: zero grep hits for `legacyDirectDrain`, `unifiedEntityDispatch`,
  `unifiedDispatch`, `entity_dispatch.js`, `world_stream.js` in `apps/holtburger-web/`).
  This spec is written so an implementer can execute it the day Q4+M3 merge: §3 states, per
  stage, exactly what it consumes from their landed shapes and what it treats as opaque.
- A1-O3 (`?syncPhysicsTick`) is a **sibling** W5 item, not a prerequisite. O4 is specced
  O3-agnostic: the pump keeps the existing async `handle.tickMovement()` call and §3.4 pins
  the single line O3 later swaps. Verified not in-tree: zero grep hits for
  `tickPhysicsSync|syncPhysicsTick` in `apps/holtburger-web/`.

---

## 2. Current-state map (post-W0/W1)

### 2.1 Retail contract (the target shape)

Retail has ONE per-frame driver. `SmartBox::UseTime` (acclient.c:146256) runs, in one
synchronous pass: cell-streaming gate + `CellManager::ChangePosition`
(acclient.c:146268–146278) → `CObjectMaint::UseTime` (acclient.c:146284) →
`CPhysics::UseTime` (acclient.c:146285, which fires `PlayerPhysicsUpdatedCallback`
post-integration, acclient.c:311377) → GameTime/LScape/Ambient → **net dispatch**: drain
`in_queue`, `DispatchSmartBoxEvent` per NetBlob (acclient.c:146316, loop ~146294–146322) →
**input interp at frame bottom**: the per-frame `cmdinterp` vfptr[14] call
(acclient.c:146324). Render is a separate `SmartBox::Draw` (acclient.c:146329) invoked by
the same single outer driver. Net effects therefore integrate on the NEXT frame's physics;
input interp runs after net dispatch.

### 2.2 Our three concurrent JS frame drivers (the divergence, A1 §3 row 4)

| driver | site (ours) | does |
|---|---|---|
| 2D `drainEvents` rAF | def `index.html:9074`; self re-arm `index.html:11110`; boot arm `index.html:11112` | the whole net+input pump, §2.3 |
| 3D `tick` rAF | `scene3d/index.js:1458` (def), `:1736` (boot arm), `scheduleNext` `:1438–1457` | dt clamp + recovery (`:1464–1480`), `tickPerFrame` (`:1495`), moons/audio/weather/LRU, render, re-arm |
| `?netDrainHz=N` setInterval | `scene3d/index.js:1767–1784` | calls `tickPerFrame` while rAF idles (`?renderOnDemand=1`, `:333–336`; `__renderOnce` `:1743`) |

Retail cite for the divergence: one `SmartBox::UseTime` entry per frame (acclient.c:146256)
vs three independent drivers whose relative order is rAF-registration accident. The RP3
frame-budget guard (`scene3d/loop.js:1143–1298`) exists to survive exactly this.

### 2.3 What the 2D `drainEvents` body does today (`index.html:9074–11111`)

In order, one rAF callback:
1. `__rafTickCount++` + `?skytime=accel` push (`:9075–9089`).
2. **Game-event drain** `handle.poll_events()` for-loop, evt.kind 0–55 arms (`:9090` →
   ~`:10516`): chat/login/HUD DOM, plugin-bus bridges (`window.__pluginClient.events.emit`,
   e.g. `:9236`), door states, and the **kind=17 visibility arm** (`:10090–10114`) that
   calls `window.liveScene3d.entityManager.setVisibility` — the A8 §3 row 6 cross-renderer
   hop that A8-M3 relocates. Retail analog of this whole block: the in_queue drain
   (acclient.c:146294–146322). This half is the seam's PARITY half (single owner, A15 §3
   row 8).
3. **Entity-update drain** `handle.pollEntityUpdates()` (`:10625`): forward (pre-free) to
   `window.__scene3dEntityHook` (`:10641`; live impl `dispatchOne` installed by
   `installSharedDrainHook`, `scene3d/loop.js:2011/2025`, install site
   `scene3d/index.js:3746`); then the 2D kinds-0–5 for-loop (`:10642–10726`) incl.
   `handlePositionUpdate` (`index.html:6071`) whose local-player block drives **3D world
   streaming** (`loadEnvCellsForLandblock`/`loadTerrainForLandblock`/
   `loadSpawnsForLandblock`, `index.html:6151–6200`) — retail analog: the CellManager
   prefetch/recenter inside the same UseTime pass (acclient.c:146268–146278); then
   `upd.free()` (`:10725` — the pump owns the wasm-bindgen lifetime).
4. `deferredSpawns` replay (`:10731–10735`, A15-Q1-capped) + 2D presentation ticks
   (`tickEntityInterpolation` `:10741`, `updateNameplatePositions` `:10746`,
   `tickEntityAnimations` `:10751`, `tickCellVisibility` `:10757`) — all effectively no-op
   in 3D mode (gated on `liveScene`/2D `entityMap`, which stay empty under `?renderer=3d`,
   `index.html:10654–10658`).
5. `handle.tickMovement()` (`:10770`) — enqueues `SessionCommand::TickMovement`, processed
   by the wasm recv-loop arm at `src/lib.rs:38975` (post-W1 this arm carries the
   `?unifiedTick` canonical spine, `lib.rs:93–106` → `crates/holtburger-core/src/client/
   tick_spine.rs:61–89`, plus `?maintPrune` `lib.rs:109–124` and `?posePublishPostTick`
   `lib.rs:126–141`). Async: integrates as a microtask AFTER the rAF callbacks — the A1 §3
   row 3 ordering divergence vs retail physics-before-net-in-one-pass
   (acclient.c:146285 before 146316). O3's problem, not O4's; O4 must not foreclose it.
6. 2D sprite prediction + `setLastClientPrediction` shadow push (`:10795–10941`) — gated on
   `entityMap.get(spawnedPlayerGuid)?.sprite`, so a no-op in 3D mode.
7. **Input dispatch on keystate sig change** (`:10949–11108`): `setMovementInput` via the
   A14-I1 InputController when `__inputFunnelOn` (`:10966–10976`; flag read `:1318`;
   controller `scene3d/input.js:74`), plus two **3D rig side-effects that exist ONLY
   here**: the W3.1 local forward `em.setMotion` prediction (`:11000–11025`) and the
   diagonal-strafe `em.setSidestepLayer` overlay (`:11052–11107`). `camera.js`'s own
   dispatcher deliberately does NOT fire the sidestep overlay
   (`scene3d/camera.js:1606–1616`), so cancelling the 2D loop without preserving block 7
   silently breaks diagonal-strafe arm animation. Retail analog of input-at-frame-bottom:
   acclient.c:146324.
8. Self re-arm (`:11110`).

**Consequence:** "single frame driver" can NOT mean "cancel the 2D rAF". Blocks 2, 3, 5, 7
are load-bearing for 3D mode (ROADMAP §7.4; RULINGS #2 keeps 2D supported, so the 2D-mode
behavior of all blocks must survive untouched). The pump must move wholesale to the 3D
driver, not die.

### 2.4 What Q4/M3 are expected to have changed by execution time

- **A15-Q4** (S3's item): block 3's kinds-0–5 for-loop extracted to `entity_dispatch.js`
  (backends `dispatch2D`/`dispatch3D`) and block 3's streaming half relabeled into
  `world_stream.js`, behind `?unifiedDispatch=on` (A15 §4 Q4). O4 treats the post-Q4 pump
  body as **opaque** — O4 wraps and relocates the caller, never reaches inside.
- **A8-M3** (S4's item): block 2's kind=17 arm (and any other rig-affecting ClientEvent)
  moved into the scene3d dispatch layer next to `dispatchOne` behind
  `?unifiedEntityDispatch=on` (A8 §4 M3). After M3, no 3D rig correctness lives in block 2;
  block 2 becomes pure chat/HUD/plugin-bus + 2D handlers.
- Flag names above are from the A15/A8 survey reports; if S3/S4 rename them, only this
  section's labels rot — O4 consumes no symbol from either.

---

## 3. Staged implementation plan

All stages **JS-live** (no wasm rebuild, no new exports, **no
`WASM_EXPORT_MANIFEST_VERSION` bump**). One new URL flag: `?singleDriver=on`
(default-off), documented in `docs/url-flags.md`. Per RULINGS #2 (2D stays supported), the
flag is inert unless `?renderer=3d` is also present.

### Stage O4-a — extract the pump (behavior-preserving refactor, no flag semantics)

**File: `apps/holtburger-web/index.html`.**

1. Rename the body of `drainEvents` (`index.html:9074` through the line before the re-arm
   at `:11110`) into a new closure-scoped function in the SAME scope (it closes over
   `handle`, `characterUl`, `loginStatus`, `keyState`, `entityMap`, `liveScene`, etc. —
   do NOT move it to a module):
   ```js
   function pumpNetFrame() {            // = old drainEvents body, verbatim
     window.__lastPumpMs = performance.now();   // heartbeat for the O4-c watchdog
     ... existing blocks 1–7 unchanged ...
   }
   function drainEvents() {
     pumpNetFrame();
     requestAnimationFrame(drainEvents);        // unchanged re-arm, gated in O4-b
   }
   ```
2. Expose, immediately after the definitions (next to the existing boot arm at `:11112`):
   `window.__netFramePump = pumpNetFrame;` and
   `window.__resume2dFrameDriver = () => { requestAnimationFrame(drainEvents); };`
3. No other line changes. The `upd.free()` lifetime (`:10725`), deferred-spawn replay, and
   input side-effects move as an unsplit unit, so wasm-bindgen handle ownership is
   unchanged by construction.

Acceptance: zero behavior diff with and without `?renderer=3d` (the function boundary is
the only change).

### Stage O4-b — driver handoff behind `?singleDriver=on`

**File: `apps/holtburger-web/index.html`.**

1. Parse once next to `__USE_RENDERER_3D` (`index.html:4466–4467`), same idiom:
   ```js
   const __SINGLE_DRIVER_ON =
     new URLSearchParams(window.location.search).get("singleDriver") === "on";
   ```
2. Gate the wrapper (claim-check EVERY frame, so a later un-claim resumes automatically):
   ```js
   function drainEvents() {
     if (__SINGLE_DRIVER_ON && __USE_RENDERER_3D && window.__scene3dFrameDriverActive) {
       if (!window.__singleDriverHandoffLogged) {
         window.__singleDriverHandoffLogged = true;
         console.log("[singleDriver] 2D rAF driver parked — scene3d owns the frame pump");
       }
       _arm2dWatchdog();          // O4-c; does NOT pump, does NOT rAF-re-arm
       return;
     }
     pumpNetFrame();
     requestAnimationFrame(drainEvents);
   }
   ```
   The 2D loop therefore keeps driving login/character-select (which happen before the 3D
   renderer boots — `renderHoltburg()` is awaited AFTER the boot arm,
   `index.html:11112–11118`) and all 2D-mode sessions, exactly as today.

**File: `apps/holtburger-web/scene3d/loop.js`.**

3. New **CRITICAL phase #0** at the very top of `tickPerFrame` (`loop.js:1299`), before the
   RP3 stamp and `tickCellVisibility3D` (`:1321`), NEVER RP3-budget-gated (net + input are
   in the same never-gate class as phase #13, `loop.js:1527–1532`):
   ```js
   // ── CRITICAL #0 (A1-O4) — single-driver net/input pump. Retail runs net
   // dispatch + input interp inside the one UseTime pass (acclient.c:146316,
   // :146324); under ?singleDriver=on the scene3d driver owns that pass.
   // Frame-top placement (retail dispatches at frame-bottom) is equivalent
   // modulo one frame and means a server force-position lands before this
   // frame's physics enqueue — A1 §4 Stage O4's documented choice.
   if (scene3d?.singleDriverOn && typeof window !== "undefined"
       && typeof window.__netFramePump === "function") {
     try { window.__netFramePump(); } catch (e) {
       if (!scene3d._netPumpWarned) { scene3d._netPumpWarned = true;
         console.warn("[singleDriver] __netFramePump threw:", e); }
     }
   }
   ```
   Placing it INSIDE `tickPerFrame` (not in index.js `tick`) makes the `?netDrainHz=N`
   interval (`scene3d/index.js:1767–1784`) and `__renderOnce` (`:1743`) inherit the full
   contract-minus-render for free — resolving A1 §6's open `netDrainHz`×O4 interaction by
   construction.

**File: `apps/holtburger-web/scene3d/index.js`.**

4. Parse `?singleDriver=on` next to the `renderOnDemand`/`netDrainHz` parses
   (`:323–366`), same defensive try/catch idiom. Claim rule (one boolean expression, no
   judgment): claim iff
   `singleDriver && !(renderOnDemand && !(netDrainHz > 0))`.
   The excluded combo (renderOnDemand without netDrainHz) has NO periodic 3D caller of
   `tickPerFrame`, so claiming would starve net/chat; emit
   `console.warn("[singleDriver] ?renderOnDemand=1 without ?netDrainHz — 2D loop remains the net driver")`
   and leave `__scene3dFrameDriverActive` unset.
5. Claim point: immediately after `installSharedDrainHook(liveScene3d)`
   (`scene3d/index.js:3746`) — the entity hook is live before the 2D loop parks, so no
   update is dropped during handoff:
   ```js
   liveScene3d.singleDriverOn = true;
   window.__scene3dFrameDriverActive = true;
   ```
6. Un-claim on every path that stops the 3D cadence, mirroring the existing handles:
   `stop()` (`:2189`) and `onPause` (`:2445`) additionally do
   `window.__scene3dFrameDriverActive = false; window.__resume2dFrameDriver?.();`
   `onResume` (`:2446–2456`) re-sets `window.__scene3dFrameDriverActive = true` (the 2D
   wrapper re-parks itself on its next frame — at most a handful of double-pumped frames,
   which is exactly today's steady-state concurrency, §5 R3).

**File: `docs/url-flags.md`** — add `?singleDriver=on` (default off; requires
`?renderer=3d`; interaction table with `renderOnDemand`/`netDrainHz` per rule 4).

Resulting per-frame contract under flag-on (one rAF callback, deterministic order):
net-apply + entity dispatch + streaming + tickMovement-enqueue + input side-effects
(phase #0) → cells/PVS/lighting (#1–#12) → camera/input funnel (#13, `loop.js:1533`) →
mixer + entity drains + local pose (#15/#16/#19, `loop.js:1563–1589`) → nameplates (#20) →
render (`scene3d/index.js:1607+`). This is `SmartBox::UseTime`'s shape
(acclient.c:146256–146325) with net moved to frame-top; input dispatched at #13 feeds the
next frame's physics exactly as retail's frame-bottom cmdinterp (acclient.c:146324) does.

### Stage O4-c — 2D watchdog (runtime rollback; ships with O4-b, same flag)

**File: `apps/holtburger-web/index.html`.** `_arm2dWatchdog()`: a single 2 s `setTimeout`
chain (NOT rAF — must fire in hidden tabs) that, while
`window.__scene3dFrameDriverActive`, checks the `window.__lastPumpMs` heartbeat stamped by
`pumpNetFrame`. If `performance.now() - __lastPumpMs > 4000` (two misses), log
`[singleDriver] pump heartbeat stale — resuming 2D driver`, clear
`window.__scene3dFrameDriverActive`, and call `window.__resume2dFrameDriver()`. This makes
"3D loop died with the claim held" (an uncaught throw between `tickPerFrame` and
`scheduleNext` in `scene3d/index.js:1458–1736` kills the rAF chain) self-healing instead
of a frozen chat/net session. Watchdog disarms itself when the claim flag is off.

### Stage O4-d — A1-O3 integration point (documentation-only in this item)

The pump's physics call is the single line `index.html:10770`
(`try { handle.tickMovement(); } catch (_) {}` — inside `pumpNetFrame` after O4-a). When
O3 lands, ITS spec swaps this line to the synchronous
`tickPhysicsSync(dtMs)`-with-channel-fallback under `?syncPhysicsTick=on`, turning the
phase-#0 contract into retail's same-frame integrate-before-read
(acclient.c:146285 before :146316 / 311377). O4 must not inline, duplicate, or relocate
this call anywhere else — one swap point, owned by O3.

### Explicitly out of scope (do-not-do, ROADMAP §8 + RULINGS #2)

- Deleting/quarantining the 2D path or its kinds-0–5 handlers (2D stays supported).
- Touching the RP3 guard (`loop.js:1143+`) — it stays as belt-and-braces under O4 (A1 §5).
- Reordering anything inside `pumpNetFrame` (that is Q4's / O3's / A14's territory).
- A11-S3 (clock move) — serialized strictly AFTER O4 in the `loop.js` column (ROADMAP §3).

---

## 4. Test plan

### Headless-now (buildbox / laptop headless chromium lane, `?nullRender=1` mandatory per DESIGN.md §5 measurement-traps; plus node-level where possible)

1. **Flag-off byte-equivalence (O4-a):** existing entity-pipeline suites
   (`test_phase7_4b_entity_pipeline.mjs`, `test_phase7_batch9_entity_lifecycle.mjs`) green,
   plus a default-URL (2D) smoke and a `?renderer=3d` (no singleDriver) smoke: assert
   `window.__rafTickCount` advances and chat events land — proves the pump extraction is
   inert.
2. **Handoff:** `?renderer=3d&singleDriver=on&nullRender=1` — after scene3d init, assert
   (a) `window.__rafTickCount` FREEZES within ~2 frames of
   `window.__scene3dFrameDriverActive === true` (2D driver parked), (b) injected entity
   updates still reach the 3D `entityManager` (pump runs from phase #0), (c) chat events
   still append to the DOM panel (block-2 arms alive from the new driver), (d)
   `window.__lastPumpMs` advances every frame.
3. **Input side-effect survival:** with the handoff active, synthesize keystate
   (forward+strafe) and assert one `setMovementInput` dispatch per sig change
   (`window.__smiCallCount`), and that `em.setMotion` + `em.setSidestepLayer` were invoked
   (spy/wrap) — pins §2.3 block 7 (the camera.js gap, `scene3d/camera.js:1606–1616`).
4. **netDrainHz lane:** `?renderer=3d&singleDriver=on&renderOnDemand=1&netDrainHz=10&nullRender=1`
   — assert claim happens, `__lastPumpMs` advances at ~10 Hz with zero rAF frames (the A1
   §6 open question's regression test).
5. **Refused-claim combo:** `...&renderOnDemand=1` WITHOUT netDrainHz — assert the warn
   fires, claim flag stays unset, `__rafTickCount` keeps advancing (2D still drives).
6. **Watchdog:** with handoff active, call `window.__stopNetDrain?.()` /
   `liveScene3d.stop()`-equivalent or stub `tickPerFrame` to throw; assert within ≤6 s the
   2D driver resumes (`__rafTickCount` advancing again) and the stale-heartbeat log fired.
7. **RP3 invariants:** existing RP3 semantics tests/behaviour unchanged (phase #0 is
   never-gated; assert PVS/SKY/NAME throttle bookkeeping identical flag-on vs flag-off over
   a synthetic 120-frame run).

### 1070-gated (parked until the box returns; Lane B per ROADMAP §4)

- Chat/HUD regression sweep in-world (the 2D loop owns chat today — A1 §4 O4's named risk).
- Input-latency / feel verdict A/B (`?singleDriver` on vs off), jointly with O3 once both
  exist (A1 §5: O4's final verdict is 1070-gated).
- Brief 2D default-URL smoke (RULINGS #2: supported mode must still render sprites).
- Walk-away/teleport spot-check that streaming (`world_stream.js` post-Q4) still triggers
  from the new driver (terrain/envcells/spawns load on landblock cross).

---

## 5. Risks + rollback

- **R1 — net/chat starvation if the 3D loop dies while claimed.** Mitigated structurally
  (O4-c watchdog, un-claim on `stop()`/`onPause`). Residual: ≤4 s of frozen chat before
  self-heal. Rollback: flag off.
- **R2 — losing the index.html-only input side-effects** (W3.1 forward `em.setMotion`
  `index.html:11000–11025`, sidestep overlay `:11052–11107`). Designed out: the pump moves
  unsplit (O4-a) — these fire from phase #0 under the new driver. Test 3 pins it.
- **R3 — double-pump during handoff/resume windows.** Benign by the same argument that
  today's three concurrent drivers are survivable: `poll_events`/`pollEntityUpdates` are
  take-based (drain-once), `tickMovement` enqueue is cadence-tolerant (the wasm arm
  computes dt from `now`, `src/lib.rs:38975`), input dispatch is sig-deduped
  (`index.html:10962–10980`, InputController A14-I1). Documented, not guarded.
- **R4 — hidden-tab rAF throttling now throttles net in 3D mode.** Parity with today (the
  2D pump is also rAF-driven); bots keep `?netDrainHz`. No new exposure.
- **R5 — rebase hazard:** O4 lands LAST in the `loop.js`/`index.html` W5 column before
  A11-S3 (ROADMAP §3). If Q4 moved the blocks O4-a wraps, re-derive the wrapper around
  Q4's landed body — the design (wrap, expose, claim, watchdog) is body-shape-independent.
- **Rollback:** `?singleDriver` absent → drainEvents wrapper short-circuit never taken,
  phase #0 never runs, claim never set — byte-path-identical to pre-O4 except the O4-a
  function boundary. Full revert = revert the three-file diff; no wasm artifact involved.

---

## 6. OPEN QUESTIONS

1. **Exact landed module shapes of A15-Q4 / A8-M3** (function names, flag spellings,
   whether Q4 keeps the pump body in index.html closure scope or moves streaming dispatch
   out of `handlePositionUpdate`). O4 treats the body as opaque, but the O4-a extraction
   diff must be written against their merged shape — re-read S3/S4 specs before execution.
   (Cannot dual-cite: code not in tree at read-HEAD.)
2. **2D-vs-3D rAF registration order during the pre-claim boot window** — A1 §6 carried
   this; under O4 it becomes moot post-claim, but the handoff window (login → renderer
   boot) still has both loops in spec-defined registration order. Not traced live
   (read-only sweep, no builds/browsers); only affects whether a single boot frame
   double-pumps, covered by R3.
3. **Should phase #0 run before or after the RP3 frame-start stamp** (`loop.js:1304–1306`)?
   This spec says before (pump cost excluded from the deferrable budget, matching its
   CRITICAL class). If pump spikes (chat bursts) should instead count against the budget to
   protect render pacing, flip it below the stamp — 2-line change, eye-test-neutral.
   No retail cite exists for a frame-budget concept (EXTRA machinery).
4. **`?skytime=accel` cadence under netDrainHz-driven pump** — the synthetic day clock
   (`index.html:9081–9089`) would advance at netDrainHz instead of rAF rate in the bot
   combo. Wall-clock-derived (`performance.now()`), so rate-independent — believed fine,
   but the Sky-F e2e capture should be re-run once (headless) to confirm.
5. **Final ordering/latency verdict** (does frame-top net + next-frame input integration
   feel retail-correct?) — 1070-gated by definition (A1 §5); the headless lane can only
   prove ordering, not feel.
