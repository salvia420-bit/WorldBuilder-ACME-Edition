# S7 — A6-T1+T2: transition-pipeline tick-spine rewrite (consuming the A7 helpers)

EXECUTION-GRADE SPEC · W3+ deep-spec sweep · 2026-06-11 · agent S7
Repo: `/home/wbterminal/WorldBuilder-ACME-Edition` (holtburger at `external/holtburger`; all
"ours" paths below are relative to `external/holtburger/`).
Retail truth: `/home/wbterminal/ac-headers/acclient.c` (+ `.h`). ACE source available at
`external/ACE/` (used where the survey's §2.6 precedence pins values via ACE).

---

## 1. Read-HEAD + W2 assumptions

**Read HEAD: `61bea82f`** ("holtburger: W2/Batch-R2 buildbox dispatch manifest"). W2/Batch-R2 is
COMMITTING to this repo while this spec was researched; everything below was verified at this
HEAD. Landed and verified in-tree at read time: A1-O1 (`tick_spine.rs`, `?unifiedTick=on`),
A1-O2 (`?posePublishPostTick=on`), A8-M1 (`?worldLifecycle=on`), A8-M2 (`?maintPrune=on`),
A13-W1 (`?wireStatePacks=stage1`), A13-W2, A13-W3, A3-D1 DESIGN delta (commit a916d12e),
A9-Stage2, A11-S0/S1.

**NOT yet in-tree at read HEAD** (verified by grep: no `USE_SETUP_STEP_HEIGHTS`,
`USE_WALKABLE_STEP_DOWN`, `USE_LANDING_WALKABLE`, `USE_ETHEREAL_RECHECK`, `step_down_resolve`
anywhere in `crates/`): the A7 W2 stages. **This spec ASSUMES W2 lands them as specified in
`apps/holtburger-web/docs/2026-06-11-unification-survey/agents/A7-collision-resolution.md` §4.**
Per-assumption dependency statement:

| W2 item | assumed landed shape | what THIS plan takes from it | if it slips |
|---|---|---|---|
| **A7-R1** (`USE_SETUP_STEP_HEIGHTS`) | per-setup `step_up/step_down_height × scale.z` (fallback 0.01) hydrated from `SetupModel` (`crates/holtburger-dat/src/file_type/setup_model.rs:310-311`) into player/entity state, threaded to both `step_*_decision` call sites | `ObjectInfo::init` caches the mover's step heights from R1's plumbed state — retail caches them per transition at `OBJECTINFO::init` (acclient.c:314128-314129, source `CPartArray::GetStepUpHeight/-Down` acclient.c:325400-325424) | `ObjectInfo` falls back to the hardcoded `PLAYER_STEP_UP_HEIGHT = 0.6` / `PLAYER_STEP_DOWN_HEIGHT = 1.5` (physics.rs:106-107) — degraded but landable; player behavior identical (player setup IS 0.6/1.5) |
| **A7-R2** (`USE_WALKABLE_STEP_DOWN`, `step_down_resolve(...)` in physics.rs) | ONE step-down helper adding retail's `contact_plane.N.z >= z_val` acceptance (acclient.c:312664-312669) consumed by BOTH the outdoor (system.rs:2492) and indoor (system.rs:2625) arms | the pipeline's validate stage calls `step_down_resolve` as its SINGLE step-down backend. **Hard structural dependency**: the spec's validate stage is written against one helper, not two duplicated snap arms | T1 must lift TWO divergent snap arms into the pipeline (more code motion, higher risk, and the walkable-acceptance gap rides into the pipeline). Strongly prefer serializing T1 after R2 |
| **A7-R3** (`USE_LANDING_WALKABLE`) | touchdown tests the landing-surface normal against `LANDING_Z = 0.0871557` (collision.rs:83 ↔ retail `z_for_landing` acclient.c:40376, consumed acclient.c:312807-312808, 312966-312967); refused landing keeps falling with a Stage-1 lateral slide | the pipeline's airborne-touchdown step consults R3's predicate instead of the unconditional terrain/floor snap (system.rs:2339-2342 outdoor, :2595-2602 indoor) | pipeline ports `CollisionInfo.frames_stationary_fall` (acclient.c:320104-320115) but its landing-allowance consumer stays inert; touchdown keeps the unconditional snap under the same flag-off semantics |
| **A7-R6** (`USE_ETHEREAL_RECHECK`) | overlap re-check deferring ethereal→solid solidify (retail `ethereal_check_for_collisions` acclient.c:317832-317866) in entity.rs + system.rs entity arm | **no structural dependency for T1/T2** (it is entity-side, T3's domain). T1's only contract: `ObjectInfo.ethereal` carries the CURRENT ethereal bit exactly as `Entity::is_collidable()` does today (entity.rs:982-986 ↔ acclient.c:314131), and the pipeline must NOT duplicate R6's re-check | nothing changes for T1/T2 |

Other in-flight W2 items this spec interacts with (conflict-order only, no semantic dependency):
**A4-Q1 + A3-D1/D2** land in `movement/system.rs` / `interp_state.rs` — the SAME file T1's
call-site swap edits. ROADMAP §3 ruling: "A6-T1 strictly after (it rewrites the tick spine those
hooks live in)". This spec assumes their edits are upstream of T1's branch point; the T1 swap
site (§3 Stage B) is additive and must be rebased onto their landed shape. **A2-P1** (queue
generalization): assumed to leave the force-position step site
(`world.scene.step_force_position_interpolation`, system.rs:2804) shape-compatible — A2 owns
offsets INTO the pipeline (retail runs the camera/interp offsets through transition too,
acclient.c:144717-145227; A2's seam per A6 §5). **A9-Stage1** (placement-id plumb): no overlap.

---

## 2. Current-state map (post-W0/W1)

### 2.1 Retail shape being targeted (verified citations)

One pipeline for every mover. `CPhysicsObj::transition` (acclient.c:320061) builds the
transition: `makeTransition → get_object_info → init_object` (320077-320080), spheres from the
PartArray scaled, else `dummy_sphere` (320083-320101), `init_path` (320103; body 311626),
stationary-fall frames from `transient_state` 0x10/0x20/0x40 → `collision_info.
frames_stationary_fall` (320104-320115), then `find_valid_position` (320116 region) →
`find_transitional_position` (313171) for `insert_type == 0` vs `find_placement_position`
(dispatch at 313419-313426).

The substep loop (`find_transitional_position`, acclient.c:313171-313340, verified):
- `calc_num_steps` (313207 call; body 311764) — non-viewer arm 311823-311845 = ceil(3D
  dist/sphere radius); viewer arm (`object_info.state & 4`) floor+1 with a last-step remainder
  recompute inside the loop (313245-313262, verified: `state & 4` branch recomputing
  `offset_per_step` on the final step).
- `state & 0x10` (FreeRotate): end rotation set ONCE up front (313180-313184); otherwise the
  loop interpolates rotation per step: `Frame::interpolate_rotation(check_pos, begin, end,
  (i+1)/num_steps)` (313276-313285, verified).
- Per step: `adjust_offset` (313266 call) → clear sliding/contact validity (313286-313288) →
  advance `check_pos` by the offset + `cache_global_sphere` (313300-313306) →
  **`transitional_insert(this, 3)`** (313307, verified constant 3) →
  **`validate_transition`** (313308; body 312194) → abort the loop early when
  `collision_normal_valid && state & 8` (PathClipped, 313312-313313).
- Cell transit is an OUTPUT recomputed from geometry every step: `build_cell_array`
  (311675-311680, verified: sets `cell_array_valid=1`, `hits_interior_cell=0`, calls
  `CObjCell::find_cell_list`); the zero-step arm calls `find_cell_list` directly (313232-313236
  region, verified); `check_other_cells` re-tests neighbours (312403 / `insert_into_cell(_,3)`
  at 312589, verified).
- Resolution inside `transitional_insert` (312834): bounded-retry `insert_into_cell`
  (311632; retry codes OK(1)/Collided(2)/Adjusted(4), code 4 invalidates the contact plane and
  retries), `check_walkable(0.0871557)` probe via `transitional_insert(_, 1)` (312518,
  verified), step_down inner re-inserts with attempts **5 then 1** (312662/312673, verified),
  edge_slide (312685-312791), cliff_slide (312005-312080) — all contact MATH owned by A7.
- Bit names pinned via ACE `ObjectInfoState` (`external/ACE/Source/ACE.Server/Physics/
  ObjectInfo.cs:8-23`, verified): Contact 0x1, OnWalkable 0x2, IsViewer 0x4, PathClipped 0x8,
  FreeRotate 0x10, EdgeSlide 0x200, IgnoreCreatures 0x400.
- Server-forced placement uses the same pipeline: `CPhysicsObj::SetPositionInternal`
  (acclient.c:322504, verified) calls `CPhysicsObj::transition` at 322812 (verified).

### 2.2 Ours, at read HEAD — the post-W1 state the A6 survey report does NOT capture

The survey's "five paths" map (A6 §2) still holds, **plus one new W1-created arm**. The
canonical spine `crates/holtburger-core/src/client/tick_spine.rs` EXISTS (A1-O1):
`tick_frame` drives `movement.tick → world.tick → simulation.tick` (tick_spine.rs:61-89);
`TickSpineHandle` is the wasm facade gated on `?unifiedTick=on` (lib.rs:93-106 parse;
tick arm branches at lib.rs:~39400). Critically, `TickSpineHandle::tick_frame` calls
`movement.note_unified_tick(now)` and **deliberately SKIPS the handle's bespoke local-pose
pre-integration** (tick_spine.rs:212-215; handle.rs:139-146 doc: "under the unified spine the
local player advances through the cli-canonical solver path").

That solver path is, at this HEAD:

| arm | route | collision coverage | cite |
|---|---|---|---|
| **P1** flag-off wasm default + native-absent | `MovementSystemHandle::tick` → `advance_local_pose_for_manual_drive` (handle.rs:117; system.rs:1229) → 30 Hz quantum slices (system.rs:1258-1271) → `advance_local_pose_for_manual_drive_slice` (system.rs:1282) | FULL chain: envcell entry flip (system.rs:1638-1646, `USE_LOCAL_ENVCELL_ENTRY=true` :436) → exit flip B11 (:1664+) → indoor per-poly walls `clamp_delta_against_cell_walls_dispatch` (call :1691; fn physics.rs:747) or cell-AABB net `clamp_delta_to_cell_interior` (call :1751; fn physics.rs:395) → outdoor buildings (:1767/:1778; fns physics.rs:331/314) → statics AABB sweep (:1916 block) → entity cylinders `clamp_delta_against_entities` (:2031; fn entity_collision.rs:82) → step_up (`step_up_decision` :2112; fn physics.rs:593) + refused-step edge-slide (:2052-2150) → water/slope gates (:2315-2412, default-off) → outdoor step-down (:2492) → indoor step-down (:2625) | retail equivalent: the whole of §2.1 |
| **P2** server-projection / autonomous drive | `current_local_drive_control` (system.rs:1126-1204) → `solve_self_player_local_drive` (physics.rs:1569) → `project_pose_by_velocity_with_collision` (physics.rs:1806; call inside solve at the `LocalGroundedDirectDrive` arm) | **buildings AABB only** (`clamp_delta_against_buildings`, physics.rs:314) — no cell walls, statics, entities, step/floor | retail: ONE `find_valid_position` regardless of autonomy (acclient.c:313419) |
| **P2b — NEW, W1-created** `?unifiedTick=on` manual WASD | spine `simulation.tick` → `build_solve_request` (simulation.rs:124; `current_local_solve_body_input` system.rs:2792 makes Manual a velocity body, and `current_local_drive_control` returns None for Manual per handle.rs:114-116 doc) → `BasicSpatialPhysics::solve` → `advance_grounded_body_kinematics` (physics.rs:1700) → `project_pose_by_velocity` (physics.rs:1786) | **ZERO collision** — the unified-tick browser player walks through everything. Also: velocity source is the LEGACY `local_velocity_for_state` (system.rs:2810-2820), not the Stage-1 interpreted velocity P1 uses (`USE_INTERPRETED_VELOCITY=true`, system.rs:270/1315) | retail: same single pipeline (acclient.c:320061) |
| **P3** remote entities | `advance_body_kinematics` (physics.rs:1841) | zero collision (A6-T3 — explicitly ON HOLD per ROADMAP §8) | acclient.c:320061/311632 |
| **P4** camera | sweep exports lib.rs:23287-23289 / camera.js:727-779 | raw sweeps — **A6-T4 PARKED, do-not-do** per RULINGS.md §1 | (contradiction resolved by human ruling) |
| **P5** projectiles | entities.js:2952-2974 | none — **A6-T5 is a separate JS-live item, NOT in this spec** | acclient.c:6246 |

**Net new finding for this spec** (supersedes A6 §3 row 2's "two solvers"): there are now
**three** local-player solvers, and the W1 flagship flag `?unifiedTick=on` currently DOWNGRADES
collision from "full chain" to "none". A6-T1+T2's job, restated post-W1: build retail's
transition pipeline once, make it the solver consumed by BOTH the legacy handle path (T1) and
the canonical spine's simulation solve (T2), so `?unifiedTick=on&unifiedTransition=on` is the
first browser configuration that is simultaneously canonical-spine AND fully-collided.

Inert scaffolds available for reuse (collision.rs): `TransitionState` enum (collision.rs:13-24
↔ retail codes at acclient.c:311632), `physics_globals` (EPSILON/LANDING_Z/FLOOR_Z etc.,
collision.rs:51-90), and the M4 `PlacementContext` family — `InsertType` (:119), `SphereLs`/
`SphereWs` (:142/:154), `PlacementCollisionInfo` (:168), and crucially a generic
**`insert_into_cell(cell, num_attempts, collide: &mut CellCollisionFn)` retry shell**
(collision.rs:497-520 ↔ acclient.c:311632 / ACE Transition.cs:660-684) plus
`check_other_cells` (:546) and `validate_placement*` (:578+). Orphan A/B gates the pipeline
retires: `USE_SUBSTEP_TRANSITION=false` (physics.rs:49), `USE_CALCNUMSTEPS_3D_DIST=false`
(physics.rs:64), `USE_CLIFF_SLIDE_INTRA_SUBSTEP=false` (physics.rs:73). A7 pure helpers the
pipeline consumes: `step_up_decision` (physics.rs:593), `floor_normal_under` (physics.rs:534),
`highest_floor_z_under` (physics.rs:480), `slide_residual_along_wall_tangent`
(physics.rs:1186), `cliff_slide_residual_along_seam` (physics.rs:1241), `FLOOR_Z`
(physics.rs:463), plus the W2-assumed `step_down_resolve` (A7-R2) and landing predicate (A7-R3).

---

## 3. Staged implementation plan

All Rust stages are **wasm-rebuild** class. **No manifest bump anywhere in this item**: no new
JS-callable `SessionHandle` exports are added (the manifest covers the JS-visible export
surface — lib.rs:431-452 `WASM_EXPORT_MANIFEST_VERSION` ↔ index.html:1801-1803
`EXPECTED_WASM_MANIFEST_VERSION`; precedent for "rebuild without bump" at url-flags.md:166).
Each stage is a separate commit; flag-off behavior must be bit-identical at every stage.

### Flag design (one feature, two carriers)

- `const USE_UNIFIED_TRANSITION: bool = false;` at the top of
  `crates/holtburger-core/src/client/movement/system.rs` (the established const-gate pattern,
  e.g. `USE_STEP_UP_DOWN` system.rs:64) — native default.
- URL flag **`?unifiedTransition=on`** (default-off), parsed in
  `apps/holtburger-web/src/lib.rs` as `parse_unified_transition_flag(&js_location_search())`,
  byte-for-byte the `parse_unified_tick_flag` shape (lib.rs:93-106). The recv-loop init calls a
  new `MovementSystemHandle::set_unified_transition(bool)` (handle.rs; delegates to a new
  `MovementSystem.unified_transition_runtime: bool` field, default false).
- Effective predicate, used at every consumption site:
  `fn unified_transition_enabled(&self) -> bool { USE_UNIFIED_TRANSITION || self.unified_transition_runtime }`
  on `MovementSystem` (pub(crate); plus a `pub` passthrough on the handle for simulation.rs).
- `?unifiedTransition=on` is INDEPENDENT of `?unifiedTick=on`: T1 covers the flag-off handle
  path, T2 covers the spine path, so the flag does something useful in all four cells of the
  matrix (see §4 test matrix).
- Documentation: add the flag row to `apps/holtburger-web/docs/url-flags.md` (movement
  section), default-off, "needs wasm rebuild, no manifest bump".

### Stage A (= A6-T0, prerequisite shell; inert; ~1 day)

New file `crates/holtburger-world/src/spatial/transition.rs` (+ `pub mod transition;` in
`spatial/mod.rs` — note spatial mod lives via `crates/holtburger-world/src/spatial/`). Pure
types + pure functions + unit tests; NOTHING calls it. Contents:

```rust
bitflags-style (plain u32 consts, no new dep) ObjectInfoState:
  CONTACT=0x1, ON_WALKABLE=0x2, IS_VIEWER=0x4, PATH_CLIPPED=0x8, FREE_ROTATE=0x10,
  EDGE_SLIDE=0x200, IGNORE_CREATURES=0x400
  // names: ACE ObjectInfo.cs:8-23; semantics verified in decompile:
  // 0x4 last-step remainder arm acclient.c:313245-313262; 0x8 abort acclient.c:313312-313313;
  // 0x10 rotation handling acclient.c:313180-313184 + 313276-313285.

pub struct ObjectInfo {
    pub state: u32,
    pub step_up_height: f32,      // A7-R1 hydrated; fallback physics.rs:106
    pub step_down_height: f32,    // A7-R1 hydrated; fallback physics.rs:107
    pub ethereal: bool,           // ↔ acclient.c:314131; ours entity.rs:982-986
    pub radius: f32,              // PLAYER_CAPSULE_RADIUS for the local player (physics.rs:81)
    pub height: f32,              // PLAYER_CAPSULE_HEIGHT (physics.rs:82)
}
impl ObjectInfo { pub fn for_local_player(...) -> Self; }  // caches per transition,
  // retail OBJECTINFO::init acclient.c:314128-314132

pub struct TransitionCollisionInfo {   // extends the M4 PlacementCollisionInfo shape
    pub base: PlacementCollisionInfo,          // collision.rs:168 (sliding/contact planes)
    pub frames_stationary_fall: u8,            // acclient.c:320104-320115
    pub collision_normal: Option<Vector3>,     // acclient.c:313312 consumer
}

pub trait TransitionEnv {              // solves the WorldState-vs-SpatialScene split:
    fn scene(&self) -> &SpatialScene;  //   geometry reads (system.rs uses world.scene.* —
    fn terrain_height_at(&self, x: f32, y: f32) -> Option<f32>;  //   system.rs:2161/2368)
    fn water_depth_at(&self, x: f32, y: f32) -> f32;             //   system.rs:2380 (gated)
}
// impl TransitionEnv for WorldState lives in holtburger-world (state/types.rs has
// water_depth_at at :540-589) — no new crate edges.

pub struct TransitionInput { pub begin: WorldPosition, pub end: WorldPosition,
    pub object: ObjectInfo, pub airborne: bool, pub force_grounded: bool }
pub struct TransitionOutcome { pub pose: WorldPosition, pub wall_normal: Option<Vector3>,
    pub grounded: bool, pub cell_changed: bool, pub state: TransitionState }

pub fn calc_num_steps(offset: Vector3, radius: f32) -> (u32, Vector3 /*per-step*/);
// retail acclient.c:311764 non-viewer arm 311823-311845: FULL-3D dist (this supersedes the
// orphan USE_CALCNUMSTEPS_3D_DIST gate, physics.rs:64 — inside the pipeline 3D is simply
// the retail rule). Viewer arm intentionally NOT implemented (A6-T4 parked, RULINGS.md §1);
// debug_assert!(state & IS_VIEWER == 0).

pub fn find_transitional_position(env: &dyn TransitionEnv, input: &TransitionInput)
    -> TransitionOutcome;   // Stage A: skeleton looping calc_num_steps with identity insert
                            // (no backends yet) + per-step rotation NOT handled (see §6 OQ4)
```

Reuse, do NOT duplicate: `TransitionState` (collision.rs:13), `physics_globals`
(collision.rs:51), and the `insert_into_cell` retry shell (collision.rs:497 — generalize its
`CellCollisionFn` alias if needed so transition.rs can pass a backend closure; the Adjusted→
invalidate-contact-plane→retry semantics there already mirror acclient.c:311632's code-4 loop).

Tests (in-file `#[cfg(test)]`): calc_num_steps table (sub-radius ⇒ 1 step ⇒ behaviour-identical
guarantee; 0.43 m run-tick @ r=0.4 ⇒ 2 steps — matches physics.rs:37-42's documented numbers);
retry-shell semantics (Adjusted clears contact plane and retries, OK/Collided return — pin
against collision.rs:497 behavior); ObjectInfo fallback heights == 0.6/1.5 exactly.

### Stage B (= A6-T1: manual-drive path through the pipeline; the H-risk stage)

1. **Backends** (transition.rs, private): one function
   `insert_check_offset(env, ctx, step_offset) -> (Vector3, TransitionState)` applying the P1
   chain IN ITS CURRENT ORDER as the cell-insert analog (retail: the cell's virtual insert
   inside acclient.c:311632; ours: the clamp chain as geometry backends per A6 §4 Stage T1):
   indoor → `clamp_delta_against_cell_walls_dispatch` (physics.rs:747) or
   `clamp_delta_to_cell_interior` (physics.rs:395) using the same baked/unbaked + doorway-relax
   predicates system.rs:1673-1751 uses today (lift them into transition.rs as pure fns taking
   `&SpatialScene`); outdoor → `clamp_delta_against_buildings_with_normal` (physics.rs:331);
   statics → the system.rs:1916 candidate sweep (`scene.statics_aabbs_near_pose`) with the same
   Tier-1 AABB clamp; entities → `clamp_delta_against_entities` (entity_collision.rs:82),
   skipped when `state & IGNORE_CREATURES != 0` (none for the player; ACE ObjectInfo.cs:20).
   `USE_PHYSICS_BSP` / `USE_STATIC_BSP` branches (system.rs:403/422) are honored INSIDE the
   backend exactly as today (consts stay false; B4 wiring stays the flag-owners' follow-on).
   A clamped step sets `collision.base.contact_plane`/`sliding_normal` from the backend's
   normal so `adjust_offset` and cliff_slide see retail-shaped state.
2. **`adjust_offset`** (transition.rs, private): minimal faithful form — project the pending
   step offset off the carried contact plane / sliding normal when valid (retail call site
   acclient.c:313266; field semantics already documented on `PlacementCollisionInfo`,
   collision.rs:161-176 ↔ ACE Transition.cs:34-87). Full AdjustOffset port fidelity: §6 OQ5.
3. **`validate_transition_step`** (transition.rs, private) — the redo handlers, ALL delegated
   to A7 helpers (the A6/A7 seam: A6 owns the loop, A7 owns the per-contact rules — A7 §4 "these
   rules transplant as-is because they are pure functions"):
   walkable classify via `floor_normal_under` + `FLOOR_Z` (physics.rs:534/463 ↔
   acclient.c:316500-316503); step_up via `step_up_decision` (physics.rs:593 ↔
   acclient.c:312794-312831) with refused-step slide via `slide_residual_along_wall_tangent`
   (physics.rs:1186); step_down via **A7-R2 `step_down_resolve`** with retail's inner attempt
   counts 5-then-1 (acclient.c:312662/312673); airborne touchdown via **A7-R3** landing
   predicate (`LANDING_Z` collision.rs:83 ↔ acclient.c:312966-312967); seam skid via
   `cliff_slide_residual_along_seam` (physics.rs:1241 ↔ acclient.c:312005-312080) — ALWAYS
   available inside the pipeline since the loop carries the previous step's plane (this is what
   `USE_CLIFF_SLIDE_INTRA_SUBSTEP` physics.rs:73 was scaffolded for; the pipeline makes it the
   rule). `precipice_slide` is NOT implemented (A7-R4 is not in the W2 assumption set); the
   walkable-edge branch keeps today's `USE_EDGE_SLIDE` behavior (system.rs:96).
4. **Per-step cell transit** (transition.rs, private `recompute_cell_after_step`): after each
   ACCEPTED step run `scene.entered_envcell_for_outdoor_pose` (system.rs call :1638) /
   `scene.exited_envcell_to_outdoor` (:1664) / `WorldPosition::normalize_outdoor_cell`
   (physics.rs `project_pose_by_offset` tail) — the analog of retail rebuilding the cell list
   every step (`build_cell_array` acclient.c:311675-311680; per-step `find_cell_list` /
   `cell_array_valid=0` in the loop acclient.c:313300-313307). Sets `cell_changed`. The shipped
   per-tick flip pair (system.rs:1638-1672) becomes the flag-off fallback, untouched.
5. **Call-site swap** in `advance_local_pose_for_manual_drive_slice` (system.rs:1282): under
   `self.unified_transition_enabled()`, after the existing velocity derivation (smoothing,
   interpreted-velocity source system.rs:1315, long-jump root :1326, gravity/airborne Z — ALL
   stay outside the pipeline; retail integrates velocity in `update_object` BEFORE transition,
   and `transition()` consumes only old_pos→new_pos, acclient.c:320061 signature), compute
   `end = pose + raw_delta` and call
   `transition::find_transitional_position(world /*as TransitionEnv*/, &input)`; write back
   `outcome.pose`, `outcome.wall_normal → world.player.last_known_wall_normal` (today's stamp
   :2178), grounded state, and skip the legacy chain. Flag-off: the legacy chain
   (system.rs:1585-2638) runs UNTOUCHED — zero code motion of the legacy path in this commit.
6. lib.rs: `parse_unified_transition_flag` + `set_unified_transition` call; url-flags.md row.

### Stage C (= A6-T2: spine/solver convergence — kills divergence #2 AND the P2b hole)

1. `crates/holtburger-core/src/client/simulation.rs` — in `ClientSimulationSystem::tick`
   (slice loop at simulation.rs:~110-122): when `movement.unified_transition_enabled()` and a
   local-player body is present, resolve the local player OUTSIDE `SpatialPhysics::solve` (the
   trait only receives `&mut SpatialScene`; the pipeline needs `&WorldState` for terrain/water —
   this is why the pipeline call sits in simulation.rs, which holds `world`):
   - Manual: build the per-slice delta from `current_local_solve_body_input`'s velocity
     (system.rs:2792-2844) × slice dt; **switch its velocity source to the same
     `USE_INTERPRETED_VELOCITY` branch P1 uses** (system.rs:1315 vs the legacy
     `local_velocity_for_state` at :2810 — parity precondition for the T1↔T2 equivalence test;
     ownership note in §6 OQ2).
   - Drive (server-projection / autonomous / move-to): `LocalDriveControl.desired_world_delta`
     (system.rs:1174-1203) is the offset input directly; `force_grounded` maps to
     `TransitionInput.force_grounded`.
   - Call `transition::find_transitional_position(world, &input)`; synthesize the
     `SolvedBodyKinematics` (same struct `solve_self_player_local_drive` returns,
     physics.rs:1569-1646) and feed it through the existing `apply_solve_batch`
     (simulation.rs:183) so event emission/projection-state bookkeeping is unchanged.
   - Exclude the local body + `local_drive` from the `SpatialSolveRequest` for that slice so
     `BasicSpatialPhysics::solve` cannot double-advance it.
2. Flag-off: `solve_self_player_local_drive` / `advance_grounded_body_kinematics` paths
   byte-identical (no edits to physics.rs solver arms in this stage).
3. Native cli rides the same simulation.rs branch — single change-site covers native + wasm
   spine (tick_spine.rs delegates to the same `simulation.tick`, tick_spine.rs:83).

### Stage D (post-1070, W6 — NOT in this item's landing scope; listed for rollout completeness)

Default-ON campaign after Stage-1 eye-test PASS + per-flag eye-tests: flip
`USE_UNIFIED_TRANSITION=true`, retire the legacy P1 chain + the B11 per-tick flip pair + orphan
gates `USE_SUBSTEP_TRANSITION`/`USE_CALCNUMSTEPS_3D_DIST`/`USE_CLIFF_SLIDE_INTRA_SUBSTEP`
(physics.rs:49/64/73), mark the url-flags.md row DONE per the passed-flag policy
(DESIGN.md §3 Stage-1 precedent).

**Explicit non-scope:** A6-T3 (remote entities — ROADMAP §8 hold), A6-T4 (camera — RULINGS.md
§1 parked), A6-T5 (projectiles — separate JS-live item), A7-R4 precipice_slide, A2's
force-position easing internals (its offsets enter the pipeline unchanged at the existing step
site system.rs:2804).

---

## 4. Test plan

### Headless-now (Lane A — land with the code, buildbox cargo tests; run by the W4 implementer,
NOT during the current W2 build freeze)

Stage A: the unit tests listed in §3 Stage A (calc_num_steps table, retry semantics,
ObjectInfo fallbacks).

Stage B (crate tests in holtburger-world::spatial::transition + holtburger-core movement
tests; fixture style = the existing synthetic-world tests, cf. tick_spine.rs:248-456):
1. **Flag-off byte-parity**: the ENTIRE existing movement/spatial suite passes untouched (the
   legacy chain is not edited — this is structural, assert by zero diffs to legacy fns).
2. **num_steps==1 equivalence**: for sub-radius deltas, pipeline end-pose == legacy single-pass
   end-pose bit-for-bit on: open ground, single-wall contact, entity contact (the
   physics.rs:37-42 "pure superset" guarantee, now asserted).
3. **Thin-wall anti-tunneling**: fast delta (> 2×radius) through a thin indoor wall fixture —
   legacy passes through (pin current behavior), pipeline stops/slides (retail
   acclient.c:311764 step count ⇒ no sub-radius tunneling).
4. **L-corner second-wall slide**: long diagonal into a concave corner slides along wall 2
   (acclient.c:312005-312080 ↔ cliff_slide_residual_along_seam physics.rs:1241).
5. **Per-step cell transit**: doorway-diagonal fixture crossing outdoor→EnvCell mid-delta
   flips the cell on the correct STEP, not at slice end (acclient.c:313300-313307 per-step
   rebuild ↔ recompute_cell_after_step).
6. **Step-up riser / walkable step-down / refused steep step-down** (consumes A7-R2: steep
   downhill face ⇒ Fall not Snap, acclient.c:312664-312669) / **landing allowance** (A7-R3:
   85° wall landing allowed, perch refused, acclient.c:312807-312808).
7. **Insert retry**: backend reporting Adjusted invalidates the contact plane and re-inserts,
   bounded at 3 (acclient.c:313307 / 311632 ↔ collision.rs:497 shell).

Stage C:
8. **Move-to-through-wall**: drive-control fixture whose `desired_world_delta` crosses a cell
   wall — flag-off P2 crosses (pin the divergence, physics.rs:1806 buildings-only), flag-on
   blocks (retail acclient.c:313419 single solve).
9. **Spine-manual collision**: `TickSpineHandle::tick_frame` (tick_spine.rs:200) with a Manual
   drive into a wall — flag-off advances through (pin the P2b hole, physics.rs:1786
   unclamped), flag-on blocks. Four-cell matrix asserted:
   {unifiedTick off/on} × {unifiedTransition off/on} — off/off and on/off byte-match today's
   two behaviors; off/on == T1 path; on/on == T2 path.
10. **T1↔T2 equivalence**: same Manual input through the handle path (flag-on) and the spine
    path (flag-on) lands within 1e-5 (requires the velocity-source alignment, §3 Stage C.1).
11. **Flag-parse test** in lib.rs (same shape as the `parse_wire_state_packs_flag` tests,
    lib.rs:22283-22287).

### 1070-gated (Lane B — parked until the box returns; all default-ON promotion)

Holtburg run loop vs walls/statics/NPCs; academy dungeon corridor + doorway diagonal at run
speed (cell-transit feel); mansion entry/exit (B11 parity); L-corner outdoor building skid;
move-to (use a chest / NPC approach) through a wall corner; jump onto a cliff face (R3 landing
slide-off). Promotion gate per ROADMAP §2: **Stage-1 eye-test PASS** gates A6-T1+ flag-ON —
landing flag-off is NOT gated.

---

## 5. Risks + rollback

1. **H implementation risk (survey-scored)**: Stage B touches the live player tick's hot
   function. Mitigation: additive-only swap (legacy chain unedited), flag default-off both
   carriers, parity tests 1-2 above, and the ROADMAP §9 "Fable-class" assignment for T1/T2.
2. **Same-file W2 collisions**: system.rs is being edited by W2 (A4-Q1, A3-D1/D2) RIGHT NOW.
   Hard ordering: rebase Stage B onto the landed W2 shape; do not start the swap commit until
   Batch-R2 is merged. (ROADMAP §3 system.rs ruling: A6-T1 strictly after.)
3. **Perf**: backends run per substep (≈2 steps per 30 Hz run-tick). Mitigation: gather
   geometry candidates (building/statics/entity lists) ONCE per slice and refresh per step only
   when `cell_changed` — same data the legacy chain gathers once today (system.rs:1813/1916).
   Cell-wall dispatch is already per-poly bounded by the current cell.
4. **Behavioral deltas under the flag are INTENDED** (anti-tunneling, seam skid, per-step
   transit) — they change feel; that is exactly why promotion is 1070-eye-test-gated (W6) and
   the flag ships off.
5. **unifiedTick interplay**: T2 only affects the spine when `?unifiedTick=on`, itself
   default-off; nothing in this item changes the default browser path. The four-cell matrix
   test (Lane A #9) pins all combinations.
6. **A7 slip risk**: R2 is the only hard structural dependency (see §1 table) — if Batch-R2
   lands without it, hold Stage B or land it with the two-arm lift noted in §1 (worse shape;
   prefer holding).
7. **Rollback**: per-stage single-commit revert; runtime kill: drop `?unifiedTransition=on`
   (URL) — flag-off paths are untouched code, so rollback is byte-exact. Native: const stays
   `false` until Stage D. No manifest bump ⇒ no stale-pkg interaction; old bundles simply
   ignore the unknown query key.

---

## 6. OPEN QUESTIONS

1. **(carried from A6 §6, still single-cited)** `frames_stationary_fall`'s CONSUMER in the
   resolution math: set at acclient.c:320104-320115 and checked in the loop
   (acclient.c:313309-313310 `if (collision_info.frames_stationary_fall) goto LABEL_19`), but
   what the resolution functions DO with it ours-side has no counterpart (grep
   `stationary_fall` in crates/ = 0 hits). T0 ports the field; A7 should confirm the consumer
   before Stage B wires more than the loop-exit check.
2. **Velocity-source ownership (T2 vs A1-O3/A3)**: aligning
   `current_local_solve_body_input` (system.rs:2810) to the interpreted-velocity branch
   (system.rs:1315) is REQUIRED for the T1↔T2 equivalence test, but the spine's velocity
   contract is arguably A1-O3/A3-D1 territory. Proposed here as part of Stage C; needs an A16
   serialization ruling if A1-O3 lands first.
3. **Per-object step-down ENABLE bit** (retail `OBJECTINFO::init` derives it from object-state
   bit 6, acclient.c:314132; A7 §6 could not name the `PhysicsState` bit): `ObjectInfo` here
   omits it (player always steps); must be resolved before T3 ever un-parks.
4. **Per-step rotation interpolation**: retail interpolates rotation each step
   (`Frame::interpolate_rotation`, acclient.c:313276-313285); our slice integrates omega once
   per slice (system.rs:1331-1340 block). T1 keeps rotation OUTSIDE the pipeline (rotation does
   not feed any of our lateral backends — they take only pose+delta, physics.rs:747/331
   signatures). Cannot dual-cite "rotation never affects retail's insert result" — flagged
   rather than claimed; revisit if eye-tests show corner-rotation feel deltas.
5. **adjust_offset fidelity**: Stage B ships the minimal contact-plane/sliding-normal
   projection (call site acclient.c:313266; field semantics collision.rs:161-176). The full
   ACE `Transition.AdjustOffset` (Transition.cs:34-87) has additional arms (z-slope kill,
   walkable-allowance interaction) not yet dual-cited against the decompile body — port them in
   Stage B only if the L-corner/step fixtures fail with the minimal form; otherwise defer to
   the Stage D fidelity pass.
6. **`num_insertion_attempts` for `check_other_cells` inside the transitional loop**: verified
   3 at acclient.c:312589 (placement-side) and 3 for the main-loop `transitional_insert`
   (313307); whether any OTHER caller of `insert_into_cell` in the transitional path uses a
   different count was not exhaustively traced — implementer should grep
   `insert_into_cell(` callers (list at §2.1) before hardcoding.
7. **Laptop-only dedupe caveat (inherited from A6/A7 §6)**: `~/out/bughunt86-…` and
   `~/out/grind-loop-2026-06-11.md` were re-grepped per LAPTOP-REGREP.md per RULINGS.md, but
   this spec did not re-verify those findings on this host; rows marked "untracked" in A6 §3
   were taken as final per the rulings doc.
