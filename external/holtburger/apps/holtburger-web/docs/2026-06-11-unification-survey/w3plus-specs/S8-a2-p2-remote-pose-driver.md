# S8 / A2-P2 — remote-pose driver (the F3-2 re-home): remote `InterpolateTo`/`ConstrainTo`
# in Rust + per-frame remote pose export from lib.rs + JS consumer re-home

Execution-grade spec, W3+ deep-spec sweep 2026-06-11. ROADMAP wave **W4** item
(gate: Stage-1 eye-test PASS + W2), wasm-rebuild **Batch R4** family for the export
half (ROADMAP §5), `lib.rs` conflict-matrix row: queue behind the W1 batch (landed)
and behind A9-Stage1's lib.rs touch (in-flight W2).

---

## 1. read-HEAD + W2 assumptions

**Read at HEAD `61bea82f`** ("holtburger: W2/Batch-R2 buildbox dispatch manifest").
Landed and verified in-tree at read time: A1-O1 `?unifiedTick` + `tick_spine.rs`
(656c8ef1), A1-O2 `?posePublishPostTick` (54162642), A13-W1 `?wireStatePacks=stage1`
(ac3f9891), A8-M1 `?worldLifecycle` (174fa1b4), A8-M2 `?maintPrune` (b4e87213),
A3-D1 DESIGN amendment (a916d12e).

**W2 items this spec ASSUMES have landed (in-flight RIGHT NOW, dispatched by
`61bea82f` / W2-PROMPT.md item 3 but NOT in the tree I read):**

- **A2-P1 (HARD dependency).** The interpolation-node queue generalization of
  `crates/holtburger-world/src/spatial/force_position_interp.rs` per A2 §4 P1:
  module `spatial/position_manager.rs`, field rename
  `SpatialBody.force_position_interp` → `SpatialBody.position_manager`, node queue
  (≤20 nodes, tail dedupe, type 1/2/3 nodes, `node_fail_counter>3` → blipto
  recovery, `UseTime` drain), Rust const `USE_POSITION_MANAGER_QUEUE` default-off.
  **Every symbol name below written as `position_manager.*` must be re-anchored to
  what P1 actually landed** (W2-PROMPT.md warns agents may skip; if P1 was SKIPPED,
  this spec is BLOCKED on re-running P1 first — the single-target
  `RetailForcePositionInterpolator` (force_position_interp.rs:104-131) cannot hold
  retail's remote node stream, which needs the queue + blipto recovery
  (acclient.c:389278-389380)).
- **A9-Stage1** touches lib.rs (placement-id plumb, possible manifest bump). This
  spec's manifest bump must be sequenced AFTER it; if A9-Stage1 bumped
  `WASM_EXPORT_MANIFEST_VERSION` (lib.rs:445, `= 2` at read time) to 3, ours goes
  to 4.
- A4-Q1 / A3-D2 / A7-R1/R2/R3/R6: assumed landed; no file overlap with this spec
  except `movement/system.rs` is NOT touched here (A2/A3 seam: ROADMAP §2 — P2 is
  "after the #1 batch", which is landed; P3/sticky strictly later, NOT in scope).

Line numbers for our files below are at `61bea82f` and will drift as W2 lands —
re-grep symbols, don't trust offsets.

---

## 2. Current-state map (post-W0/W1)

### 2.1 Retail truth (the behavior being ported)

Remote-object position correction is ONE pipeline:

1. **Wire entry** — `SmartBox::UnpackPositionEvent` (acclient.c:145253-145298)
   decodes `PositionPack` and calls `SmartBox::HandleReceivedPosition`
   (acclient.c:145125) with `pp.has_contact` (acclient.c:145287) and
   `pp.velocity`. A stale `position_timestamp` is dropped via
   `newer_event(object, 0, position_timestamp)` (acclient.c:145167-145182).
