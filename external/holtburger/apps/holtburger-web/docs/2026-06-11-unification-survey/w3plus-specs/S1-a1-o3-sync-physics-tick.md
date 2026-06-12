# S1 — A1-O3 sync physics tick (`?syncPhysicsTick`) — execution-grade spec

Date: 2026-06-12. W3+ deep-spec sweep, item S1 (the spec missing from
`~/from-vm/w3plus-specs-2026-06-11/`, per W2-RESULTS.md:8-9).
All repo paths relative to `/home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger`;
retail = `~/ac-headers/acclient.c` (cited `acclient.c:line`, verified by direct grep this
session unless marked "per A1 report").

**VERDICT up front:** A1-O3 should NOT be implemented as the Rust `tickPhysicsSync(dtMs)`
wasm export the A1 survey sketched (agents/A1-frame-orchestration.md:134-141). The recv
loop's `tokio::select!` parks holding `&mut session` inside the pending
`session.recv_message()` future (lib.rs:30669-30670), so a synchronous export can never
borrow the Session without first restructuring the session/transport recv machinery
(receive.rs:240-260 — `recv_ordered_packet` owns retransmit-deadline timer awaits, so
there is no clean "await-a-frame-without-borrowing-session, then process synchronously"
split). That is the M-H risk the survey itself flagged ("borrow patterns around the recv
loop's owned Session", A1 §5, line 166) and deferred to "Fable-class judgment". This spec
makes that judgment: the same retail ordering contract — **integrate physics BEFORE the
frame's pose reads and render, in the same frame** — is achievable with a **JS-side
microtask-flush boundary**, zero Rust changes, JS-live (no wasm rebuild, no manifest
bump), with graceful degradation to today's behavior if the scheduling assumption ever
fails. The true sync export is documented as the rejected alternative with a re-open
trigger.

---

## 1. Read-HEAD + landed-W2 facts this spec builds on

`git log --oneline` HEAD = **048573d0** ("holtburger: W2 wave results") — verified this
session. All W2 items are on master and are CURRENT STATE, not assumptions:

| landed fact | commit | load-bearing for this spec |
|---|---|---|
| A1-O1 `?unifiedTick=on` — canonical spine `tick_spine.rs` exists; wasm TickMovement arm dispatches `TickSpineHandle::tick_frame` vs bare `movement.tick` | 656c8ef1 | O3 reorders WHEN the arm runs, not WHAT it runs — both flag states of the arm ride along unchanged (lib.rs:39526-39546) |
| A1-O2 `?posePublishPostTick=on` — pose/can-jump/cell-snapshot publishes move AFTER the integrator tick (lib.rs:39296-39330 pre-tick site, post-tick site in the `Ok(())` branch ~39620-39645) | 54162642 | O3 is only useful WITH this flag: the camera must read a pose published post-integration for the same-frame contract to mean anything |
| A4-Q1 / A3-D2 — motion-table queue + MotionDone consumer run INSIDE `movement.tick` (system.rs:1154-1180, `USE_MOTION_TABLE_QUEUE`) | 3172c03e / 0c078aa9 | tick-internal; O3 moves the whole tick, no interaction |
| A8-M2 `?maintPrune=on` — spine reports despawn guids; arm translates to KIND_REMOVE (lib.rs:39546-39625) | b4e87213 | arm-internal; rides along |
| A2-P1, A7-R1/R2/R3/R6, A9-Stage1, A13-W1 | e871fca8, c4ccb4d1..a1ac8c53, 20a027d6, ac3f9891 | no interaction with frame ordering |
| `WASM_EXPORT_MANIFEST_VERSION = 3` (lib.rs:478); index.html EXPECTED stays 1 (index.html:1801) | 20a027d6 (v3 bump) | this spec adds NO wasm exports → **manifest stays 3** |

Gating per ROADMAP.md:90-92: "Stage 1 eye-test PASS (1070 currently down) gates: A1-O3
… It does NOT gate landing those stages flag-off." So: **land default-off now; the
flag-flip acceptance joins the batched 1070 eye-test list** (W2-RESULTS.md:48-50 Lane B).
RULINGS.md has no ruling that touches O3 (§3 MAX_QUANTUM 0.1 pin is A1-O5's deliverable,
not O3's).

## 2. Current-state map (post-W0/W1/W2): where the async physics tick lives

The browser physics tick is **asynchronous relative to the frame that requests it**:

1. **Enqueue (JS, 2D loop):** the 2D `drainEvents` rAF calls
   `handle.tickMovement()` — index.html:10770, the ONLY enqueue site in the tree
   (verified grep: no `tickMovement` caller in scene3d/*). The export
   (lib.rs:27647-27657) captures `now: web_time::Instant::now()` at enqueue time and
   `unbounded_send`s `SessionCommand::TickMovement { now }` (variant at lib.rs:17334).
2. **Process (Rust, microtask):** the recv loop — one giant `spawn_local`-driven
   `tokio::select!` racing `session.recv_message()` (lib.rs:30670) against
   `cmd_rx.next()` (lib.rs:36149) — wakes and runs the TickMovement arm
   (lib.rs:39094 → ~40100). The arm's ONLY awaits are the tick dispatch itself
   (lib.rs:39533, 39540 — verified by awk over the arm range): `?unifiedTick=on` →
   `tick_spine.tick_frame(now, w, &mut movement, &mut session)` (tick_spine.rs:200-239,
   = movement.tick → world.tick → simulation.tick, tick_spine.rs:61-89); flag off →
   bare `movement.tick`. Pose publish: pre-tick at lib.rs:39305-39329 (flag off) or
   post-tick in the `Ok` branch (flag on) — see §1 row 2.
3. **Render (JS, same rAF that enqueued… last frame's pose):** the 3D driver
   `tick(nowTs)` (scene3d/index.js:1458) computes dt (1463-1481), stamps `frameTime`
   (1489-1494), runs `tickPerFrame` (1495 → loop.js:1299) — which reads the pose
   shadows: `cameraSwitcher.tick` (loop.js:1533-1535, also dispatches WASD →
   `setMovementInput`, itself a SessionCommand, lib.rs:26248/39053) and
   `applyLocalPlayerPoseFromIntegrator` (loop.js:1581 → body 495-560) — then renders
   (index.js:1602-1731) and re-arms via `scheduleNext()` (1659/1682/1731; def 1438).

Because rAF callbacks complete before the microtask queue drains the wasm wake, the
integration for frame N's enqueue happens AFTER frame N rendered. Retail runs ONE
synchronous pass: `SmartBox::UseTime` (acclient.c:146256) drives
`CObjectMaint::UseTime` (146284) → `CPhysics::UseTime` (146285) → net dispatch LAST
(146296-146316), and `CPhysics::UseTime` fires `SmartBox::PlayerPhysicsUpdatedCallback`
immediately after the player's own `update_object` (acclient.c:311371-311378, verified)
— consumers read the pose the same frame it was integrated. Our stack therefore carries
a structural 2-3 frame input→visible-pose latency (A1 §3 row 3, index.html:10770 +
index.js:1495 + lib.rs:39094). `?unifiedTick` changed WHAT the tick runs (spine vs bare
movement.tick); it did NOT change WHEN — the async boundary is untouched by W0/W1/W2.

**Load-bearing enabling fact (the whole design rests on this, all verified):** every
await reachable from the TickMovement arm is **ready on first poll** on wasm. The arm's
awaits are only the tick calls (lib.rs:39533/39540); `movement.tick`
(system.rs:1119-1124) awaits only Session send-path methods; every send bottoms out in
`WsTransport::send_to` (crates/holtburger-transport-ws/src/transport.rs:271-284), which
is an `async fn` whose body is purely synchronous `ws.send_with_u8_array` — it never
yields. (`recv_from`, transport.rs:286-305, DOES pend, but the tick path never calls
recv.) Therefore: once the recv-loop task is polled, the entire TickMovement arm runs
to completion inside that single poll — i.e. inside one microtask.

## 3. Staged implementation plan

**Flag:** `?syncPhysicsTick=on`, default off, **parsed in JS only** (no Rust flag fn —
nothing Rust-side changes behavior). Effective only when `renderer=3d`. Canonical combo
documented as `?renderer=3d&unifiedTick=on&posePublishPostTick=on&syncPhysicsTick=on`;
the flag is mechanically independent (it reorders whichever tick path is active) but
without `posePublishPostTick=on` the camera still reads a stale pose, so the JS logs a
one-shot console warning when `syncPhysicsTick=on` is set without it.

**Mechanism (the async→sync boundary):** at the TOP of the 3D frame, JS enqueues the
tick itself and then yields exactly one microtask. Sequence inside one rAF callback:
`handle.tickMovement()` synchronously `unbounded_send`s → wakes the recv-loop task →
wasm-bindgen-futures schedules its task-queue flush as a microtask M1 → our
`await Promise.resolve()` queues the continuation as microtask M2, strictly after M1 →
callback stack empties → browser runs the microtask checkpoint: M1 polls the recv loop,
which runs the WHOLE TickMovement arm synchronously (§2 enabling fact) including the
post-tick pose publish; M2 then resumes our frame — `tickPerFrame` reads a same-frame,
post-integration pose, renders, re-arms. Paint happens after the checkpoint, so the
painted frame contains this frame's integration. Net result: retail's
integrate → publish → read → render contract (acclient.c:146285 before 146316;
311371-311378), per frame, with net recv staying async (retail applies net after
physics — same contract, A1 O3 scope line 135).

### Stage A — frame-top sync boundary in the 3D driver (JS-live)

File: `apps/holtburger-web/scene3d/index.js`.

1. Flag parse, next to the existing `netDrainHz`/`nullRender` IIFE parses
   (index.js:353-380 pattern):
   ```js
   const syncPhysicsTick = (() => {
     try {
       return new URLSearchParams(window.location.search)
         .get("syncPhysicsTick") === "on";
     } catch (_) { return false; }
   })();
   ```
   One-shot boot log (mirror the netDrainHz log at index.js:363) + the
   posePublishPostTick-missing warning (string match on `location.search`).
2. Make `tick(nowTs)` (index.js:1458) an `async function`. Insert phase #0 after the
   dt computation (after index.js:1481, before the `frameTime` stamp at 1489):
   ```js
   if (syncPhysicsTick && liveScene3dRef?.sessionHandle) {
     try {
       liveScene3dRef.sessionHandle.tickMovement();
       window.__syncTickLastEnqueueMs = performance.now();
       await Promise.resolve(); // recv-loop poll (microtask) runs before this resumes
     } catch (_) {}
     if (!running) return; // stop() may have raced the hop
   }
   ```
   Everything after (frameTime stamp, tickPerFrame, render, `scheduleNext()`) is
   UNCHANGED and now runs in the post-flush continuation. Re-entrancy is safe by
   construction: the loop only re-arms via `scheduleNext()` at the END of `tick`
   (index.js:1659/1682/1731), so no second rAF can start while the hop is pending.
   Flag off: `tick` contains no await on the executed path — an async function that
   never awaits completes synchronously through its first return; ordering is
   byte-identical to today (the only observable change is `tick`'s return type, see
   risk R3).
3. `?netDrainHz=N` interval handler (index.js:1768-1786): make the callback async and
   give it the identical phase #0 prefix before its `tickPerFrame` call (index.js:1777).
   This keeps the renderOnDemand/wire-agent path on the same contract AND keeps the
   watchdog stamp fresh while rAF idles.
4. `window.__renderOnce` (index.js:1743): no code change; it now invokes an async
   `tick` and returns `true` before the frame completes when the flag is on. Document
   in its comment: under `?syncPhysicsTick=on`, callers must allow a microtask before
   sampling (all existing capture scripts already sleep between calls).

### Stage B — 2D-loop enqueue gate with recency watchdog (JS-live, same batch)

File: `apps/holtburger-web/index.html`, the sole legacy enqueue (index.html:10770).
Replace:
```js
try { handle.tickMovement(); } catch (_) {}
```
with:
```js
// A1-O3 (?syncPhysicsTick): when the 3D driver owns the tick (phase #0
// enqueue at scene3d/index.js tick()), skip this legacy enqueue so the
// integrator runs once per frame. Recency watchdog: if the 3D driver
// stalls (hidden tab, renderOnDemand idle without netDrainHz), fall back
// to this path automatically — degraded mode IS the pre-O3 behavior.
const syncOwned = window.__syncTickOwned === true &&
  (performance.now() - (window.__syncTickLastEnqueueMs ?? -1e9)) < 250;
if (!syncOwned) { try { handle.tickMovement(); } catch (_) {} }
```
`window.__syncTickOwned` is set `true` by index.js at 3D-driver start iff
`syncPhysicsTick && renderer===3d` (renderer detection precedent:
index.html:2196/4467 `URLSearchParams.get("renderer") === "3d"`). Watchdog threshold
250 ms = >4 frames at 60 Hz, well under the 5 s keepalive cadence (lib.rs:30657-30667)
and the heartbeat scheduling MovementSystem throttles internally
(lib.rs:27640-27646 doc), so a transition gap never starves the server heartbeat.
Transient double-enqueue during handoff (both paths fire in one frame) is benign: two
TickMovement cmds in one flush = two ticks at split dt; retail's own per-object clock
skips quanta ≤ 0.0002 s (acclient.c:323120-323124, verified) and our spine measures dt
between calls (tick_spine.rs:207-211), so the second tick integrates ~0 time.

### Stage C — diag counters for headless acceptance (JS-live, same batch)

Gate behind `?syncTickDiag=1` (keeps the hot path free of extra wasm getter calls).
In phase #0 (both drivers), when diag on: snapshot
`sessionHandle.getLocalPlayerPose()` (export at lib.rs:25500) before the enqueue and
re-read after the hop; maintain
`window.__syncTickDiag = { enqueued, hopCompleted, poseChangedSameFrame, skipped2d }`
(`skipped2d` incremented at the Stage-B gate). `poseChangedSameFrame` increments when
the pre/post snapshots differ — under held movement input this MUST climb if and only
if the same-frame contract holds. This is the wire-agent's acceptance probe and the
canary for open question Q1 (if scheduling were ever non-deterministic,
`hopCompleted - poseChangedSameFrame` grows while moving).

### Stage D — docs (no code)

- `docs/url-flags.md`: add the `?syncPhysicsTick=on` row following the
  `?unifiedTick`/`?posePublishPostTick` precedent (url-flags.md:407/413), marked
  **JS-live on reload — NO wasm rebuild needed**; eye-test column = the batched Lane-B
  list entry (latency/feel A/B + chat/HUD regression), NOT a per-item step
  ([[feedback_passed_flag_integrate_always_on]] applies on PASS: gate removal +
  DONE mark).
- Manifest note: no new exports → `WASM_EXPORT_MANIFEST_VERSION` stays **3**
  (lib.rs:478); `index.html` EXPECTED stays **1** (index.html:1801). Do NOT bump.

**Wasm-rebuild vs JS-live per stage: A/B/C/D are ALL JS-live** (reload-testable the
moment they're committed; no buildbox batch dependency). This is the decisive advantage
over the rejected design below.

### Rejected alternative — true sync export `tickPhysicsSync(dtMs)` (do not build now)

The A1 sketch (A1 report lines 134-141). Blocked, with citations: state needed by the
spine lives as locals of the recv-loop future (`world`/`movement`/`tick_spine`:
lib.rs:30448-30453; `session` is the future's argument) and the `select!` parks holding
`&mut session` inside `session.recv_message()` (lib.rs:30669-30670) — under an
`Rc<RefCell<Session>>` hoist that park is a live borrow, so a JS-initiated sync
`borrow_mut` panics whenever the loop is parked (i.e. almost always). Splitting "await
frame" from "process frame" to drop the borrow across the park requires restructuring
`recv_ordered_packet`'s retransmit-deadline timer awaits
(crates/holtburger-session/src/session/receive.rs:240-262) and the
`FutMutex`-guarded frame channel inside `WsTransport` (transport.rs:286-292) — a
session/transport refactor an order of magnitude larger than O3's payoff, duplicating
none of the microtask design's benefits. **Re-open trigger:** Stage-C diag shows
sustained `poseChangedSameFrame` starvation on any supported browser (Q1 falsified),
or O4 (single frame driver) independently needs the recv-loop restructure — then spec
the hoist as its own W-item with the Session park as the headline risk.

## 4. Test plan

### Headless-now (implementer runs; laptop rules, no workspace builds)

1. **Syntax:** `node --check` on `scene3d/index.js` (repo TestGate precedent,
   W2-RESULTS.md:39-44). index.html's inline JS is not node-checkable — Stage-B diff
   must stay within the quoted block above.
2. **Cargo:** NO Rust files change. Nothing to build or test Rust-side; do not run a
   workspace battery ([[reference_oom_protection_stack]]). If review drifts any Rust,
   that's scope creep — reject it.
3. **Wire-agent (laptop, per [[reference_cloudflare_wire_agent_validation]]:
   Playwright chromium → 127.0.0.1:8765, `?nullRender=1` mandatory, read getters
   INSIDE page.evaluate):**
   - **ON-run:** navigate
     `?renderer=3d&nullRender=1&unifiedTick=on&posePublishPostTick=on&syncPhysicsTick=on&syncTickDiag=1`,
     autoLogin, then `page.evaluate` → `sessionHandle.setMovementInput(...)`
     (lib.rs:26248) hold-forward ~3 s, sample `window.__syncTickDiag`. PASS:
     `enqueued > 0`, `hopCompleted === enqueued` (±1 in-flight),
     `poseChangedSameFrame > 0.9 * hopCompleted` while moving, `skipped2d > 0`
     (proves the Stage-B gate engaged), pose advances (no movement regression),
     zero console errors.
   - **OFF-run (regression):** same script minus the two flags: movement identical to
     pre-change behavior; `window.__syncTickDiag === undefined`;
     index.html:10770 enqueue cadence unchanged (assert via a frame-count vs
     pose-update-count ratio identical to a pre-change baseline run).
   - **Watchdog run:** ON-flags + `?renderOnDemand=1` WITHOUT netDrainHz (3D rAF
     idles): assert `skipped2d` stops growing after ~250 ms and movement heartbeats
     continue (2D fallback re-engaged) — read `getLocalPlayerPose` advancing under
     held input.
4. **Trace cross-check (optional, stronger):** the client-prediction shadow
   (`set_last_client_prediction`/`get_last_client_prediction`, lib.rs:23469-23483)
   carries `tick_count` + `t_ms` per frame — assert from page.evaluate that under the
   ON-combo the prediction frame's `tick_count` advances between consecutive
   `__renderOnce()` calls in the same macrotask-step pattern (one tick per frame, not
   zero-then-two).

### 1070-gated (goes on the BATCHED pending eye-test list — not a per-item step)

Add ONE Lane-B entry alongside the existing 6-flag wasm-rebuild batch
(W2-RESULTS.md:48-50; note this item alone needs NO rebuild, so it can ride any 1070
session): with the canonical combo, (a) input→photon latency A/B vs flag-off — expect
~1 frame better, no jitter; (b) WASD walk/run/jump feel incl. jump arms-up overlay
timing (posePublishPostTick acceptance list, url-flags.md:413); (c) chat/HUD smoke —
the 2D loop still runs everything except the enqueue (Stage B touches only that one
line), so chat must be unaffected; (d) hidden-tab → return: movement resumes without
rubberband (watchdog handoff). Per ROADMAP.md:90 this acceptance ALSO requires the
unified-movement Stage-1 eye-test PASS to be meaningful (O3 reorders when interpreted
velocity is sampled relative to the rig — A1 report line 140); sequence the batch
accordingly.

## 5. Risks + rollback

- **R1 — scheduling assumption (Q1):** if wasm-bindgen-futures' wake were NOT a
  microtask ordered before our hop continuation, the tick lands next frame — which is
  EXACTLY today's behavior. Failure mode = no-op, detected by Stage-C diag. No crash
  surface.
- **R2 — double-tick during watchdog handoff:** benign (split-dt; retail-skip ≤0.2 ms
  quanta, acclient.c:323120-323124; spine dt measured per-call, tick_spine.rs:207-211).
  Heartbeat rate is internally throttled (lib.rs:27640-27646), not enqueue-rate-driven.
- **R3 — `tick` becomes async:** exceptions thrown after the hop become unhandled
  rejections instead of sync throws into the rAF dispatcher (observability change
  only — every risky callee inside `tick` is already try/catch-wrapped:
  index.js:1495/1604/1655 patterns); `__renderOnce` returns before frame completion
  under the flag (documented, Stage A.4). Flag off: no await executes; behavior
  byte-identical.
- **R4 — cell-recenter ordering divergence (accepted):** retail recenters the
  landscape from the PRE-update player position (`CellManager::ChangePosition`,
  acclient.c:146278, before `CPhysics::UseTime` 146285); under the ON-combo our
  cell-visibility read (loop.js:1322 region) sees the POST-update pose — a one-frame
  recenter lead, the conservative direction (cells load earlier). Note it in the
  url-flags row; no mitigation.
- **R5 — input latency is NOT fully retail yet (scope boundary):** `setMovementInput`
  cmds dispatched by frame N's camera tick (loop.js:1533-1535) flush in frame N's
  trailing microtasks and integrate at frame N+1's phase #0 → input→photon = 1 frame
  (down from 2-3). Same-frame input is A1-O4's contract (single driver:
  net-apply → physics → camera/input → …, A1 report lines 143-150) — do not chase it
  here.
- **R6 — interaction with RP3/frame budget:** untouched — phase #0 runs before
  `tickPerFrame` stamps the RP3 frame clock (loop.js:1299-1310), so the hop's cost
  (one microtask + the wasm tick that previously ran post-frame) is correctly charged
  to the frame budget.
- **Rollback:** flag off = default = no execution-path change (Stage A executes no
  await; Stage B's gate is false because `__syncTickOwned` is never set). Single-commit
  revert is also clean (3 files: scene3d/index.js, index.html, docs/url-flags.md).
  Commits must be hunk-selective ([[project_eyetest_session_2026-06-11]] — uncommitted
  login-50x + load-perf work may share these files; verify `git status` first).

## 6. OPEN QUESTIONS

- **Q1 (single-cited, third-party):** wasm-bindgen-futures schedules task polls on the
  microtask queue (Promise-based queue), so the wake from `unbounded_send` is drained
  before our `await Promise.resolve()` continuation. This is crate behavior, not
  citable to repo or acclient lines — treated as an assumption with a built-in canary
  (Stage-C diag) and a no-op failure mode (R1). Implementer may optionally verify once
  in `~/.cargo` sources (`wasm_bindgen_futures::task::singlethread`) — read-only.
- **Q2 (single-cited, third-party):** `tokio::select!` polls the ready `cmd_rx` arm to
  arm-completion within one poll given all arm awaits are ready-immediate (verified
  ready-immediacy: transport.rs:271-284, awk over lib.rs:39094-40100 → only
  39533/39540). The macro's randomized poll order may process a simultaneously-ready
  net frame first — same microtask, net-before-physics, which matches the O4 frame-top
  net contract (A1 report line 144); no action.
- **Q3:** does the 2D loop's sprite predictor block (index.html:10771+, immediately
  after the enqueue) do work under `renderer=3d` that is cadence-coupled to the
  enqueue we're gating? It mutates 2D `sprite.x/.y` only (index.html:10788-10790
  region) and Stage B removes ONLY the enqueue line — believed inert for 3D, but the
  3D-session 2D-canvas state is unaudited (A15 territory). Wire-agent OFF/ON chat +
  HUD smoke covers the observable surface.
- **Q4:** exact retail position of input processing relative to `SmartBox::UseTime`
  (is input→physics same-frame in retail?). Not located in acclient.c this session;
  A14's funnel survey (ACCmdInterp→MovePlayer, A14 §3 per ROADMAP.md:62-64) owns it.
  Affects only how much residual latency O4 should claim, not O3's design.
- **Q5:** under `?targetFps`/paced scheduling (index.js:1402-1415, `_frameIntervalMs`
  setTimeout path) the phase-#0 hop crosses a setTimeout-scheduled rAF rather than a
  bare one — no ordering difference expected (microtasks drain per-callback
  regardless of how the callback was scheduled), but the paced path is not covered by
  the wire-agent plan above; add a `?targetFps=30` variant to the ON-run if cheap.
