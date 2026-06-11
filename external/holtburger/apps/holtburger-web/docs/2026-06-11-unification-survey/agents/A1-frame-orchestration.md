# A1 frame-orchestration — unification survey

Date: 2026-06-11. Read-only survey per PROMPT.md §2. All `acclient.c` paths are
`~/ac-headers/acclient.c`; repo paths are relative to
`/home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger`.

## 1. Retail map

Retail runs ONE frame spine. Every call below is cited to the decompiled body.

### 1.1 SmartBox::UseTime — the per-frame top (acclient.c:146256)

Order within one frame (acclient.c:146256–146330):

1. `CellManager::CheckPrefetchStatus` / `UpdateLoadPoint` (146268–146275) — cell streaming gate; while `blocking_for_cells` NOTHING else runs.
2. `CellManager::ChangePosition(player pos)` (146278) — landscape recenter from the player's CURRENT (pre-update) position.
3. `CObjectMaint::UseTime` (146284) — visible-object maintenance / destruction timers.
4. `CPhysics::UseTime` (146285) — the whole physics+managers pass (§1.2).
5. `GameTime::UseTime` + `LScape::UseTime` (146287–146289).
6. `Ambient::UseTime` (146291).
7. `SceneTool::Think` (~146293).
8. **Net dispatch LAST**: drain `in_queue`, `DispatchSmartBoxEvent` per NetBlob (146296–146316). Network events are applied AFTER physics, so a server message never mutates state mid-physics-pass; its effects integrate on the NEXT frame.

### 1.2 CPhysics::UseTime (acclient.c:311335)

1. Global quantum gate: `quantum = cur_time - last_update`; if `quantum < MIN_QUANTUM` do nothing (311350–311352). `MIN_QUANTUM = 1/30 s` (acclient_2013.bndb_pseudo_c.txt:717927) — the entire physics world advances at most 30 Hz regardless of render rate.
2. Iterate ALL physics objects, `CPhysicsObj::update_object` each (311371–311374).
3. **Immediately after the player's own update**, fire `SmartBox::PlayerPhysicsUpdatedCallback` (311375–311378) — consumers (camera, cell recenter) see the player pose the SAME frame it was integrated, post-integration.
4. `animate_static_object` for the static-animating list (311381–311386).
5. `CPhysics::UpdateTexVelocity(quantum)` (~311389) — animated-texture clock.

### 1.3 CPhysicsObj::update_object — per-object clock (acclient.c:323081)

- Skip (and clear TS-active bit 0x80) if parented / no cell / state&0x1000000 (323099–323101).
- Player-distance activity gate: distance > 96.0 and maint active → deactivate, else `set_active` (323106–323118). (Ours mirrors the 96 m constant — `ACTIVE_SOLVE_RADIUS_M`, crates/holtburger-core/src/client/simulation.rs:17.)
- **Per-object update_time clock**: `v6 = cur_time - update_time` (323120). If `v6 <= 0.0002` → skip, stamp clock (323124, 323163). If `v6 > 2.0` → drop the hitch entirely, stamp clock (323126, 323156–323159). Else substep: repeat `UpdateObjectInternal(MAX_QUANTUM)` slices then one remainder slice `> MIN_QUANTUM_97` (323127–323146). `MAX_QUANTUM = 1/5 = 0.2 s` (acclient_2013.bndb_pseudo_c.txt:717935).

### 1.4 CPhysicsObj::UpdateObjectInternal — the manager chain (acclient.c:322719)

Per substep, in this exact order (active objects):