2. **Remote branch** — for a non-player object:
   `CPhysicsObj::MoveOrTeleport(object, &pos, teleport_timestamp, has_contact,
   velocity)` (call acclient.c:145223; body acclient.c:323451-323498):
   - 16-bit wraparound compare: incoming `teleport_timestamp` OLDER than
     `update_times[4]` → return 0, drop (acclient.c:323461-323467).
   - teleport-stamp NEWER (`newer_event(TELEPORT_TS)`) **or no cell** → hard
     `SetPosition` with flags 0x1012, return 1 (acclient.c:323469-323478).
   - `!contact` → return 0, working pose untouched (acclient.c:323480-323481).
   - `player_distance >= 96.0` → `PositionManager::StopInterpolating` +
     `SetPositionSimple(p)`, return 1 (acclient.c:323483-323489).
     (`player_distance` is the per-frame cached distance to the local player,
     refreshed in the physics pass, acclient.c:323107-323114.)
   - else (near, contact) → `InterpolateTo(p, IsMovingTo())`, return 1
     (acclient.c:323492-323495) — `keep_heading` = "object is running a MoveTo".
   - On ANY return-1, the caller then leashes:
     `ConstrainTo(object, &object->m_position, GetStartConstraintDistance,
     GetMaxConstraintDistance)` — note: constrained to the object's **own
     post-move position**, not the received pose (acclient.c:145223-145227).
3. **Constants** — `GetAutonomyBlipDistance` non-player: indoor (cellid&0xFFFF ≥
   0x100) 20.0 m, outdoor 100.0 m (acclient.c:315861-315880; player 25/100).
   `GetStartConstraintDistance`: 5.0 indoor / 10.0 outdoor, same for player and
   non-player (acclient.c:315885-315905). `GetMaxConstraintDistance`: 20.0 indoor /
   50.0 outdoor, same for both (acclient.c:315909-315929).
4. **`InterpolateTo` queue semantics** (acclient.c:389017-389173): gap measured
   from queue tail (or current pos) (acclient.c:389047-389054); within blip
   distance (acclient.c:389055) and > 0.05 m (acclient.c:389057) → pop tail nodes
   within 0.05 m of the new target (dedupe, acclient.c:389059-389070), cap queue
   < 0x14 = 20 by dropping the HEAD (acclient.c:389071-389097), set
   `keep_heading`, append a type-1 position node (heading overwritten with current
   heading when keep_heading, acclient.c:389098-389124). Within 0.05 m → snap
   heading (if !keep_heading) + `StopInterpolating` (acclient.c:389128-389137).
   BEYOND blip → still queue the node but set `node_fail_counter = 4`
   (acclient.c:389141-389171), which forces next `UseTime`'s hard recovery.
5. **Per-frame slots** — `CPhysicsObj::update_object` tail runs
   `PositionManager::UseTime` after MovementManager/PartArray
   (acclient.c:322884-322886); `PositionManager::UseTime` fans out
   interpolation → constraint-slot → sticky (acclient.c:388266-388284).
   `CPhysicsObj::UpdatePositionInternal` runs
   `PositionManager::adjust_offset(offset, quantum)` then `Frame::combine`
   (acclient.c:320029-320032); `PositionManager::adjust_offset` chains
   interpolation → sticky → constraint on ONE offset frame
   (acclient.c:388287-388305).
6. **`InterpolationManager::adjust_offset`** (acclient.c:389177-389274): requires
   `transient_state & 1` (contact, acclient.c:389208); skips type-2/3 head nodes
   (acclient.c:389211-389212); deadband <0.05 → `NodeCompleted(1)`
   (acclient.c:389216-389221); `my_max_speed = get_adjusted_max_speed()*2.0`
   (gated `fUseAdjustedSpeed_ = 1`, acclient.c:45657, 389227-389237), floored to
   `MAX_INTERPOLATED_VELOCITY = 7.5` (acclient.c:41536, 389239-389240); 5-frame
   progress window with `progress/quantum/maxSpeed >= 0.3` keep-going test and a
   **sticky-object exemption** (acclient.c:389243-389248); step capped at
   `maxSpeed*quantum` (acclient.c:389258-389264); keep_heading zeroes the heading
   component (acclient.c:389266-389267); stall <0.2 m completes, else
   `++node_fail_counter; NodeCompleted(0)` (acclient.c:389270-389273).
7. **`InterpolationManager::UseTime`** (acclient.c:389278-389380): drains type-3
   head nodes → `set_velocity` + `NodeCompleted(1)` (acclient.c:389370-389375)
   and type-2 head nodes → `NodeCompleted(1)` (acclient.c:389376-389379);
   `node_fail_counter > 3` → `SetPositionSimple` to the last queued position node
   or to `blipto_position` (acclient.c:389300-389368).
   `NodeCompleted` (acclient.c:388882-388946) pops the head, re-seeds
   `original_distance` for the next position node, and stashes failed nodes into
   `blipto_position`.

