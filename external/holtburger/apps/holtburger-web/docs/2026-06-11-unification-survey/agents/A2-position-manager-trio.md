# A2 position-manager-trio — unification survey

Scope: retail `PositionManager` + its three sub-managers (`InterpolationManager`,
`StickyManager`, `ConstraintManager`) vs our position-correction sites. Seam: movement
DESIGN.md Stage 3 owns `MoveToManager`; A2 owns only the position trio. Seam flags for
A16 are called out inline and in §5.

## 1. Retail map

One `PositionManager` per `CPhysicsObj` (`acclient.h:30716`, struct at
`acclient.h:30952-30956` holding the three sub-manager pointers,
`acclient.h:31505/31518/31529`). All position correction funnels through exactly two
entry points on it:

**Per-frame call order**

1. `CPhysicsObj::update_object` tail (acclient.c:322860-322893): DetectionManager →
   TargetManager → `MovementManager::UseTime` → `CPartArray::HandleMovement` →
   **`PositionManager::UseTime`** (acclient.c:322884-322885) → ParticleManager →
   ScriptManager.
2. `PositionManager::UseTime` (acclient.c:388267-388284; BN pseudo-C 00555160) fires
   sub-managers in order: interpolation → constraint → sticky. (Both decompilers
   misattribute the constraint slot's call — acclient.c:388280 shows
   `gmNoticeHandler::RecvNotice_PrevSpellSelection`, BN shows an `IDClass` dtor; it is
   the constraint manager's per-frame routine slot. See §6.)
3. `CPhysicsObj::UpdatePositionInternal` (acclient.c:322894-322916, body at 320000-
   320034): builds the animation `offset_frame` from `CPartArray::Update`, then
   **`PositionManager::adjust_offset(offset, quantum)`** (acclient.c:320028-320030),
   then `Frame::combine` into the new frame (acclient.c:320031) →
   `UpdatePhysicsInternal`. So ALL three correctors mutate ONE offset frame that the
   physics step consumes — there is no second, render-side smoother.
4. `PositionManager::adjust_offset` (acclient.c:388287-388304) chains
   `InterpolationManager::adjust_offset` (389178) → `StickyManager::adjust_offset`
   (388519) → `ConstraintManager::adjust_offset` (389478), in that order, each
   rewriting the same `Frame *offset`.

**InterpolationManager** (acclient.c:389017-389380)

- `InterpolateTo` (389017-389130): blip gate via `GetAutonomyBlipDistance`
  (acclient.c:389035) — beyond it the node is queued as a blip-type with
  `node_fail_counter = 4`; within it, a ≤0.05 m gap snaps heading +
  `StopInterpolating` (389125-389129); otherwise queue a position node, dedupe tail
  nodes within 0.05 m (389052-389063), cap queue at 20 nodes (389071 `v17 < 0x14`).
- `adjust_offset` (389178-389276): requires `transient_state & 1` (contact, 389199);
  deadband <0.05 → `NodeCompleted(1)` (389218-389220); `my_max_speed =
  get_adjusted_max_speed() * 2.0` (389233, gated by static
  `fUseAdjustedSpeed_ = 1`, acclient.c:45657), floored to
  `MAX_INTERPOLATED_VELOCITY = 7.5` (acclient.c:41536, 389239-389240); 5-frame
  progress window with `progress/quantum/maxSpeed >= 0.3` keep-going test, with a
  sticky-object exemption (389243-389245 `get_sticky_object_id(...) || ...`); step
  capped at `maxSpeed * quantum` (389258-389262); `keep_heading` zeroes the heading
  component (389265-389266); stall under 0.2 m completes, otherwise
  `++node_fail_counter; NodeCompleted(0)` (389271-389273).
- `UseTime` (389278-389380): drains velocity-type (type 3 → `set_velocity`,
  389365-389368) and snap-type (type 2) head nodes; on `node_fail_counter > 3` it
  hard-recovers via `SetPositionSimple` to the last position node or the saved
  `blipto_position` (389300-389360).
- `NodeCompleted` (388882-388946): pops the head, re-seeds `original_distance` for
  the next position node, saves failed nodes into `blipto_position`.

**StickyManager** (acclient.c:388519-388690)

- `adjust_offset` (388519-388601): offset = vector to target position (live object
  position if resolvable, else the stashed `target_position`), z zeroed (388557);
  standoff = `cylinder_distance_no_z(my_radius, target_radius) - 0.3` (388562);
  speed = `CMotionInterp::get_max_speed() * 5.0`, floored to `15.0` (388576-388583);
  step capped at `speed * quantum`; ALSO sets the heading offset toward the target
  (`Position::heading` − current, 388594-388600).
- `UseTime` (388605-388620): 1-second timeout (`sticky_timeout_time = cur_time + 1.0`
  set in `StickTo`, 388688) → clear target + `cancel_moveto`.
- `StickTo` (388665-388690): registers interest via
  `CPhysicsObj::set_target(0, id, 0.5, 0.5)`; the target position arrives via
  `TargetManager` → `PositionManager::HandleUpdateTarget` (acclient.c:319980-319984)
  → `StickyManager::HandleUpdateTarget` (388699-388720, status==1 stashes the pose,
  else unstick). Entry: `CPhysicsObj::stick_to_object` (acclient.c:319750-319760).

**ConstraintManager** (acclient.c:389478-389527)

- `ConstrainTo` (389514-389527): stash pos/start/max, seed `constraint_pos_offset` to
  the current distance.
- `adjust_offset` (389478-389512): requires contact; scales the (already interp/sticky
  -written) offset by `(max - off)/(max - start)` between start and max, zeroes it
  past max, then re-evaluates `constraint_pos_offset += |applied offset|` (running
  leash accumulator — note retail ADDS the step length, 389506-389510).
- `IsFullyConstrained` = `offset > 0.9 * max` (acclient.c ~389460).

**Wire entry points** — `SmartBox::HandleReceivedPosition`
(acclient.c:145190-145228): LOCAL player teleport → `TeleportPlayer` + `ConstrainTo`
+ zero velocity (145199-145207); LOCAL non-teleport → `ConstrainTo` ALWAYS + (if
cmdinterp-autonomous and on contact) `InterpolateTo` (145210-145218). REMOTE object →
`CPhysicsObj::MoveOrTeleport` (acclient.c:323460-323498): newer-teleport/no-cell →
hard `SetPosition`; `player_distance >= 96` → `StopInterpolating` +
`SetPositionSimple` (323485-323489); near → `InterpolateTo` (323493-323495); on
MoveOrTeleport success the REMOTE object is then also `ConstrainTo`'d on its own
position (145223-145227).

## 2. Ours map

| # | site | side | file:line | role |
|---|------|------|-----------|------|
| 1 | `RetailForcePositionInterpolator` | Rust | `crates/holtburger-world/src/spatial/force_position_interp.rs:104-338` | faithful 1:1 port of Interpolation+Constraint `adjust_offset` for the LOCAL player force-position (deadband 0.05, maxSpeed floor 7.5, 5-frame/0.3 window, leash scaling) |
| 2 | install + per-frame step wiring | Rust | `crates/holtburger-world/src/spatial/scene.rs:2058-2102` (install, blip-gated), `scene.rs:2132-2160` (`step_force_position_interpolation`), driven from `crates/holtburger-core/src/client/movement/system.rs:2753` | flag `USE_RETAIL_INTERPOLATE: bool = true` (`scene.rs:65`); grounded-Z carve-out + airborne skip (`system.rs:2731-2766`) |
| 3 | legacy single-step pull | Rust | `crates/holtburger-world/src/spatial/scene.rs:127-160` `constrain_local_pose_toward` (gate `USE_LOCAL_FORCE_POSITION_CONSTRAINT`, scene.rs:31) | flag-off fallback, one capped pull per message |
| 4 | remote-entity pose ease + velocity extrapolation | JS | `apps/holtburger-web/scene3d/entities.js:3493-3602` (`EntityManager.setPose`), constants at `entities.js:184-196`; `?deadReckon` default-ON (`entities.js:69-80`) | critically-damped ease toward `_serverTargetPos` + `lastVel` extrapolation (500 ms staleness gate, entities.js:188) |
| 5 | remote heading ease | JS | `entities.js:211-213` (K=14, snap 2.5 rad), applied in tick; `?headingSnap=on` reverts | replaces retail's turn-omega sweep |
| 6 | sticky glue (F3-4) | JS | set from `apps/holtburger-web/scene3d/loop.js:1851-1856` and `loop.js:2124-2127`; glue in `entities.js:8789-8813` (fixed `ENTITY_STICKY_STANDOFF_M = 1.3`, entities.js:196); cleared at `entities.js:3499-3504` | remote-only (local player excluded, loop.js:1855) |
| 7 | local render-side smoothing | JS | `apps/holtburger-web/scene3d/camera.js:977-1005` (`predictedPlayerPos` 150 ms reconcile lerp, 5 m snap `PRED_SMOOTH_SNAP_DIST_M`, camera.js:178); `loop.js:531-577` rig-Z exponential ease (`RIG_Z_TAU_MS = 70`, snap 1.0 m) | render-only layer with no retail counterpart |

Count: retail funnels every correction through ONE `adjust_offset` pipeline; we apply
corrections at **7 distinct sites** (3 Rust, 4 JS), with the render-side ones living
outside physics entirely.

## 3. Divergences

| # | behavior | retail cite | our cite(s) | class | symptom | tracked? |
|---|----------|------------|-------------|-------|---------|----------|
| 1 | local-player force-position ease (InterpolateTo + ConstrainTo install, per-frame adjust_offset curve) | acclient.c:145210-145218, 389178-389276, 389478-389512 | force_position_interp.rs:104-338; scene.rs:2058-2102; system.rs:2753 | PARITY (faithful port, flag ON; deliberate deviations: grounded-Z carve-out + airborne skip, system.rs:2731-2766, documented vs retail's contact gate) | — | physics deep-dive gap-4; Stage-1-adjacent (eye-test pending) |
| 2 | remote-entity position interpolation: node queue, blip-distance gate, 96 m `SetPositionSimple` branch, 7.5 m/s floor, progress-fail → blipto recovery | acclient.c:323483-323495, 389017-389130, 389278-389380 | entities.js:3493-3602, 184-196 (damped ease + velocity extrapolation, no queue, no fail/recovery, no speed model) | DIFF-ALGO + SPLIT-BRAIN (Rust owns local, JS owns remote with different math) | remote entities converge on a different curve than retail; no far-object snap rule; stalls never hard-recover | F3-2 (remote driver, deliberately deferred per DESIGN.md:374-376) |
| 3 | sticky: standoff `cyl_dist_no_z(radii) − 0.3`, speed `max_speed*5` floor 15, heading turn toward target, 1 s timeout, TargetManager-fed target pose | acclient.c:388519-388601 (math), 388605-388620 (timeout), 388665-388720 (StickTo/HandleUpdateTarget) | entities.js:196 (fixed 1.3 m), 8789-8813 (damped glue, z = target z, no heading, no timeout); loop.js:1851-1856 (trigger heuristic off KIND_MOTION model_id) | DIFF-ALGO | mob standoff ignores cylinder radii (big mobs clip, small mobs float off); glued mob never times out if the clear signal is missed; no facing | F3-4 (shipped point fix; DESIGN.md:376 "must not regress") |
| 4 | constraint leash on REMOTE objects after MoveOrTeleport / during remote interp | acclient.c:145223-145227 (ConstrainTo on remote), 389478-389512 | no remote constraint exists — `grep -n constrain apps/holtburger-web/scene3d/entities.js` → 0 hits; force_position_interp constraint is local-only (scene.rs:2058) | MISSING | remote ease can be dragged arbitrarily far by extrapolation before the next packet snap | untracked |
| 5 | interpolation node QUEUE semantics: ≤20 nodes, tail dedupe, velocity-type (3) and snap-type (2) nodes drained in UseTime, `node_fail_counter > 3` → `SetPositionSimple(blipto_position)` recovery | acclient.c:389052-389071, 389278-389380, 388882-388946 | force_position_interp.rs:104-107 (single target, by design "force-position always queues exactly one"); no UseTime analog anywhere (grep `blipto\|node_fail` in crates/ → only this file's comments) | MISSING (deliberate subset) | a failed local interp just stops (`InterpStep::Failed` leaves pose, force_position_interp.rs:92-96) and waits for the next heartbeat instead of blip-recovering; velocity nodes unrepresented | untracked |
| 6 | one `adjust_offset` funnel; render = physics pose (offset combined into the frame the renderer draws) | acclient.c:320028-320034, 388287-388304 | 7 sites (§2 table): scene.rs:2058 + system.rs:2753 (Rust local), entities.js:3493/8789 + heading ease (JS remote), camera.js:977-1005 + loop.js:531-577 (JS render-side) | SPLIT-BRAIN (7 sites) | fixes to one corrector miss the others; the render-side smoothers exist to paper over reconcile oscillation the Rust side emits | partially: DESIGN.md:206-247 (run-rate divergence root cause), F3-2 |
| 7 | render-side prediction/smoothing layer (predictedPlayerPos lerp, rig-Z ease) | retail has none — UpdatePositionInternal's combined frame IS the drawn frame (acclient.c:320028-320034) | camera.js:178, 977-1005; loop.js:531-577 | EXTRA | masks integrator/server oscillation; double-smoothing can lag the physics pose (documented hill-lag workarounds, loop.js:498-540) | untracked as a defect; design rationale in loop.js:420-470 |

## 4. Staged unification plan

Goal shape: one `position_manager.rs` per spatial body — the trio as retail structures
it — with `adjust_offset(offset, quantum)` as the single mutation point, local AND
remote, and the JS correctors demoted to flag-off legacy.

**Stage P1 — generalize the interpolator into `PositionManager` (Rust, wasm-rebuild)**
- Scope: refactor `RetailForcePositionInterpolator` into
  `crates/holtburger-world/src/spatial/position_manager.rs` with retail's three
  sub-structs and the node QUEUE (≤20, type 1/2/3 nodes, dedupe, `blipto` recovery,
  `UseTime` drain — closes §3 row 5). Local player keeps current behavior
  byte-identically (single node installed at the same call site, scene.rs:2058).
- New module: `spatial/position_manager.rs`; `SpatialBody.force_position_interp`
  becomes `SpatialBody.position_manager`.
- Flag: Rust const `USE_POSITION_MANAGER_QUEUE` default-off (single-node path stays).
- Tests: headless-now — port force_position_interp.rs unit tests + new queue/UseTime
  matrix (velocity node, fail→blipto, 20-cap).
- Rollback: flag off → exact current single-node behavior.

**Stage P2 — remote-entity InterpolateTo in Rust (wasm-rebuild + JS-live consumer)**
- Scope: route remote KIND_POSITION through the same manager: implement the
  MoveOrTeleport branch rules (teleport-stamp → snap; ≥96 m → StopInterpolating +
  snap; near → InterpolateTo; then ConstrainTo — closes §3 rows 2 and 4). Surface the
  eased pose to JS per frame; `entities.js` `?deadReckon` ease becomes the flag-off
  path.
- Files: position_manager.rs, `crates/holtburger-world/src/spatial/scene.rs` (remote
  body upsert), `apps/holtburger-web/src/lib.rs` (per-frame remote pose export),
  `entities.js:3493` (consume vs legacy).
- Flag: `?remoteInterp=on` (url-flags.md style), default-off.
- Tests: headless-now — branch matrix vs acclient.c:323460-323498 constants;
  1070-gated — eye-test remote NPC smoothness vs deadReckon (must not regress F3-2's
  deferred status: this IS the retail remote driver, built from cites not speculation).
- Rollback: flag off → JS deadReckon path untouched.

**Stage P3 — StickyManager parity (wasm-rebuild)**
- Scope: retail sticky math into the manager — radii-aware standoff
  (`cyl_dist_no_z − 0.3`), `max_speed*5` floor 15, heading offset toward target, 1 s
  timeout, clear-on-update rules (closes §3 row 3). JS F3-4 glue
  (entities.js:8789-8813) becomes flag-off legacy. Trigger stays the KIND_MOTION
  model_id channel until A4/A13 give a cleaner wire signal.
- Flag: `?stickyRetail=on`, default-off.
- Tests: headless-now — standoff/timeout unit tests; 1070-gated — sticky melee
  eye-test (F3-4 regression gate, DESIGN.md:376).
- Seam: DESIGN.md Stage 3 (MoveToManager) provides the target-update plumbing retail
  gets from TargetManager — serialize P3 after Stage 3 lands, flag for A16.
- Rollback: flag off → F3-4 JS glue.

**Stage P4 — render-side smoother retirement experiment (JS-live, optional)**
- Scope: with P1-P3 ON and Stage 1 eye-tested, trial `?predLerp=off` /
  `?rigZEase=off` to render the physics pose directly (retail shape, §3 row 7). Only
  proceed if the manager-side easing has killed the 5-10 Hz reconcile oscillation
  these layers exist to hide (camera.js:440-455 rationale).
- Flags: two new default-ON-legacy flags; pure JS, instant rollback.
- Tests: 1070-gated only (this is an eye-test by definition).

## 5. Scores

- Leverage: subsumes **F3-4** (P3 replaces the point fix with cited math), unblocks
  **F3-2** (P2 is the cited remote driver DESIGN.md deferred), retires the
  remote heading-ease K=14 approximation (P2/P3 carry retail's heading offsets);
  obsoletes `constrain_local_pose_toward` and `USE_LOCAL_FORCE_POSITION_CONSTRAINT`
  legacy once P1 passes.
- Regression-risk reduction: **H** — collapses 7 correction sites toward 1 funnel;
  this trio is exactly where rubberband/yank regressions have recurred (gap-4 history
  in scene.rs:30-95 comments).
- Implementation risk: **M** — P1 is a refactor of tested code; P2 touches the
  lib.rs bridge + entities.js consumer (conflict files for A16's matrix); P3 depends
  on a Stage 3 seam; P4 is trivial but eye-only.
- 1070-dependency: **Y** for P2/P3/P4 acceptance; P1 is headless-verifiable.
- Depends-on: Stage 1 eye-test PASS (the local interpolator rides the Stage-1
  integrator pose, system.rs:2753); A3/DESIGN Stage 3 (MoveToManager target plumbing
  for P3); A1 (frame-ordering — our step runs inside the manual-drive integrator, not
  at retail's UseTime/UpdatePositionInternal slots; if A1 re-orders the tick, the
  step call site moves); A13 (cleaner sticky wire signal than the model_id ride-along).

## 6. SPECULATIVE / UNRESOLVED

- **Constraint per-frame UseTime slot**: both decompilers garble the call inside
  `PositionManager::UseTime` (acclient.c:388279-388280 shows
  `gmNoticeHandler::RecvNotice_PrevSpellSelection`; BN 00555173-00555175 shows an
  `IDClass` dtor). It is some per-frame constraint routine; identity unconfirmed
  (`ConstraintManager` has no declared `UseTime` in the PDB dump, acclient.c:8271-8277
  list). Low stakes — our port runs constraint logic inside `adjust_offset` only,
  matching the declared API.
- **Local-player sticky**: retail's `stick_to_object` (acclient.c:319750-319760) is
  not player-excluded, and `InterpolationManager::adjust_offset` has a sticky
  exemption in its progress test (acclient.c:389243), implying local sticky existed
  (melee lock). Ours excludes the local player (loop.js:1855). Whether ACE expects
  client-side local sticky is uncited on the ACE side — single-cited, kept out of §3.
- **5 Hz UpdatePosition cadence lead**: asserted in our comments
  (loop.js:440-441 "5-10 Hz") and DESIGN.md:395, but I found no acclient/ACE line
  for the broadcast rate during this survey. Unverified lead.
- **FU-3 lead**: roster mentioned it; it is combat action-FIFO work owned by
  DESIGN.md Stage 3 (DESIGN.md:355,366-369), not the position trio. Out of A2 scope.
- **Backlog file availability**: `~/out/bughunt86-combat-render-loop-items-2026-06-09.md`
  and `~/out/grind-loop-2026-06-11.md` do not exist on this machine (`ls ~/out` —
  only older bughunt files present). Dedupe for F3-2/F3-3/F3-4/FU-3 IDs relied on
  their references inside the movement DESIGN.md (DESIGN.md:355-376). Rows 4, 5, 7
  are reported untracked on that weaker basis.
- **`fUseAdjustedSpeed_` static**: set to 1 at acclient.c:45657; I did not find a
  code path flipping it at runtime. Our port hardcodes the adjusted-speed branch
  (force_position_interp.rs docs, lines 30-32) — consistent, but the toggle's
  purpose is unresolved.