1. ethereal re-check + `jumped_this_frame = 0` (322761–322764).
2. `UpdatePositionInternal(quantum, &new_frame)` (322776) — see §1.5.
3. If the object has collision spheres: `transition(old_pos, new_pos)` (322813), `cached_velocity = achieved_delta / quantum` (322817–322830), `SetPositionInternal` (322831); on transition failure: hold position, zero velocity (322835–322847).
4. `DetectionManager::CheckDetection` (322873).
5. `TargetManager::HandleTargetting` (322876).
6. `MovementManager::UseTime` (322879) → only `MoveToManager::UseTime` (339359–339365).
7. `CPartArray::HandleMovement` (322882) → `MotionTableManager::UseTime` (325106–325112) — animation-queue completion runs AFTER movement, BEFORE position managers.
8. `PositionManager::UseTime` (322885) → InterpolationManager → ConstraintManager → StickyManager UseTime chain (388267–388284).
9. **Always, even for inactive objects**: `ParticleManager::UpdateParticles` (322889) and `ScriptManager::UpdateScripts` (322892).

### 1.5 CPhysicsObj::UpdatePositionInternal (acclient.c:319989)

1. `CPartArray::Update(quantum, &offset_frame)` (320013) → `CSequence::update` (325140–325143) — animation root-motion offset is computed FIRST.
2. Offset scaled by `m_scale` only when on-walkable (transient_state & 2), else XY/Z zeroed (320015–320027).
3. `PositionManager::adjust_offset` (320030) — interp/sticky/constraint corrections fold into the SAME candidate frame (388288–388304: interp → sticky → constraint), BEFORE collision.
4. `Frame::combine` → candidate frame (320031).
5. `UpdatePhysicsInternal(quantum, o_newFrame)` (320034) — velocity/accel integration on the combined frame.
6. `CPhysicsObj::process_hooks` (320035) — anim hooks fire at the end of every substep.

Key retail contract: **animation offset → position-manager corrections → physics integration → ONE transition/collision pass → managers → hooks**, per object, per substep, all inside one frame, with the player-visible callback fired post-integration.

## 2. Ours map

Two completely different tick spines exist, plus three JS frame drivers.

### 2.1 Native/cli spine (NOT what the browser runs)