### 2.2 Ours (at `61bea82f`)

**Rust, local-only (parity for the LOCAL player, flag ON):**
`RetailForcePositionInterpolator` — faithful single-node port of
interp+constraint `adjust_offset` (force_position_interp.rs:104-338, constants
:61-78). Installed only for the local player on a force-position inside the blip
radius (`reconcile_authoritative_body` local branch, scene.rs:2034-2105,
`USE_RETAIL_INTERPOLATE: bool = true` scene.rs:65; leash constants scene.rs:91-111
= retail's 5/10 + 20/50). Per-frame step: `step_force_position_interpolation`
(scene.rs:2132-2160) driven from the movement integrator. **No remote body ever
gets a manager** — A2 §3 row 2 (DIFF-ALGO/SPLIT-BRAIN) and row 4 (MISSING remote
constraint, `grep -n constrain entities.js` → 0 hits) stand.

**Rust, remote ingest:** `WorldState::apply_entity_position_pack`
(mutations.rs:498-541) does sequence-gated acceptance + velocity, then
`emit_entity_position_sync` (mutations.rs:308-360) →
`reconcile_authoritative_body` (mutations.rs:49-74) →
`scene.reconcile_authoritative_body` (scene.rs:2015): for a
`SpatialBodyId::Entity` body this is an unconditional **hard snap**
(`body.pose = pose; mode = AuthoritativeOnly/Suspended`, scene.rs:2104-2107) —
no MoveOrTeleport lattice, no 96 m rule, no interpolation, no leash. The wire
contact bit exists as `UpdatePositionFlag::IS_GROUNDED = 0x04`
(holtburger-protocol .../movement/messages/position.rs:110) but is only used to
zero velocity (mutations.rs:525-530); it is retail's `pp.has_contact`
(acclient.c:145287).

**Wasm routing:** under `?wireStatePacks=stage1`, remote-guid `UpdatePosition`
routes to `handlers/movement.rs:33-39` → `apply_entity_position_pack`
(lib.rs:22088-22098). `PublicUpdatePosition` is deliberately NOT routed
(lib.rs:22084-22087) — its world handler exists (handlers/movement.rs:45-47 →
`apply_public_position_update`, mutations.rs:797) but never runs on wasm. The
recv arms additionally hand-mirror every remote position to JS as a
KIND_POSITION EntityUpdate (UpdatePosition arm lib.rs:32420-32458;
PublicUpdatePosition arm lib.rs:32597-32641), drained by
`SessionHandle::poll_entity_updates` (lib.rs:23902-23904).

**Wasm tick:** `?unifiedTick=on` runs the canonical spine
(`tick_spine.rs:61-89`: movement.tick → world.tick → simulation.tick;
lib.rs:39410-39422), so the quantum-sliced solver
(`ClientSimulationSystem::tick`, simulation.rs:69-123, MAX_QUANTUM slicing ↔
acclient.c:323120-323159) executes in-browser for the first time. Remote bodies
with a simulatable projection basis are solver-tracked
(`sync_remote_body_tracking`, tick_spine.rs:95-109).

**JS, the layer being demoted (the legacy/flag-off path):**
- `EntityManager.setPose` (entities.js:3605-3715): remote + `?deadReckon`
  (default-ON, entities.js:69-80, `this._deadReckonOn` entities.js:2155) stashes
  `_serverTargetPos` (snap when jump > `DEAD_RECKON_TELEPORT_SNAP_SQ`,
  entities.js:3706-3711); heading goes through the K=14 ease stash
  (entities.js:3626-3667, constants :211-213). Sticky-clear on any KIND_POSITION
  (entities.js:3610-3616).
- `EntityManager.tick`: velocity extrapolation of `_serverTargetPos` by
  `lastVel*dt` under the 500 ms staleness gate (entities.js:9206-9231,
  `ENTITY_VELOCITY_STALE_MS` :188; `setVelocity` :6533-6544) + critically-damped
  position ease; `_ballistic` projectile self-integration (entities.js:9152-9165);
  F3-4 sticky glue owns position when `_stickyTarget` set (entities.js:9179-9201).
- `loop.js` KIND_POSITION drain (loop.js:1786-1813): LB-local → world
  (`lbX*192 + x`, loop.js:1790-1794), local-guid skip (loop.js:1802), remote →
  `em.setPose`.

**F3-2 status being re-homed:** DESIGN.md:539-541 — "F3-2 stays deliberately
deferred MED — this stage must not silently 'fix' it with a speculative remote
driver". A2 §5: "P2 IS the deferred remote driver"; this spec is the cited,
non-speculative driver.

---

## 3. Staged implementation plan

Flag: **`?remoteInterp=on`** (default-off). Effective ONLY when
`?unifiedTick=on` AND `?wireStatePacks=stage1` are also on (the manager step
rides the spine's simulation phase, and the ingest rides the routed remote
UpdatePosition arm); lib.rs logs one warning and treats it as off otherwise.
Classification: **wasm-rebuild** (Rust ingest + step + export) with a paired
**JS-live** consumer; ONE manifest bump (see 3.4).

### Stage P2.a — remote MoveOrTeleport lattice in holtburger-world (wasm-rebuild)

Files: `crates/holtburger-world/src/spatial/scene.rs`,
`crates/holtburger-world/src/spatial/position_manager.rs` (P1's module),
`crates/holtburger-world/src/state/mutations.rs`,
`crates/holtburger-world/src/handlers/movement.rs`.

1. **Runtime switch:** `SpatialScene.remote_interp_enabled: bool` (default
   `false`), setter `WorldState::set_remote_interp_enabled(bool)`. lib.rs sets it
   once at WorldState creation from the parsed flag. Native runtime: leave off
   (no native flag this stage; native already runs the solver — enabling there is
   a one-line follow-on after the wasm eye-test).
2. **Thread contact + teleport-advance into reconcile:** extend
   `apply_entity_position_pack` (mutations.rs:498) to pass
   `pos_pack.flags.contains(UpdatePositionFlag::IS_GROUNDED)` (retail
   `pp.has_contact`, acclient.c:145287/position.rs:110) and the
   `EntityPositionSyncOutcome` (Reset = teleport/force-seq advanced — the
   existing acceptance gate already mirrors `newer_event` semantics) through
   `emit_entity_position_sync` → `reconcile_authoritative_body`
   (mutations.rs:49-74) → `scene.reconcile_authoritative_body` (scene.rs:2015).
   Plumb as a new arg struct `RemoteCorrectionCtx { contact: Option<bool>,
   teleport_advanced: bool, player_pose: Option<WorldPosition> }` (player pose
   read from `self.local_player_runtime_pose()` at the mutations.rs call site —
   the at-ingest analog of retail's per-frame `player_distance` cache,
   acclient.c:323107-323114; see OPEN Q3).
3. **The lattice** — in `scene.reconcile_authoritative_body`, new branch for
   `SpatialBodyId::Entity(_)` when `remote_interp_enabled` (the
   `else { body.pose = pose; ... }` arm at scene.rs:2104-2107 is the flag-off
   path, byte-identical):
   - `teleport_advanced || body has no cell-resolved pose` → snap (current
     behavior) + `body.position_manager.stop()`
     (acclient.c:323469-323478; ours scene.rs:2104).
   - `contact == Some(false)` → leave `body.pose` untouched (still update
     `authoritative_pose`, velocity, omega — entity bookkeeping already updated
     upstream) (acclient.c:323480-323481; ours mutations.rs:511-520 keeps
     entity.position).
   - `player_dist >= 96.0` (3D distance body.pose↔player pose; `None` player →
     treat as ≥ 96, i.e. snap) → `position_manager.stop()` + snap
     (acclient.c:323483-323489).
   - else → `position_manager.interpolate_to(body.pose, pose, keep_heading
     = false /* see OPEN Q4 */, blip = remote_blip(pose))` where
     `remote_blip` = 20.0 indoor / 100.0 outdoor (acclient.c:315872-315878 —
     NOT the player 25/100 already in scene.rs:91); beyond-blip queues the node
     with `node_fail_counter = 4` per P1's port (acclient.c:389141-389171);
     then `position_manager.constrain_to(current = body.pose, start, max)` with
     start 5/10 indoor/outdoor, max 20/50 (acclient.c:315885-315929 — identical
     to the player constants already at scene.rs:93-111; reuse them) anchored on
     the object's OWN pose per acclient.c:145223-145227.
   - `sampling.mode` stays `AuthoritativeOnly` in all arms (the manager mutates
     `body.pose` directly, like the local path; the solver's
     projection-basis law, tick_spine.rs:95-109, is untouched).
4. **Route `PublicUpdatePosition` on wasm under the flag:** add to
   `should_route_message_to_world` (lib.rs:22088-22098) a third gate clause
   `remote_interp_on && matches!(message, GameMessage::PublicUpdatePosition(_))`
   — handler already exists (handlers/movement.rs:45-47 →
   `apply_public_position_update`, mutations.rs:797). PrivateUpdatePosition stays
   un-routed (local-player only, no remote driver concern). Extend the existing
   routed/un-routed unit tests at lib.rs:22199-22290.

### Stage P2.b — per-frame manager step in the spine (wasm-rebuild, shared native)

File: `crates/holtburger-core/src/client/simulation.rs` (+ scene.rs helper).

- New `SpatialScene::step_remote_position_managers(&mut self, quantum: f32)`:
  iterate bodies where `matches!(id, SpatialBodyId::Entity(_))` and the manager
  is active; per body run the P1 `use_time()` (type-2/3 drain + fail-recovery,
  acclient.c:389278-389380) then `step(body.pose, quantum, max_speed = 0.0
  /* floors to 7.5, acclient.c:389239-389240; see OPEN Q5 */, on_contact =
  body-last-wire-contact, see OPEN Q6)` and write the stepped pose into
  `body.pose` — exactly the shape of `step_force_position_interpolation`
  (scene.rs:2132-2160).
- Call site: inside `ClientSimulationSystem::tick`'s per-slice loop
  (simulation.rs:113-121), after `apply_solve_batch`, once per MAX_QUANTUM slice
  with `quantum = slice` — the faithful slot: retail runs
  `PositionManager::UseTime`/`adjust_offset` inside the per-object physics pass
  (acclient.c:322884-322886, 320029-320032), which is the pass simulation.rs
  ports (simulation.rs doc, acclient.c:323120-323154). Gated on
  `world.scene.remote_interp_enabled` → flag-off = zero work, byte-identical.
  On wasm this runs ONLY under `?unifiedTick=on` (simulation.tick exists only on
  the spine path, lib.rs:39410-39422) — hence the flag prerequisite.

### Stage P2.c — the lib.rs remote pose export (wasm-rebuild, Batch-R4 family)

File: `apps/holtburger-web/src/lib.rs`.

1. `parse_remote_interp_flag(query) -> bool` — same shape as
   `parse_wire_state_packs_flag` (lib.rs:145-165), matches `remoteInterp=on`.
2. Shadow + getter, mirroring the `local_player_pose` idiom
   (publish fn lib.rs:30156, shadow Rc lib.rs:28376, getter lib.rs:25401-25403):
   - `remote_poses: Rc<RefCell<Vec<RemotePoseRow>>>` where
     `RemotePoseRow { guid: u32, landblock_id: u32, x,y,z,qw,qx,qy,qz: f32 }`.
   - `publish_remote_pose_shadow(w, &remote_poses)`: clear + refill from every
     `SpatialBodyId::Entity` body whose position manager is active this frame
     (`is_interpolating() || completed-this-frame`), reading `body.pose`.
     Sparse by design: idle bodies are NOT exported (JS legacy path keeps
     owning them — velocity extrapolation, ballistic, sticky; see §5 risk 2).
   - Call it in the TickMovement arm AFTER the tick dispatch (after
     lib.rs:39423's `Ok(())` arm), i.e. post-`simulation.tick`, same slot family
     as the A1-O2 post-tick publishes (lib.rs:39177-39186) — the export must see
     THIS frame's stepped pose (retail publishes pose after update_object,
     acclient.c:311375-311378 per A1-O2's cite).
   - `SessionHandle` export, three parallel-array getters on a small
     `#[wasm_bindgen]` struct (precedent: the typed-array getters at
     lib.rs:598-629):
     `#[wasm_bindgen(js_name = pollRemotePoses)] pub fn poll_remote_poses(&self)
     -> RemotePoseFrame` with `guids() -> Vec<u32>`, `landblocks() -> Vec<u32>`,
     `poses() -> Vec<f32>` (stride 7: x,y,z,qw,qx,qy,qz). Guids MUST ride u32
     arrays — f32 mantissa cannot hold a full 32-bit guid.
3. **Manifest bump (load-bearing export):** bump `WASM_EXPORT_MANIFEST_VERSION`
   (lib.rs:445, `2` at read time — coordinate with A9-Stage1, §1) and the JS
   consumer constant at index.html:1801 TOGETHER (F18-2 rule, W2-PROMPT.md rule
   3). JS additionally soft-guards (`typeof session.pollRemotePoses ===
   "function"`) so a stale pkg degrades to legacy (precedent: the
   `entityProjectileHasGravity` soft-guard note, entities.js:555-557).
4. Pass the flag into world creation (`set_remote_interp_enabled`) and into
   `should_route_message_to_world` (P2.a.4). Effective-flag rule: if
   `remoteInterp=on` but `unifiedTick` or `wireStatePacks=stage1` is off →
   `console_log_str` one warning, force off.

### Stage P2.d — JS consumer re-home (JS-live, same commit as the manifest bump)

Files: `apps/holtburger-web/scene3d/loop.js`,
`apps/holtburger-web/scene3d/entities.js`,
`apps/holtburger-web/docs/url-flags.md`, `index.html` (manifest constant only).

1. `entities.js`: constructor reads `?remoteInterp=on` → `this._remoteInterpOn`
   (pattern: `this._deadReckonOn`, entities.js:2149-2155).
2. New `EntityManager.applyManagedPose(guid, x, y, z, qw, qx, qy, qz)`:
   - no-op when local guid (defense; loop.js also skips), when
     `inst._ballistic` (F3-1/G-4 ownership, entities.js:9152-9165), or when
     `inst._stickyTarget` (F3-4 glue owns position until A2-P3,
     entities.js:9179-9201 — retail's sticky ALSO runs inside this manager,
     acclient.c:388300, but sticky is explicitly P3/W5 scope, ROADMAP §2 A2/A3
     seam).
   - else: `inst._wasmDriven = true`; write `inst.root.position.set(x,y,z)`
     directly (no JS ease — the smoothing already happened Rust-side,
     acclient.c:389258-389264 ↔ position_manager step); re-anchor
     `inst._serverTargetPos` to (x,y,z) so the legacy ease has nothing to drag
     if it ever resumes; rotation: route through the SAME heading stash
     `setPose` uses (entities.js:3633-3650) — heading easing stays JS-owned this
     stage (see OPEN Q4).
3. `EntityManager.tick`: skip the dead-reckon ease + velocity extrapolation
   block (entities.js:9206-9231) when `inst._wasmDriven` (one added conjunct).
   Clear `_wasmDriven` when no managed pose arrived for N=30 frames (manager
   went idle → legacy extrapolation resumes seamlessly from the re-anchored
   target).
4. `EntityManager.setPose`: when `this._remoteInterpOn && inst._wasmDriven`,
   keep the sticky-clear (entities.js:3610-3616) and the heading stash, but skip
   the POSITION write/stash (the same wire packet already fed the Rust manager
   via the routed arm; writing here would double-apply the un-eased target).
5. `loop.js`: in the per-rAF tick (near the local-pose apply,
   loop.js:609-614), when flag on and the session export exists: drain
   `session.pollRemotePoses()`, convert per row `wx = ((lb>>>24)&0xff)*192 + x`,
   `wy = ((lb>>>16)&0xff)*192 + y` (the exact KIND_POSITION drain math,
   loop.js:1790-1794), call `em.applyManagedPose(...)` for non-local guids.
   The KIND_POSITION drain itself is UNCHANGED (it still fires for spawn-pose
   bookkeeping, `__lastEntityWorldPos`, and non-managed entities; position
   double-apply is prevented inside setPose per (4)).
6. `docs/url-flags.md`: new row for `?remoteInterp=on` (composite-flag
   requirement, eye-test column = "remote NPC glide vs ?deadReckon", off =
   byte-identical).

### Explicitly OUT of scope (seam discipline)

- Sticky math / StickyManager (A2-P3, W5; RULINGS.md §4 local-player sticky
  ruling lands there).
- MoveTo/turn intents (A14-I2/A3-D3), the `IsMovingTo` keep_heading wire-up
  (OPEN Q4).
- Render-side smoother retirement (`predLerp`/`rigZEase`, A2-P4, 1070-only).
- Velocity-type (type-3) node PRODUCERS (P1 ships the node kinds; no retail
  producer identified yet — OPEN Q7).
- Native-runtime default-on (after wasm eye-test).

---

## 4. Test plan

**Headless-now (Lane A, buildbox):**

1. `position_manager.rs`/`scene.rs` unit lanes — MoveOrTeleport lattice matrix
   (each row dual-cited in the test comment):
   - teleport-advanced → snap + manager cleared (acclient.c:323469-323478);
   - `contact=false` → working pose unchanged, authoritative_pose updated
     (acclient.c:323480-323481);
   - player at 95.9 m → interpolate; at 96.0 m → stop+snap
     (acclient.c:323483-323489); no player pose → snap;
   - near+contact → node queued, constraint anchored on OWN pose with
     start/max 10/50 outdoor, 5/20 indoor (acclient.c:145223-145227,
     315885-315929);
   - remote blip gate 20 indoor / 100 outdoor → beyond-blip node carries
     `node_fail_counter = 4` (acclient.c:315872-315878, 389141-389171).
2. Step-site test: `ClientSimulationSystem::tick` with a 0.25 s dt → manager
   stepped once per MAX_QUANTUM slice (3 slices), flag-off → zero manager calls
   (simulation.rs:104-121 slicing).
3. Convergence test (port of force_position_interp.rs:472-502 shape) on a
   remote body: monotonic approach, completes in deadband, manager idle after.
4. lib.rs `#[cfg(test)]`: routing test — `PublicUpdatePosition` routes ONLY with
   remote_interp on (extend lib.rs:22199-22290 suite); flag-parse tests
   (`?remoteInterp=on`, `&remoteInterp=on`, reject `=stage1`); export packing
   test: two managed bodies → guids/landblocks/poses arrays length 2/2/14 and
   u32 guid round-trip exact at 0xFFFFFFFF.
5. JS: `node --check` on entities.js/loop.js; node harness unit for
   `applyManagedPose` skip rules (`_ballistic`, `_stickyTarget`, local guid) and
   for the `_wasmDriven` ease-skip — the Node-harness "no local player" property
   (entities.js:3717-3724) keeps these constructible headless.
6. Flag-off byte-identity: full existing suites green with the flag absent
   (every change is behind `remote_interp_enabled` / `_remoteInterpOn` /
   `_wasmDriven`, all default-false).

**1070-gated (Lane B, parked):**

- THE acceptance: remote NPC/creature motion eye-test `?unifiedTick=on&
  wireStatePacks=stage1&remoteInterp=on` vs plain `?deadReckon` — chase, patrol,
  stop-start; no rubberband, no stall-freeze (the blipto recovery should
  hard-correct where the legacy path waited for the next packet, A2 §3 row 5).
- F3-4 regression gate: sticky melee mob still glues + releases
  (DESIGN.md "F3-4 must not regress", :542-543).
- F3-1/G-4: arrow/bolt flight unchanged (ballistic skip).
- Teleport ring test (A13-W1's parked test) re-run with the flag on — remote
  teleports must snap, not glide.
- Far-spawn: entity entering at >96 m snaps (no cross-map glide).

---

## 5. Risks + rollback

1. **Double-driving (highest):** three position owners exist during migration
   (Rust manager, JS ease, KIND_POSITION snap). Mitigated structurally:
   `_wasmDriven` gates the JS ease off per-entity, setPose skips the position
   write for managed entities, the export re-anchors `_serverTargetPos`.
   Residual: a packet that reaches JS (recv-arm mirror) but is REJECTED Rust-side
   (sequence gate, mutations.rs:509-517) — setPose's skip is unconditional on
   `_wasmDriven`, so the rejected packet correctly drives nothing (retail also
   drops it, acclient.c:145167-145182). Covered by lattice test 1.
2. **Sparse export starves a mover between packets:** managed rows exist only
   while interpolating; a moving entity's between-packet motion still comes from
   the JS velocity extrapolation, which `_wasmDriven` disables. Mitigation: the
   30-frame `_wasmDriven` decay (P2.d.3) hands ownership back fast; the manager
   re-takes on the next packet. If eye-test shows seam-stutter, the W5 follow-on
   is exporting solver-integrated poses for ALL tracked remote bodies (the
   bodies already simulate velocity under the spine) — out of scope here.
3. **Perf:** per-frame Vec rebuild + wasm-bindgen copy for ~tens of managed
   bodies; rows only exist while corrections are in flight. Same cost family as
   the per-tick scene clone we already pay (lib.rs:39211-39228 comment).
4. **lib.rs conflict file:** hottest file in the matrix (ROADMAP §3). This spec's
   lib.rs touches are additive (flag parse, one route clause, shadow+getter,
   one publish call) — rebase-trivial, but MUST land after A9-Stage1 and
   coordinate the manifest number.
5. **A2-P1 shape drift:** if P1 landed the queue under different symbols or kept
   the module name, re-anchor mechanically; if P1 was skipped → BLOCKED.
6. **Rollback:** flag off = byte-identical everywhere (default-false runtime
   switch Rust-side; JS paths keyed on `_remoteInterpOn`/`_wasmDriven` which are
   never set). Full rollback = revert one commit; manifest bump makes a stale
   pkg/JS mismatch loudly visible (F18-2) and the JS soft-guard degrades to
   legacy dead-reckon.

---

## 6. OPEN QUESTIONS

1. **Constraint per-frame `UseTime` slot** (carried from A2 §6): both
   decompilers garble the constraint call inside `PositionManager::UseTime`
   (acclient.c:388279-388280 shows `gmNoticeHandler::RecvNotice_PrevSpell
   Selection`). Our port runs constraint only inside `adjust_offset`
   (acclient.c:388303), matching the declared API. Low stakes; unresolved.
2. **`AutonomousPosition` for remote players:** `apply_entity_autonomous_position`
   (mutations.rs:543-568) also snaps remote bodies via the same reconcile path.
   Retail routes 0xF753 through a different unpack (no `has_contact` decode
   found for it this read). Should remote-player autonomous frames feed
   `InterpolateTo` too? Recommend YES with `contact = Some(true)` assumed, but
   I cannot dual-cite the retail autonomous-frame contact handling — decide at
   implementation with a fresh read of the 0xF753 unpack (near
   acclient.c:146049's `HandleReceivedPosition(..., 1, ...)` constant-contact
   call site, which may BE that path).
3. **`player_distance` cadence:** retail uses a per-frame cached distance
   (acclient.c:323107-323114); we evaluate at ingest. Equivalent for the ≥96 m
   decision at packet time, but retail's cache also drives `set_active`
   deactivation — not modeled here (A8 territory).
4. **`keep_heading = IsMovingTo()`** (acclient.c:323492-323494): our remote
   entities run no client-side MoveTo yet (A3-D3/A14-I2 land it), so this spec
   hardcodes `keep_heading = false` and leaves heading rendering to the JS
   K=14 ease. When A3-D3 lands, wire `keep_heading` to the entity's MoveTo
   state and move heading through the manager (retiring the K=14 approximation,
   A2 §5). Decision recorded, not dual-citable as parity today.
5. **Remote `max_speed`:** retail uses the object's own
   `get_adjusted_max_speed()*2` (acclient.c:389227-389237). We have a JS-side
   per-creature run rate (`_runRate`, entities.js:6565-6577, fed off KIND_MOTION)
   but no Rust-side per-entity motion-interp speed yet. This spec passes 0.0 →
   7.5 m/s floor (acclient.c:389239-389240) — correct for the floor case, slow
   for fast movers (their corrections converge at 7.5 m/s max). Follow-on: read
   speed from the A4-Q1/A3-D2 interpreted state once remote entities have one.
6. **Remote contact for `adjust_offset`:** retail gates the per-frame step on
   the OBJECT's `transient_state & 1` (acclient.c:389208), which retail derives
   from simulating the remote body. We propose last-wire `IS_GROUNDED` (held on
   the body), defaulting Unknown → contact=true so managers aren't permanently
   frozen for packets that omit flags. Deviation; flag-gated; eye-test will
   judge.
7. **Type-3 (velocity) node producers:** the drain is cited
   (acclient.c:389370-389375) but no producer call site queuing a type-2/3 node
   was identified this read. P1 ships the kinds; nothing in P2 produces them.
   Find the producer before anyone "completes" the queue port.
8. **5 Hz UpdatePosition cadence** (A2 §6 carry-over): asserted in our comments
   (loop.js, DESIGN.md:538) but never cited to acclient/ACE. Affects only the
   risk-2 judgment, not correctness.
9. **Native default:** simulation-step code is shared; enabling
   `remote_interp_enabled` on native is one line but changes native CLI remote
   rendering — separate decision after the wasm eye-test.