`ClientRuntime::run` (crates/holtburger-core/src/client/runtime.rs:92–204):
- 30 ms tokio interval (`PHYSICS_TICK_MS = 30`, crates/holtburger-core/src/client/mod.rs:40) — ≈ retail's 1/30 s MIN_QUANTUM gate.
- Per tick (runtime.rs:171–199): `movement.tick` → `world.tick()` (eviction sweep + visibility-prune deadlines, crates/holtburger-world/src/state/liveness.rs:378–385 — the CObjectMaint::UseTime analog) → `simulation.tick` (ClientSimulationSystem).
- `simulation.tick` (crates/holtburger-core/src/client/simulation.rs:67–120) reimplements the retail quantum loop: drop > `HUGE_QUANTUM` (2.0 s), slice at `MAX_QUANTUM` (0.1 s — deliberately the ACE `PhysicsGlobals.MaxQuantum` value, not retail's 0.2 s; documented at simulation.rs:78–93), solve local + tracked bodies within `ACTIVE_SOLVE_RADIUS_M = 96.0` (simulation.rs:17, 135–139 — matches acclient.c:323113).
- Net messages handled in a separate `tokio::select!` arm (runtime.rs:135–161) — ordering vs the physics tick is select-race, not retail's "net after physics".

### 2.2 Wasm spine (what the browser runs)

The wasm path "skips ClientRuntime entirely" (apps/holtburger-web/src/lib.rs:15919–15931). Frame flow:

1. 2D `drainEvents` rAF loop (apps/holtburger-web/index.html:8974, re-armed 10974–10976) polls events and calls `handle.tickMovement()` (index.html:10644) → enqueues `SessionCommand::TickMovement`.
2. The recv-loop arm (lib.rs:38526) processes it: collision/setup drains (lib.rs:38560–38725) → `publish_cell_scene_snapshot` (38726) → **`publish_local_player_pose` (38739)** → `publish_local_player_can_jump` (38747) → scene shadows → **`movement.tick` (38921)** → airborne-transition synthetic events (38923–39095).
3. NO `world.tick()` and NO `simulation.tick` anywhere on the wasm path (no match for either in lib.rs).

`MovementSystem::tick` (crates/holtburger-core/src/client/movement/system.rs:1004+) is the only Rust per-frame integrator in the browser: drive intents → manual-drive integrator → heartbeats.

### 2.3 JS frame drivers (three of them)

| driver | site | does |
|---|---|---|
| 2D `drainEvents` rAF | index.html:8974/10974 | net event application, chat, `tickMovement()` enqueue (10644), forwards entity events to the 3D hook |
| 3D `tick` rAF | scene3d/index.js:1458–1505 | dt clamp (0.1 cap + DT_RECOVERY freeze frames, 1464–1480), `tickPerFrame` (1495), moons, audio listener, render (sky pass + world, 1606+) |
| `?netDrainHz=N` setInterval | scene3d/index.js:1758–1781 | calls `tickPerFrame` while rAF idles (renderOnDemand) |

`tickPerFrame` order (scene3d/loop.js:1279–1602): cell visibility (1301) → frustum cull (1313) → PVS expansion (1323–1325, ~10 Hz throttle) → terrain clocks (1331, 1355) → lighting (1370) → shadow gate (1388) → sky stack #7–#12 (1407–1506, throttled as a unit) → **camera tick = WASD → `setMovementInput` dispatch** (1513–1515; scene3d/camera.js:1490) → portal space (1528) → animated surfaces (1538) → **`entityManager.tick(dt)`** = mixer advance + remote ease (1544; scene3d/entities.js:8603) → `drainEntityEvents3D` + motion-action/axes drains (1545–1552) → **`applyLocalPlayerPoseFromIntegrator`** (1561; body at loop.js:475–560: X/Y from the JS camera predictor, Z from the wasm pose shadow) → nameplates (1589–1593).

The RP3 frame-budget machinery (loop.js:1280–1298) exists precisely because multiple drivers can call `tickPerFrame` against frozen rAF clocks.

## 3. Divergences

| # | behavior | retail cite | our cite(s) | class | symptom | tracked? |
|---|----------|-------------|-------------|-------|---------|----------|
| 1 | One frame spine vs two: native runs movement→world.tick→simulation.tick; wasm runs ONLY movement.tick (no eviction sweep, no quantum-sliced solver, no remote-body solve) | SmartBox::UseTime acclient.c:146256–146316 (single spine) | runtime.rs:171–199 vs lib.rs:38526–38921 (no `world.tick`/`simulation.tick` match in lib.rs) | SPLIT-BRAIN (2 spines) | cli-verified physics behaviors silently absent in the browser; destruction timers never sweep in-browser | no |
| 2 | Player pose published to render BEFORE integration; retail fires PlayerPhysicsUpdatedCallback immediately AFTER the player's update_object | acclient.c:311375–311378 | lib.rs:38739 (`publish_local_player_pose`) precedes lib.rs:38921 (`movement.tick`); sole call site | DIFF-ALGO (ordering) | camera/rig read a pose ≥1 tick stale — a structural late-by-one-frame source | no |
| 3 | Physics runs AFTER render each frame: rAF callbacks (incl. render) complete, then the spawn_local recv loop processes TickMovement as a microtask; retail integrates physics before the frame's draw inside the same UseTime pass | acclient.c:146285 (physics) before 146316 (event dispatch), one synchronous pass | index.html:10644 (async enqueue) + scene3d/index.js:1495→1606+ (tickPerFrame then render in same callback); lib.rs:38526 (processed post-rAF) | DIFF-ALGO (ordering) | input→visible-pose latency stacks to 2–3 frames (enqueue frame N, integrate post-N, publish top of arm N+1, render N+2) vs retail's same-frame | no |
| 4 | Three concurrent JS frame drivers vs one retail main loop; relative order is rAF-registration accident | acclient.c:146256 (single UseTime entry) | index.html:8974/10974 (2D rAF) + scene3d/index.js:1458 (3D rAF) + index.js:1758–1781 (netDrainHz interval) | SPLIT-BRAIN (3 sites) | starvation/ordering hazards; RP3 guard (loop.js:1287–1298) is a workaround for this, not a feature | no |
| 5 | Local player render pose composed from 3 owners (JS predictor X/Y + wasm integrator Z + server reconcile) vs one CPhysicsObj position | acclient.c:322776–322831 (one position, one transition) | loop.js:475–560 (X/Y `predictedPlayerPos`, Z `getLocalPlayerPose`); camera.js:953–954 (predictor) | SPLIT-BRAIN (3 sites) | reconcile flash, uphill rig-below-terrain class of bugs; the loop.js:496–510 comment documents the patch-over | B1 partially (USE_RETAIL_INTERPOLATE; "grounded one-tick input-drop" known LOW) — seam with A2 |
| 6 | No per-object update clock in browser: retail substeps each object on its own update_time (skip ≤0.0002, drop >2.0, slice at 0.2 s); wasm integrates only the local player, remote entities eased in JS at display dt | acclient.c:323120–323159; MAX_QUANTUM=0.2 (bndb_pseudo_c.txt:717935) | entities.js:8603 (remote ease at rAF dt); simulation.rs:94–107 (retail-shaped slicing exists but native-only); MAX_QUANTUM=0.1 ACE-pinned (movement/common.rs:559, simulation.rs:89–93) | DIFF-ALGO | remote-entity motion fidelity tied to display Hz; hitch semantics differ between native and browser builds | no (0.1-vs-0.2 is a documented ACE pin, §2.6 precedent) |
| 7 | Manager sub-order contract absent: retail's fixed Detection→Target→Movement→MotionTable→PositionManager chain and anim-offset→corrections→integrate→hooks pipeline has no equivalent single owner; ours is spread over JS phases | acclient.c:322873–322892; 320013–320035 | loop.js:1513 (camera/input) → 1544 (mixer) → 1545 (net-derived motion application) → 1561 (pose); completion decided in JS mixer callbacks | MISSING (the ordering contract) | anim-vs-position one-frame skew; hook-timing skew (A4/A5 own the internals; A1 owns the ordering frame) | no |
| 8 | No global 30 Hz physics gate in browser: retail gates the whole pass at MIN_QUANTUM=1/30 | acclient.c:311352; bndb_pseudo_c.txt:717927 | index.html:10644 ticks at rAF rate (~60 Hz); native PHYSICS_TICK_MS=30 (mod.rs:40) is parity | DIFF-ALGO (wasm only) | frame-rate-dependent tick counts; heartbeat scheduling slots double at 60 Hz vs 144 Hz monitors quadruple | no |
| 9 | Net application split across two JS sites both feeding `dispatchOne` (shared 2D-loop hook + tickPerFrame drain); retail applies net once, after physics | acclient.c:146296–146316 | loop.js:1997 (`dispatchOne`) called from drain (loop.js:2242/2248) AND shared hook (loop.js:2320/2323, installSharedDrainHook 1983); index.html drainEvents forwards | SPLIT-BRAIN (2 sites) | event-application timing depends on which driver saw it first; double-consumption guards needed (loop.js:9–16) | overlaps A15's seam — flagged, not re-planned here |
| 10 | JS-side dt clamp regime (0.1 cap + DT_RECOVERY freeze frames) stacked on top of Rust quantum handling | acclient.c:323124–323159 (per-object clock is the only clamp) | scene3d/index.js:1464–1480 | EXTRA | post-tab-switch behavior: retail drops the hitch; ours freezes sim for N frames then resumes — defensible, but it's a second, independent clamp law | no |

## 4. Staged unification plan

Goal: one tick spine, retail's ordering contract (integrate → publish → read → render in one frame), one frame driver. Stages are independent flags; each is rollback-by-flag-off.

### Stage O1 — shared Rust tick spine (wasm runs what native runs)
- Scope: extract `client/tick_spine.rs` with `fn tick_frame(now, dt, world, movement, simulation) -> Vec<WorldEvent>` = movement.tick → world.tick → simulation.tick, exactly the runtime.rs:171–199 order. Native `run()` delegates; the wasm TickMovement arm calls it instead of bare `movement.tick`.
- Files: new `crates/holtburger-core/src/client/tick_spine.rs`; runtime.rs; lib.rs:38526 arm.
- Flag: `?unifiedTick=on` (default off) — off keeps the wasm arm calling movement.tick only, byte-identical.
- JS-live or wasm-rebuild: **wasm-rebuild**.
- Tests: headless-now (core/world unit tests already cover simulation.tick + world.tick; add a spine-order test asserting movement→world→simulation event interleave). 1070-gated: none required for the spine itself, but remote-body solve becoming live in-browser wants an eye-test.
- Rollback: flag off.
- Note: this is the prerequisite that makes divergences #1 and #6 (browser half) collapse together — the quantum-sliced solver and eviction sweep start existing in the browser.

### Stage O2 — publish-after-integrate (retail callback order)
- Scope: move `publish_local_player_pose` / `publish_local_player_can_jump` / `publish_cell_scene_snapshot` to AFTER `movement.tick` in the TickMovement arm, mirroring acclient.c:311375 (callback fires post-update). One-line moves; the drains stay pre-tick (they feed the integrator, correctly).
- Files: lib.rs:38726–38747 → after lib.rs:38921.
- Flag: `?posePublishPostTick=on` (default off).
- wasm-rebuild.
- Tests: headless-now — a wasm-bindgen-free unit test can't see this; instead assert via the existing pose-shadow diag (lib.rs:23023–23054 prediction page) that shadow age < one tick. 1070-gated: feel check (should remove one frame of input latency).
- Rollback: flag off.
- Cheapest single win in this report.

### Stage O3 — synchronous physics tick (integrate before render, same frame)
- Scope: export a synchronous wasm entry `tickPhysicsSync(dtMs)` that runs the Stage-O1 spine inline (no SessionCommand round-trip), called from `tickPerFrame` BEFORE `cameraSwitcher.tick`'s pose reads (i.e. new phase #0). The channel path stays as fallback. Net recv stays async (retail's "net after physics" is approximated by the drains-at-top-of-spine pattern).
- Files: lib.rs (new export + arm refactor so both paths share one fn); scene3d/loop.js (new phase #0); index.html:10644 (skip enqueue when sync path active).
- Flag: `?syncPhysicsTick=on` (default off).
- wasm-rebuild + JS.
- Tests: headless-now — node-side ordering assertion impossible; use the lib.rs:29739 per-TickMovement trace to verify integrate-timestamp < render-timestamp per frame. 1070-gated: the actual latency/feel verdict.
- Depends: Stage O1; **Stage 1 eye-test PASS** (it reorders when interpreted velocity is sampled relative to the rig).
- Rollback: flag off (channel path untouched).

### Stage O4 — single frame driver
- Scope: when `renderer=3d`, the scene3d rAF becomes the only driver: it calls the net-drain hook + tickMovement/tickPhysicsSync itself; the 2D drainEvents loop's rAF self-cancels behind the flag (it already forwards entity events via the shared hook — loop.js:1983). Establishes the per-frame contract: net-apply → physics (sync) → camera/input → anim → pose → render, matching SmartBox::UseTime's shape with net moved to frame-top (retail dispatches at frame-bottom, equivalent modulo one frame; pick frame-top so a server force-position lands before that frame's physics, as retail's next-frame pass would).
- Files: scene3d/index.js (driver), index.html (drainEvents gate), scene3d/loop.js.
- Flag: `?singleDriver=on` (default off).
- JS-live.
- Tests: headless-now (existing RP3 starvation guard semantics must hold; netDrainHz path must still work). 1070-gated: regression sweep of chat/HUD (the 2D loop owns chat today).
- Depends: A15's verdict on quarantining the 2D path — **seam: do not execute O4 until A15's plan is reconciled**.
- Rollback: flag off.

### Stage O5 — quantum-law parity sweep
- Scope: per-object update clocks for tracked remote bodies in the solver (retail acclient.c:323120) instead of one shared dt; decide and document MAX_QUANTUM 0.1 (ACE) vs 0.2 (retail) once, in one place (today it's stated in three comments: simulation.rs:89–93, common.rs:552–568, index.js dt cap); optionally add the MIN_QUANTUM 1/30 gate to the sync tick so browser physics is 30 Hz like native/retail.
- Files: simulation.rs, movement/common.rs, scene3d/index.js:1464–1480.
- Flag: `?physics30hz=on` for the gate (default off); clock change rides `?unifiedTick`.
- wasm-rebuild.
- Tests: headless-now (slicing unit tests exist at simulation.rs:388+; extend for per-body clocks).
- Depends: O1.

Ordering: O2 (trivial, immediate) → O1 → O5 → O3 → O4. O2 and O1 are independent and can land in one wasm-rebuild batch.

## 5. Scores

- **Leverage**: subsumes the structural cause behind the "late-by-one-frame" artifact class; directly retires the residual B1 LOW ("grounded one-tick input-drop during reconcile") via O2+O3; O1 unblocks browser-side remote-body solve (currently native-only dead code in the browser). Backlog IDs subsumed: B1 (residual), plus the RP3-starvation bug class (workaround becomes unnecessary under O4, though RP3 stays as belt-and-braces).
- **Regression-risk reduction**: **H** — two tick spines is the definitional split-brain; every movement/physics fix currently must be reasoned about twice (and historically only the wasm path is eye-tested).
- **Implementation risk**: O2 **L**; O1 **M** (wasm world.tick/simulation.tick going live could change browser behavior — that's the point, hence flag); O3 **M-H** (async→sync boundary, borrow patterns around the recv loop's owned Session); O4 **M** (2D-path entanglement, chat/HUD ownership); O5 **L-M**.
- **1070-dependency**: O1/O2/O5 headless-verifiable (traces + unit tests); O3/O4 final verdicts are **1070-gated** (latency/feel, chat regression).
- **Depends-on**: Stage 1 eye-test PASS (O3); A15 dual-renderer verdict (O4); A2's position-trio plan shares row 5 (the three-owner local pose) — A1 proposes the frame-ordering fix, A2 owns the correction-pipeline unification; A4/A5 own the internals of row 7's anim chain ordering.

## 6. SPECULATIVE / UNRESOLVED

- **2D-loop vs 3D-loop rAF execution order**: I claim registration order (drainEvents registered at boot, scene3d tick at renderer init) puts drainEvents first per frame; this is per-spec browser behavior for rAF callback queues but I did not trace it live (no-builds rule). Affects only the precision of row 3's "2–3 frames" figure (could be exactly 2).
- **`UpdatePhysicsInternal` internals** (gravity/friction application order inside acclient.c:320034's callee) — not read; A6/A7 territory. My §1.5 ordering claims stop at the call boundary.
- **Whether any in-browser consumer needs `world.tick`'s visibility-prune deadlines today** (liveness.rs:382–383): the browser may compensate via JS-side entity removal on kind=2 events; I did not trace the JS removal path's completeness. If JS fully compensates, O1's world.tick arm is additive-safe; if both run post-O1, double-eviction needs a guard. Grep tried: `sweep_eviction_queue|maintain_visibility_prune` in lib.rs (no hits — confirms it never runs in wasm; the open half is the JS compensation audit, A8's scope).
- **`SceneTool::Think` / `GameTime::UseTime` analogs**: ours has `tickAnimatedSurfaces` (loop.js:1538) and the atmosphere clock (atmosphere_sky.js per index.js:1488 comment) but I did not 1:1 map retail's UpdateTexVelocity (acclient.c:~311389) to tickAnimatedSurfaces — single-cited on the retail side only.
- **`?renderOnDemand` + `netDrainHz` interaction with O4**: the netDrainHz interval exists to keep wasm drained while rendering is paused (index.js:1758–1760). Under O4 it must drive the full contract minus render; not yet designed.
