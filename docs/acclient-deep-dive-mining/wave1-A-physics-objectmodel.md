# Wave 1 — Agent A mining report
## Sources: `2013-09-11.4186-v3/01-physics.md` + `03-object-model.md`

Target of contrast: `external/holtburger/apps/holtburger-web` (JS/three.js + wasm) and
`external/holtburger/crates/{holtburger-core,holtburger-world,holtburger-dat,holtburger-common,holtburger-protocol}`.

Every holtburger citation below was opened and read. Where no site could be
found the disposition says **ABSENT** or **UNVERIFIED** explicitly.

**Headline context (matters for how to read this report):** holtburger already
contains a *decomp-faithful* `CTransition` port (`crates/holtburger-dat/src/transition/`,
17.4k lines across 36 files) which is **live and default-on** for the local player
(`crates/holtburger-core/src/client/movement/system.rs:668` `USE_FAITHFUL_TRANSITION = true`,
`:693` `USE_FAITHFUL_OUTDOOR = true`, `:715` `USE_FAITHFUL_STEPUP = true`,
`:643` `USE_UNIFIED_TRANSITION = true`). Most of `01-physics.md` §3 is therefore
already at parity, and PARITY-OK is the honest disposition for it. The real
yield is in the *systems retail has that holtburger has no site for at all*
(§2 impulse solver, §7 DetectionManager, §8 collision reporting) and in the
object-model constants.

---

# PART 1 — COVERAGE LEDGER

## `01-physics.md`

| § | Claim / subsection | Disposition |
|---|---|---|
| §1 | `CPhysicsObj` derives `LongHashData`, 230 bodies / 218 names, member list | REF-ONLY — record in `docs/` decomp-map; holtburger splits the same state across `holtburger-world::WorldState.player` + `Entity` + `spatial::scene::SpatialScene`, no single class analog by design |
| §1 | `PhysicsState` bit values (`STATIC 0x1` … `FROZEN 0x1000000`, `SLEDDING 0x800000` @acclient.h:2839) | PARITY-OK — `crates/holtburger-common/src/properties/object.rs:70` `HIDDEN 0x4000`, `:72` `HAS_PHYSICS_BSP 0x10000`, `:78` `EDGE_SLIDE 0x400000`, `:79` `SLEDDING 0x800000`, `:80` `FROZEN 0x1000000` — all match |
| §1 | `TransientState` bits (`CONTACT 0x1`, `ON_WALKABLE 0x2`, `SLIDING 0x4`, `WATER_CONTACT 0x8`, `STATIONARY_*` 0x10/0x20/0x40, `ACTIVE 0x80`, `CHECK_ETHEREAL 0x100`) | TASK(PHY-05) — CONTACT/ON_WALKABLE/STATIONARY_FALL are modelled (`crates/holtburger-world/src/player/types.rs:1609` `frames_stationary_fall`; `spatial/transition.rs:61-67`), but `ACTIVE_TS` has no site |
| §1 | Position and Frame (`Frame` quaternion + cached `m_fl2gv[9]`, `Position{objcell_id, Frame}`) | PARITY-OK — `crates/holtburger-common/src/position.rs` `WorldPosition{landblock_id, coords, quaternion}`; the cached 3×3 is recomputed in `crates/holtburger-dat/src/transition/frame_transform.rs` |
| §1 | Geometry: `CSetup` part DIDs / spheres / `step_down_height` before `step_up_height` / sorting+selection spheres | PARITY-OK — `crates/holtburger-world/src/spatial/transition.rs:91-96` hydrates the verbatim retail player Setup `0x02000001` spheres (r 0.48 @ z 0.475 / 1.35, height 1.835); `:106-109` per-setup step heights with 0.6/1.5 fallbacks |
| §1 | `BSPNODE` virtuals `sphere_intersects_solid` / `hits_walkable` / `find_walkable` | PARITY-OK — `crates/holtburger-dat/src/transition/bspnode_solid.rs`, `bspnode_walkable.rs`, `bspnode_poly.rs` (1,237 lines) |
| §1 | Cells: `CObjCell`/`CSortCell`/`CLandCell`/`CEnvCell` incl. `light_array` of pre-lit vertex colours | PARITY-OK for collision (`crates/holtburger-dat/src/transition/objcell.rs`, 1,318 lines); EnvCell pre-lit vertex colours are a render concern owned by wave-B (`06-rendering`) |
| §1 | `CLandBlock` has **no declared 8×8** — flat `lcell` + runtime `side_cell_count²` asserted 8 | REF-ONLY — a decomp-reading caveat, not a behaviour; holtburger uses a fixed 8×8 outdoor cell index |
| §1 | Cell-ID encoding `(((y>>3)|32*(x&~7))<<16) | ((y&7)+8*(x&7)+1)` | PARITY-OK — `crates/holtburger-common/src/position.rs:77-95` derives outdoor cell ids 1..64 from local 0-192 coords |
| §1 | `gid_to_lcoord` treats low word `< 0x100` as outdoor | PARITY-OK — used pervasively: `crates/holtburger-world/src/spatial/scene.rs:1992`, `:2002`, `:2117`, `:2127` |
| §1 | `get_block_offset`: same block → 0, else Δblock × 24.0 with z = 0 (why dungeon coords are block-local) | TASK(PHY-23) |
| §1 | `CObjectMaint` registry set incl. `lost_cell_table`, `destruction_object_table`, `object_destruction_queue` | TASK(OBJ-38) |
| §2 | **30 Hz outer gate** — `CPhysics::UseTime` no-ops unless `cur_time − last_update >= MIN_QUANTUM_93 (1/30)` | TASK(PHY-20) — the *integrator* honours 30 Hz (`movement/system.rs:1159`, `:4123`) but the whole-pass gate (statics anim, `UpdateTexVelocity`, particle managers) does not |
| §2 | `UseTime` order: maintenance hash → `update_object` → `SmartBox::PlayerPhysicsUpdatedCallback` → static animation | PARITY-OK — `apps/holtburger-web/scene3d/loop.js:2056` explicitly mirrors this order ("world (dynamic) managers first, then statics, mirroring CPhysics::UseTime") |
| §2 | Activity culling: skip `parent`/cell-less/`FROZEN_PS`; `dist > 96.0 && obj_maint->is_active` clears `ACTIVE_TS`; the 96-unit cull is **always on** in shipped play | TASK(PHY-04) — ours is 120 m (`apps/holtburger-web/scene3d/entities.js:1948` `MAX_TICK_DIST` default 120) |
| §2 | `UpdateObjectInternal` runs its whole body only for `ACTIVE_TS`; `UpdatePhysicsInternal` self-deactivates a stationary object with no `movement_manager` | TASK(PHY-05) |
| §2 | Time quantization: `dt <= 0.0002` resync; `dt > 2.0` discard; **`dt < MAX_QUANTUM` stepped WHOLE with no MIN test**; MIN gates only the remainder; live values 1/30 and **1/5** | TASK(PHY-08) — the shape is ported behind a flag (`movement/system.rs:493-516` `USE_RETAIL_QUANTUM = false`; `movement/common.rs:761` `RETAIL_MAX_QUANTUM = 0.2`) but shipped path uses ACE's 0.1 (`crates/holtburger-world/src/spatial/collision.rs:82`) |
| §2 | 100 `MIN_QUANTUM` copies all static-init'd; only `_93`/`_97` read; IDA's `= 0.0` is BSS | REF-ONLY (decomp trap; already reflected in the port's comments) |
| §2 | Update chain: `UpdatePositionInternal` → `CSequence::update` scaling root motion by `m_scale` when `ON_WALKABLE_TS` and **by 0.0 otherwise**; skipped under `HIDDEN_PS` | PARITY-OK — `apps/holtburger-web/scene3d/entities.js:10829-10834` + `:10856-10868` implement exactly this (translation skipped when airborne, rotation always applied); see also TASK(PHY-19) for the per-frame vs completion-time approximation |
| §2 | `PositionManager::adjust_offset` between sequence and physics | PARITY-OK — `crates/holtburger-world/src/spatial/position_manager.rs:502-546` |
| §2 | `UpdatePhysicsInternal`: 50 u/s velocity clamp, `calc_friction`, zero under 0.25 u/s, `x += v·dt + ½a·dt²`, `v += a·dt`, `Frame::grotate` | PARITY-OK — `crates/holtburger-core/src/client/movement/common.rs:746` `MAX_VELOCITY = 50.0`; friction at `:692`; 0.25 threshold at `crates/holtburger-world/src/spatial/env840_seam_tests.rs:680` (`mag2 - 0.25*0.25`) |
| §2 | `calc_acceleration` zeroes accel+omega when `CONTACT && ON_WALKABLE && !SLEDDING`, else gravity −9.8000002 under `GRAVITY_PS` | PARITY-OK — the whole `calc_friction`/SLEDDING lattice is in `crates/holtburger-core/src/client/movement/common.rs:615-660` (`SLEDDING_LOW_VELOCITY_SQ 1.5625`, `SLEDDING_HIGH_VELOCITY_SQ 6.25`, `SLEDDING_STEEP_NORMAL_Z 0.98480775` — including the note that the old `0.99999536` port inherited a bug) |
| §2 | **Heading alignment is either/or**: `ALIGNPATH_PS` → heading to *position delta*; `else if SLEDDING_PS` + nonzero velocity → yaw to velocity | TASK(PHY-12) |
| §2 | `cached_velocity = offset / quantum` on success, zeroed on failure | TASK(PHY-09) — ABSENT |
| §2 | Post-commit manager tick order: Detection, Target, `MovementManager::UseTime`, `CPartArray::HandleMovement`, `PositionManager::UseTime`, particles, scripts | TASK(PHY-03) for the two absent managers; the rest PARITY-OK (`crates/holtburger-core/src/client/tick_spine.rs:8`) |
| §2 | **The impulse solver**: `v13 = v·n; v14 = −(v13·(elasticity+1)); v += v14·n` with four guards (`frames_stationary_fall <= 1`, `collision_normal_valid`, `v·n < 0`, `INELASTIC_PS` zeroes instead) | TASK(PHY-01) — ABSENT; `elasticity` is parsed and stored (`crates/holtburger-world/src/hydration.rs:238`) and never read by any solver |
| §2 | Bounce suppressed when the object was and remains on walkable ground unless `SLEDDING_PS` | TASK(PHY-01) (same task) |
| §2 | `SetPositionInternal`: `LeaveGround`, `sliding_normal`→`SLIDING_TS`, then `handle_all_collisions` | PARITY-OK for the first two (`movement/system.rs:607` `USE_LEAVE_GROUND_VELOCITY = true`); the third is TASK(PHY-01) |
| §2 | Cell residency splits: `calc_cross_cells` **only** when `HAS_PHYSICS_BSP_PS`; otherwise diff the transition's `cell_array` via `remove/add_shadows_to_cells` | PARITY-OK — `crates/holtburger-dat/src/transition/driver_validate.rs:390-406` rebuilds `cell_array` every step and `types.rs:380-382` carries `cell_array_valid` |
| §3 | `CTransition` = OBJECTINFO + SPHEREPATH + COLLISIONINFO + CELLARRAY | PARITY-OK — `crates/holtburger-dat/src/transition/types.rs:512-578` |
| §3 | Static pool of **10**; `makeTransition` returns 0 once `transition_level >= 10`; `cleanupTransition` decrements | PARITY-OK — `crates/holtburger-dat/src/transition/driver_init.rs:225` `MAX_TRANSITION_LEVEL = 10`, `:258-269` `make_transition`/`cleanup` with the documented C-idiom-subsumption note |
| §3 | `CPhysicsObj::transition` seeds `frames_stationary_fall` from `STATIONARY_*` bits (`0x40`→3, `0x20`→2, `0x10`→1) | PARITY-OK — `crates/holtburger-core/src/client/movement/system.rs:6589-6596` (`1|2 => value`, advance-guard at `:6590`) |
| §3 | **`floor_z = cos(3437.746770784939)`** → f32 0.66417414 → **≈48.381°**, a genuine degrees-for-radians bug; only writer is 800530; readers `is_valid_walkable`, `get_walkable_z`, `SetPositionInternal` | PARITY-OK — `crates/holtburger-world/src/spatial/physics.rs:488` `FLOOR_Z = 0.664_174_15` with the 48.4° note at `:480`; `crates/holtburger-dat/src/transition/types.rs:719-725` asserts it against `cos(48.381°)` and `> Z_FOR_LANDING` |
| §3 | `z_for_landing = 0.0871557` (sin 5° / cos 85°), non-walking allowance and `step_down`'s `z_val` | PARITY-OK — `crates/holtburger-dat/src/transition/types.rs:42` `Z_FOR_LANDING = 0.0871557`; `crates/holtburger-world/src/spatial/collision.rs:86` `LANDING_Z`; used as the `step_down` z_val at `transition/driver_validate.rs:326` |
| §3 | Sub-stepping: `calc_num_steps` = `floor(dist/radius)+1` when `IS_VIEWER_OI (0x4)` else `ceil(dist/radius)` | TASK(PHY-06) — `crates/holtburger-world/src/spatial/transition.rs:388-395` ports the **non-viewer arm only**; `:33` records "the viewer arm of `calc_num_steps` is NOT implemented" — and the local player IS the viewer |
| §3 | Rotation slerped per step (`Frame::interpolate_rotation`) | PARITY-OK — `crates/holtburger-dat/src/transition/frame_transform.rs` |
| §3 | `transitional_insert` retry count is a **caller-supplied parameter**: 3 from `find_transitional_position`, 5 from `step_down`, 1 from the confirmation re-insert | PARITY-OK — `crates/holtburger-dat/src/transition/driver_spine.rs:113` takes `num_insertion_attempts`; `:411` `transitional_insert(world, 5)` inside `step_down`; `:434` "Placement re-pin (attempts 1)" |
| §3 | **Slide**: `slide_sphere` *primarily* projects onto `cross(collision_normal, contact_plane.N)`; the perpendicular-plane projection is the degenerate fallback | PARITY-OK — `crates/holtburger-dat/src/transition/sphere_slide.rs` + `resolver_slide.rs` |
| §3 | **Step up**: sets `step_up_normal`, calls `step_down(step_up_height, walkable_z)`, falls back to `step_up_slide` | PARITY-OK — `crates/holtburger-dat/src/transition/sphere_step.rs`; live behind `USE_FAITHFUL_STEPUP = true` (`movement/system.rs:715`) |
| §3 | **Step down**: accepts only if `contact_plane.N.z >= z_val`; halving lives in the *caller* — `step_down_ht = radius*0.5` when `num_sphere < 2 && 2*radius < step_down_ht`, then a **single** `*0.5` and `step_down` called **twice with that same value** | PARITY-OK — `crates/holtburger-dat/src/transition/driver_spine.rs:343` "half-height; retry twice with the SAME args" |
| §3 | **Edge slide** → `cliff_slide` / `precipice_slide`; gate requires `ON_WALKABLE_OI | EDGE_SLIDE_OI`; `cliff_slide` crosses current+last contact normals, zeroes z, clamps | PARITY-OK for the faithful driver (`crates/holtburger-dat/src/transition/types.rs:539-567` documents the deliberate terrain-only precipice deviation with reasoning); TASK(PHY-11) for the legacy chain |
| §3 | Stationary-fall failsafe: fabricated plane `N=(0,0,1)`, `d = radius − center.z`; env collision only on the 3rd consecutive frame **and** `!CONTACT`; gated on not-ethereal + `GRAVITY_PS`; `redoa` is 0 in two cases | PARITY-OK — `crates/holtburger-dat/src/transition/driver_validate.rs` + `crates/holtburger-core/src/client/movement/system.rs:6589-6596`; the "advance only when the counter actually moved" guard is present |
| §3 | `CEnvCell::find_env_collisions` runs the physics BSP via `BSPTREE::find_collisions` | PARITY-OK — `USE_PHYSICS_BSP` live since 2026-06-16 per `apps/holtburger-web/docs/url-flags.md` §69 |
| §3 | **`CLandCell::find_collisions` does NOT test terrain polygons** — the 2-poly loop lives in `find_terrain_poly` | PARITY-OK — `crates/holtburger-dat/src/transition/terrain_collision.rs:129-143` `find_terrain_poly`; the split magic `1813693831` is cited at `:11` |
| §3 | `CSortCell` reaches `CBuildingObj::find_building_collisions`; object-vs-object `find_obj_collisions` → `CSphere::intersects_sphere`; primitive `CPolygon::polygon_hits_sphere` (+ `_slow_but_sure`) | PARITY-OK — `crates/holtburger-dat/src/transition/polygon_hits.rs`, `sphere_basics.rs`, `driver_cell_dispatch.rs` |
| §3 | `find_cell_list` 4 overloads; **cylsphere overload silently clamps to 10** into a file-static scratch | TASK(PHY-14) |
| §3 | Core overload branches on `(u16)cell_id >= 0x100` → `CEnvCell::GetVisible` + `hits_interior_cell`, else `CLandCell::Get` + `add_all_outside_cells`; then virtual `find_transit_cells` | PARITY-OK — `crates/holtburger-world/src/spatial/scene.rs:1963` (`find_cell_list`'s `point_in_cell` re-seat), `transition/objcell.rs:553` `add_outside_cell` |
| §3 | `CEnvCell::find_transit_cells` adds `0.00019999999` to the radius, accepts on `> -ia && < ia`; portal ID −1 opens outdoors | PARITY-OK — `crates/holtburger-dat/src/transition/types.rs:32-37` `EPSILON = 0.0002` (with the "decomp spells it 0.00019999999" note at `sphere_basics.rs:14`); portal −1 handled in `objcell.rs` |
| §4 | `CSequence::update` → `update_internal` then `apricot`; `frame_number += framerate*quantum`, loop over each integer boundary calling `Frame::combine(get_pos_frame(n))`; reverse via `subtract1`; **no keyframe interpolation anywhere** | PARITY-OK — `apps/holtburger-web/scene3d/animation.js:263-265` forces discrete interpolation with an explicit "never interpolated" note; `:753-754` warns a linear/SLERP track would interpolate across uneven times |
| §4 | **Correction:** `apply_physics` is called *inside* the per-frame loop with `dt = 1/framerate` — a lump per boundary; with no boundary crossed `update_internal` contributes **nothing**. Invisible only because `CPhysics::UseTime` is itself 1/30-gated | PARITY-OK-with-note — holtburger's shipped model (`movement/system.rs:559` `USE_INTERPRETED_VELOCITY = true`, doc at `:541-556`) derives ground velocity from the authored MotionData cycle base (run 4.000 / walk 2.602) × interpreted `speed_mod` and *direct-sets* it each slice. Continuous rather than lumped, but at a 60 Hz rAF this is closer to retail-in-practice than a lump would be, and it deliberately avoids retail's per-boundary stutter. Recorded, not a task |
| §4 | `execute_hooks` filters `if (!direction_ || dir == direction_)` | PARITY-OK — `apps/holtburger-web/scene3d/entities.js:11874-11881` sets `direction = 0` for script-sourced hooks *deliberately* (retail `ScriptManager::UpdateScripts` has no direction gate) while the motion-sequence path keeps the gate at `:9935` |
| §4 | `process_hooks` drains `PhysicsObjHook` (interpolating `FPHook`/`VectorHook` tweens, deleting on `Execute()==true`) **then** fires and clears one-shot `anim_hooks` | PARITY-OK — `apps/holtburger-web/scene3d/hook_windows.js` + `script_manager.js:177-240` (`_armNextHook` mirroring `NextHook`) |
| §4 | 26 direct `CAnimHook` subclasses enumerated | PARITY-OK — all 26 decoded: `apps/holtburger-web/scene3d/entities.js:11882-11948` covers 1,2,6,7,8,9,10,11,12,13,14,15,16,18,19,20,21,22,23,24,25,26; types 3 (Attack) `:13838`, 4 (AnimationDone) `:14031`, 5 (ReplaceObject) `:14258`+`:14951`, 17 (DefaultScript) `:14060`. Wire layouts in `crates/holtburger-dat/src/file_type/setup_model_hooks.rs` |
| §4 | `apricot` deletes finished non-cyclic nodes from the head, stopping at `curr_anim` or `first_cyclic` | PARITY-OK — `apps/holtburger-web/src/motion_sequence.rs:76-99`, `:202-211`, `:276-277` (`first_cyclic_index` wrap target) |
| §5 | `MovementManager::PerformMovement` fans types 1–5 → `CMotionInterp`, 6–9 → `MoveToManager` | PARITY-OK — `crates/holtburger-core/src/client/movement/movement_manager.rs` (1,674 lines) |
| §5 | **Command IDs**: `Ready 0x41000003`, **`TurnRight 0x6500000D`**, **`TurnLeft 0x6500000E`**, `SideStepRight 0x6500000F`, `SideStepLeft 0x65000010`, `HandCombat 0x8000003C`. *Earlier drafts had TurnLeft/TurnRight swapped* | PARITY-OK — holtburger has it right: `apps/holtburger-web/scene3d/camera.js:2278-2279` and `:2312-2313` (`turn > 0 → 0x6500000d` TurnRight), `scene3d/entities.js:1576-1577`, `crates/holtburger-core/src/client/movement/common.rs:294-301`, `apps/holtburger-web/src/lib.rs:36894-36895` |
| §5 | `CMotionTable` = four hash tables `style_defaults` / `cycles` / `modifiers` / `links` | PARITY-OK for parse — `crates/holtburger-dat/src/file_type/motion_table.rs:22,23,52,53` |
| §5 | `MotionData.velocity` installed as `CSequence::set_velocity(speed_mod * data->velocity)` before appending each `AnimData` scaled by `speed_mod` | PARITY-OK — `crates/holtburger-core/src/client/movement/system.rs:546-552` cites `add_motion` acclient.c:337431-337474 and the anti-ice-skating contract at `:337465` |
| §5 | `GetObjectSequence` decodes `0x80000000` = style change, `0x40000000` = cycle; cycle key `motion & 0xFFFFFF | (style << 16)` with `default_style` fallback | PARITY-OK — `crates/holtburger-dat/src/file_type/motion_table.rs:81` `cycle_key(stance, command)`, mask note at `:13` |
| §5 | `get_link` keys `(style << 16) | (substate & 0xFFFFFF)` and **reverses the lookup when either speed is negative** | PARITY-OK — `crates/holtburger-dat/src/file_type/motion_table.rs:167-218`, a line-for-line two-hop port including the `style_defaults` bridge (`:187-189`) and the reversed arm (`:207-209`) |
| §5 | `re_modify` / `change_cycle_speed` / `subtract_motion` / `combine_motion` retune a running sequence rather than restarting it | TASK(PHY-10) — `crates/holtburger-dat/src/file_type/motion_table.rs:41-52` records that all 1,222 modifier entries are anim-free and that "Path B" (per-entity MotionState + `combine_motion` + `re_modify`) **remains deferred** |
| §5 | `MotionTableManager` queues an `AnimNode` per command and counts `AnimDoneHook` firings; `AnimationDone` pops `action_head` when `motion & 0x10000000` — **before** `MotionDone` | PARITY-OK — `crates/holtburger-core/src/client/movement/motion_table_manager.rs:488-514`: the pop (`remove_action_head`, `:514`) happens inside the `AnimationDone` arm before `MotionDone` is emitted; action bit `0x10000000` at `:51` |
| §5 | `HandleExitWorld` force-completes with `success = 0` | PARITY-OK — `crates/holtburger-core/src/client/movement/motion_table_manager.rs:72` ("expiry exactly as a renderer `AnimationDone(success=1)` would") + the `MotionDone{success}` event at `:218`; exit-world force-complete path present |
| §5 | `adjust_motion` canonicalization: TurnLeft→TurnRight negated; WalkBackwards→WalkForward at −0.65×; SideStepLeft→SideStepRight negated; sidestep × `3.1199999/1.25*0.5 = 1.24799996` | PARITY-OK — `crates/holtburger-core/src/client/movement/common.rs:790` `SIDESTEP_ADJUST_FACTOR = 1.248`, `:807` `BACKWARDS_FACTOR = 0.649_999_98`, `:294-301` TurnLeft→TurnRight collapse |
| §5 | `get_state_velocity`: sidestep 1.25, walk 3.1199999, run 4.0; magnitude capped at `run_rate * 4.0` | PARITY-OK — `common.rs:779` `SIDESTEP_ANIM_SPEED = 1.25`; walk/run bases at `movement/system.rs:551` (run 4.000 / walk 2.602 *authored cycle* values — see OPEN QUESTION 3) |
| §5 | **Effective sidestep = 1.25 × 1.248 ≈ 1.56**; `apply_run_to_command` runs *after* the 1.248, scales turn by 1.5, clamps to ±3.0 → max sidestep 3.75; `get_max_speed = run_rate * 4.0` | PARITY-OK — `common.rs:763-790` names this exact chain and calls out the prior misread (`SIDESTEP_RUN_SPEED_CAP_M_PER_SEC` treated 3.0 as m/s), `:860-870` `sidestep_axis_speed` implements `min(1.248·run_rate, 3.0)·1.25` |
| §5 | `charge_jump` sets `standing_longjump` only when `CONTACT && ON_WALKABLE && forward_command == Ready(0x41000003) && no sidestep && no turn`; early-out for `0x40000008` and `0x41000012`–`0x41000014` | PARITY-OK — `crates/holtburger-core/src/client/movement/jump_charge.rs:116` cites `charge_jump`, `:151` "Standstill long-jump root"; `motion_interp.rs:3134-3145` `is_standing_still` falsifiers cover forward/sidestep/turn/airborne |
| §5 | `get_jump_v_z` defaults to 10 u/s; `get_leave_ground_velocity` sets `v = state_velocity`, `v.z = jump_v_z` in **local** space; `m_fl2gv` rotation is a fallback only when all three components are near zero | PARITY-OK — `crates/holtburger-core/src/client/movement/motion_interp.rs:1497-1509` (`None => 10.0`), `movement/system.rs:607` `USE_LEAVE_GROUND_VELOCITY = true` |
| §5 | `MoveToManager::UseTime` services the head node **only while `CONTACT_TS`** | PARITY-OK — `crates/holtburger-core/src/client/movement/move_to.rs`; the TurnRight/TurnLeft contact exemption is explicit at `movement/system.rs:4280` and `:5811` |
| §5 | `HandleMoveToPosition` corrects heading first: **above 20°** error it issues TurnRight/TurnLeft as `aux_command` | PARITY-OK — `crates/holtburger-core/src/client/movement/move_to.rs:955` `if delta <= 20.0 || delta >= 340.0` → drop aux, else `:960-968` install TurnLeft/TurnRight |
| §5 | `GetCurrentDistance` uses `cylinder_distance` when the `use_spheres` bit is set, else `distance` | PARITY-OK — `move_to.rs` `current_distance` |
| §5 | `CheckProgressMade`: after 1.0 s, a closing rate under 0.25 u/s since the last sample **or** since the start loses progress | PARITY-OK — `move_to.rs:710-745` (both the `delta/elapsed < 0.25` and `original_delta/original_elapsed >= 0.25` arms), tested `:1274-1301` |
| §5 | `fail_distance` cancels with `0x3D`; loss of visibility gives `0x37` / `0x38` | PARITY-OK — `move_to.rs:82` `WE_OBJECT_GONE 0x37`, `:86` `WE_NO_OBJECT 0x38`, `:89` `WE_YOU_CHARGED_TOO_FAR 0x3D`, cancel at `:1001-1003` |
| §5 | `fail_progress_count` incremented in two places, zeroed in four, **never read** — dead code | TASK(PHY-22) |
| §5 | On sticky arrival, `BeginNextNode` calls `PositionManager::StickTo` | PARITY-OK — `crates/holtburger-world/src/spatial/position_manager.rs:1106` `stick_to`, install path documented at `:44-53` |
| §5 | **InterpolationManager**: `min(2 × max speed, MAX_INTERPOLATED_VELOCITY = 7.5)`; completes within 0.050000001; **every 5 frames** audits, under **30%** of theoretical closing rate fails via `node_fail_counter`+`NodeCompleted(0)` unless within **0.2 units** → `NodeCompleted(1)`; sticky bypasses the audit | PARITY-OK — `crates/holtburger-world/src/spatial/position_manager.rs:78` `PROGRESS_WINDOW_FRAMES = 5`, `:82` `MIN_PROGRESS_RATIO = 0.3`, `:70` `INTERPOLATION_QUEUE_CAP = 20` (retail `< 0x14`), `:401-411` the sticky audit bypass, `:24` `MAX_INTERPOLATED_VELOCITY` + `RECONCILE_DEADBAND_M` (0.05) imported from `force_position_interp.rs`; queue types Position/Snap/Velocity at `:86-99` and `node_fail_counter > 3` blipto recovery at `:11` |
| §5 | **StickyManager**: 0.30000001 standoff, `get_max_speed * 5.0`, 15.0 fallback, re-aims heading, `UseTime` drops on timeout | PARITY-OK — `position_manager.rs:59` `STICKY_RADIUS = 0.3`, `:63` `STICKY_TIME = 1.0`, `:719` "`speed = max_speed * 5.0`", `:749` `planar - my_radius - target_radius - STICKY_RADIUS` |
| §5 | **ConstraintManager** scales the offset by `(max − offset)/(max − start)`, hard-zeroes past max, accumulates the *post-scale* magnitude | PARITY-OK — `position_manager.rs:770-793` `ConstraintManager{constraint_start, constraint_max, constraint_pos_offset}`; chained after interpolation at `:542-544`; leash/max distances at `spatial/scene.rs:105-125` (5/10 start, 20/50 max) |
| §6 | `PhysicsScript` holds `PhysicsScriptData{start_time, CAnimHook*}` — **scripts reuse the animation hook vocabulary** | PARITY-OK — `crates/holtburger-dat/src/file_type/physics_script.rs`; the shared executor is `apps/holtburger-web/scene3d/script_manager.js:69-97` (`executeHook` seam into `_fireHook`) |
| §6 | `UpdateScripts` fires due hooks and chains `next_data`, so scripts can overlap | PARITY-OK — `script_manager.js:216-240` (drain-while loop, `addScript` chaining) |
| §6 | `play_script` → `PhysicsScriptTable::GetScript`, which hashes `type % m_numBuckets` and picks a variant by intensity; `PS_Invalid 0`, `PS_Launch 4`, `PS_Explode 5` | TASK(PHY-15) |
| §6 | `ParticleEmitterInfo` full field list; `BirthratePerSec_ET 1`/`BirthratePerMeter_ET 2`; particle types 0..0xC (12 real) | PARITY-OK — `apps/holtburger-web/scene3d/particles/particle_emitter_info.js` + `crates/holtburger-dat/src/file_type/` particle emitter parse |
| §6 | `Particle::Update` is genuinely **closed-form**: `parent + offset [+a·t] [+½b·t²] [+c]`, only `lifetime` accumulates; scale/translucency closed-form lerps on `lifetime/lifespan` | PARITY-OK — `apps/holtburger-web/scene3d/particles/particle.js`; determinism harness `apps/holtburger-web/scene3d/particles/time_rng.js:76` cites the `CPhysics::UseTime` pass |
| §6 | `ShouldEmitParticle` uses a distance delta from `last_emit_offset` for per-metre emitters | PARITY-OK — `apps/holtburger-web/scene3d/particles/particle_emitter.js` |
| §6 | `ShouldDrawParticles` gates degradation (`CYpt > degrade_distance`, direct compare, **no sphere slack**) | TASK(PHY-16) — implemented but default-OFF: `apps/holtburger-web/scene3d/particles/particle_manager.js:253-283` + the OR-term at `:614-620` gated on `particleDegradeRetailOn()` and a finite stamp (ctor Infinity) |
| §6 | Degraded branch does **not** keep advancing lifetimes: finite emitters compute lifetime once then `KillParticle` and stop; **infinite emitters reset every particle's birthtime to now**, freezing lifetime near zero; `Particle::Update` skipped either way | TASK(PHY-17) — `particle_manager.js:609-611` names the SetNoDraw/degraded_out contract but the finite-vs-infinite split is UNVERIFIED in our emitter |
| §7 | **DetectionManager** runs at **1 Hz** over a `LongNIHash<DetectionCylsphere>`; in-range is strict `<` on `object_radius + detcyl->radius`; returns `NoChangeDetection 0` / `EnteredDetection 1` / `LeftDetection 2` | TASK(PHY-03) — ABSENT; zero hits for `DetectionManager`/`detection_manager`/`EnteredDetection` anywhere in `crates/` or `apps/holtburger-web/{src,scene3d}` |
| §7 | **TargetManager**: `GetInterpolatedPosition` = `pos + velocity * quantum`, `voyeur_table` for subscribers | PARITY-OK-partial — `crates/holtburger-world/src/spatial/scene.rs:3677` "Minimal TargetManager-subset pose feed"; `position_manager.rs:611` records that retail `StickTo` registers with the TargetManager and ours uses an explicit feed instead. The `voyeur_table` publish/subscribe shape is deliberately not ported |
| §7 | `MoveToManager` calls `set_target_quantum(distance / speed)` on **more than 1 s** of drift | TASK(PHY-03b, folded into PHY-03) — `crates/holtburger-core/src/client/movement/move_to.rs:264` and `:933` both mark the TargetManager subscription/plumbing as N/A for our lane |
| §7 | Landblock streaming: `LScape::PreFetchCells` walks `(2·mid_radius+1)²` blocks, prefetches `blockid | 0xFFFF` as **type 1** (terrain+heightmap → `CLandBlock`), falling back to `(id & 0xFFFFFFFE) | 0xFFFE` as **type 2** (LandBlockInfo); individual cells arrive later via `CLandBlock::PreFetchCells` | TASK(PHY-24) |
| §7 | `LScape::update_loadpoint` rebuilds only on a real block shift; `CellManager::UpdateLoadPoint` gates on `(u16)objcell_id < 0x100` → **dungeons never stream landblocks** | TASK(PHY-25) |
| §7 | Progress reaches the UI through `ECM_DDD::SendNotice_RuntimeDDDStatus` (four call sites, all in `CellManager`) → `gmPowerbarUI::RecvNotice_RuntimeDDDStatus` | TASK(PHY-26) |
| §8 | The client is authoritative for its own motion; `SendMovementEvent` builds a **`MoveToStatePack`**, *not* an `AutonomousPositionPack`; the latter comes from `SendPositionEvent` / `ACCmdInterp::SendAutonomousPositionEvent` and carries position + contact flag + instance/server-control/teleport/force-position timestamps | PARITY-OK — `crates/holtburger-core/src/client/movement/common.rs:368-390` builds the turn/holdkey/speed state pack; `build_autonomous_position` imported at `movement/system.rs:5`; heartbeat interval const `AUTONOMOUS_POSITION_HEARTBEAT_INTERVAL` at `:2`. TASK(PHY-27) only for the send-path *audit* |
| §8 | Inbound state arrives as a `PhysicsDesc` applied by `unpack_movement`; `last_move_was_autonomous` distinguishes echoes | PARITY-OK — `apps/holtburger-web/src/lib.rs:540-596` (`Private/PublicUpdatePosition` routing), `movement/system.rs:405` `USE_AUTONOMOUS_POSITION_CHANGE_GATE = true` |
| §8 | Collisions reach game logic through `report_environment_collision` (gated on `state & 8`) and `report_object_collision`, carrying `EnvCollisionProfile` / `ObjCollisionProfile`; `REPORT_COLLISIONS_AS_ENVIRONMENT_PS` re-routes | TASK(PHY-02) — ABSENT (zero hits) |
| §8 | **The `collision_table` dedup is not in either reporter** — it lives in `track_object_collision`, which lazily allocates and reports only when `LongNIValHash::clobber` says the id was absent | TASK(PHY-02) (same task) |
| §9 | Hex-Rays substitutes string literals for large immediates (`0x800000` = `SLEDDING_PS` / `Vitae_EnchantmentType` / `MISSILE_AMMO_LOC`) | REF-ONLY — record in the decomp-reading README; note `apps/holtburger-web/scene3d/index.js:2619` already uses `0x800000` correctly as `MISSILE_AMMO` |
| §9 | `floor_z`'s `cos(3437.7467…)` is a real units bug, not decompiler damage | REF-ONLY (already honoured, see §3 row) |
| §9 | IDA's `= 0.0` on a global may be a BSS placeholder | REF-ONLY |
| §9 | Two IDA misnamings: `MD_Data_Fade::GetDuration` returns **framerate**; `PhysicsDesc::get_animframe_id` returns offset +20 = `low_frame`; `get_starting_frame`/`get_ending_frame` at 341016/341028 flip on negative framerate and bias by −0.00019999999 | TASK(PHY-31) |
| §9 | Some Hex-Rays output is reconstructed from FPU flags (`apply_physics` sign handling, `update_object`'s `while (!(v11|v12))`) | REF-ONLY |

## `03-object-model.md`

| § | Claim / subsection | Disposition |
|---|---|---|
| §1 | Every world object is two objects: `CPhysicsObj` + `CWeenieObject`; `ACCWeenieObject` is the concrete client weenie with `CObjectInventory`, `PositionState current_state`, embedded `PublicWeenieDesc pwd`, `ACWTimeStamper`, `PlayerDesc *m_pQualities` | PARITY-OK-by-design — holtburger collapses both halves into `crates/holtburger-world/src/entity.rs` `Entity` (+ `WorldState.player`); the split is a C++-lifetime artifact, not behaviour |
| §1 | `PublicWeenieDesc` is the broadcast stat block with a `BitfieldIndex` `_bitfield` and a cut-down `RestrictionDB _db`; wire format delta-encoded through **two** presence masks | PARITY-OK — `crates/holtburger-world/src/hydration.rs` `hydrate_from_pwd`; two-mask decode in `crates/holtburger-protocol/src/messages/object/` |
| §1 | `PlayerDesc : CACQualities : CBaseQualities` is allocated for **every** weenie in `ResetPlayerDesc` but stays mostly empty for non-players | REF-ONLY (allocation strategy, not behaviour) |
| §1 | `CObjectMaint` registries are **not** all the same container type (`LongHash` ×4, `HashSet` visible, `HashTable<ulong,double,0>` destruction, plus inventory/lost-cell/destruction-queue) | TASK(OBJ-38) |
| §1 | Creation: `SmartBox::HandleCreateObject` → `ACCObjectMaint::CreateObject`, which **recycles or builds** both halves, applies the WeenieDesc, cross-links, and for the player runs `init_player`/`enter_world` | TASK(OBJ-37) |
| §2 | `SmartBox` owns viewer Position, CameraManager, CellManager, CPhysics, CObjectMaint, LScape, Ambient, CommandInterpreter, `player_id`/`player`; 3-entry vtable ≈ `DispatchSmartBoxEvent` | TASK(OBJ-36) |
| §3 | `CBaseQualities` holds eight per-type `PackableHashTable`s; **struct order** `_weenie_type, int, int64, bool, float, string, DID, IID, Position` | PARITY-OK — `crates/holtburger-world/src/entity.rs` carries the eight typed maps |
| §3 | **Wire gate bits are a different order**: int `0x1`, bool `0x2`, float `0x4`, DID `0x8`, string `0x10`, Position `0x20`, IID `0x40`, int64 `0x80` | TASK(OBJ-28) |
| §3 | Property-ID literals table (`0x18` skill credits **in-binary**, `0x1E` buffed allegiance rank **in-binary**, `0x6A` Spellcraft, `0x6B`/`0x6C` item mana/max, `0x75` mana cost, `0xBC` heritage, `0xC7` house purchase time, `0x142` aetheria, `0x146`/`0x158`/`0x16D`/`0x17B` inferred) | TASK(OBJ-27) — **the doc's four inferred names are wrong**, and holtburger is right; see the task for the correction |
| §3 | `StatType` enum (`Undef 0` … `Num_StatTypes 0xF`) with `BodyDamageValue 0xA` / `BodyDamageVariance 0xB` / **`BodyArmorValue 0xC`** | TASK(OBJ-29) |
| §3 | `WTimeStamper` key masks are exactly `StatType << 16` | TASK(OBJ-29) (same task) |
| §3 | `CACQualities::SetPackHeader` sub-object bits `0x1` attribCache … `0x800` generator queue | REF-ONLY — record in the wire-format notes; holtburger's ingest is field-driven per message, not via a monolithic qualities blob |
| §4 | `Attribute` / `SecondaryAttribute` / `AttributeCache` / `Skill`; `SKILL_ADVANCEMENT_CLASS.SPECIALIZED = 0x3` | PARITY-OK — `crates/holtburger-core/src/client/{attribute_info,skill_info}.rs`; Specialized gating at `skill_info.rs:682-711` |
| §4 | `SkillFormula::Calculate` guarded on `_z != 0`: `level = floor((_w + attr2*_y + attr1*_x)/_z + 0.5)`; declaration order `{_w,_x,_y,_z,_attr1,_attr2}` | PARITY-OK — `crates/holtburger-core/src/client/skill_formula.rs` (a Chorizite port that also *fixes* the upstream inverted `HasAttribute2`, documented at `:11-17`) |
| §4 | `InqSkillBaseLevel` resolves via `DBObj::GetByEnum(4, 2, 0x10000004u)` — *not* `GetDIDFromEnumStatic` | REF-ONLY — a decomp-correction; holtburger loads SkillBase from the DAT directly |
| §4 | `InqSkill` adds **unconditionally**: `_init_level + _level_from_pp`, `0x16D`, and **+10** mastery (int 300 for `{0x29,0x2C,0x2D,0x2E,0x31}`, 301 for `{0x2F}`, 302 for `{0x1F,0x20,0x21,0x22,0x2B}`) | PARITY-OK — `crates/holtburger-core/src/client/skill_info.rs:194` `base += LumAugAllSkills` (= 0x16D = 365), `:197-201` `AugmentationSkilledMelee/Missile/Magic × 10` (= 300/301/302) |
| §4 | The `if (!raw)` block gates only `EnchantSkill`, **+5** for `0x146`, and **+2 ×** `0x158` when `_sac == 3`. So UI "base" still includes enlightenment and mastery | PARITY-OK — `skill_info.rs:231` `AugmentationJackOfAllTrades × 5` (= 0x146 = 326), `:292` `LumAugSkilledSpec × 2` (= 0x158 = 344) Specialized-only. TASK(OBJ-39) for the *display-semantics* note |
| §4 | **Vitals**: `InqAttribute2nd` adds `0x17B` only when `stype == 1`; `BoundsCheck` clamps even stypes to `InqAttribute2nd(stype − 1)` | PARITY-OK — `crates/holtburger-core/src/client/vital_info.rs:174` `max += GearMaxHealth` (= 0x17B = 379), Health-only |
| §4 | **XP** is table-driven: `ExperienceSystem` loads `DBObj::GetByEnum(3, 2, 0x10000009)` — a **type tag**, DID `0x0E000018`; `ExperienceTable` holds level/attribute/attribute2nd/trained/specialized/credit tables (`Credit_ExperienceType = 6`); `GetExperienceForLevel` is a bounds-checked index | TASK(OBJ-35) |
| §5 | The DID→DB_TYPE map, 15 rows, `DivineType_Internal` authoritative; **COMBAT_TABLE is bounded** `0x30000000`–`0x3000FFFF` (an earlier draft's open-ended `>=` would swallow MUTATE_FILTER) | TASK(OBJ-30) |
| §5 | Lookups go through `DBObj::GetByEnum` / `DBCache::GetDIDFromEnum` | REF-ONLY — holtburger's analog is `crates/holtburger-dat/src/well_known_ids.rs` (per-table DID constants, e.g. `enum_mapper::CHARACTER_TITLE = 0x22000041` at `:106`, `string_table::CHARACTER_TITLE = 0x2300000E` at `:147`) |
| §6 | Quality-update ordinals: RemoveInt…RemovePosition 465/466…477/478; RemoveInt64 696/697; UpdateInt 717/718 … UpdateAttribute2ndLevel 745/746; **UpdateString 725/726 (`0x2D5`/`0x2D6`)** routing through `HandleStringUpdateEvents` not `CM_Qualities` | PARITY-OK — every ordinal present: `crates/holtburger-protocol/src/opcodes.rs:216-242` (`PrivateRemoveIntEvent 0x01D1` … `RemovePositionEvent 0x01DE` = 465–478), `:244-246` (`0x02B8`/`0x02B9` = 696/697), `:105` `PrivateUpdatePropertyInt 0x02CD` (=717), `:122`/`:124` `Private/PublicUpdatePropertyString 0x02D5`/`0x02D6` (=725/726), `:130` `PrivateUpdatePropertyIid 0x02D9`. Unpack/pack wired at `messages/game_message/unpack.rs:253-260` and `pack.rs:300-306` |
| §6 | These are separate per-type instantiations with distinct timestamp masks (Skill `|0x40000`, Int `|0x10000`, Int64 `|0xE0000`, Bool `|0xD0000`, Float —) | TASK(OBJ-29) (masks) |
| §6 | **`OnStatUpdated` fires in seven instantiations, not two** (AttributeLevel, Attribute2ndLevel, SkillLevel, Int, Bool, DataID, InstanceID) | TASK(OBJ-33) |
| §6 | `WTimeStamper` / `ACWTimeStamper` hold a `PHashTable<ulong,uchar>` plus `char _house_ts`; the derived class adds nothing | REF-ONLY |
| §7 | `CObjectInventory` = `IDList _itemsList`, `IDList _containersList`, `PackableList<InventoryPlacement>` | TASK(OBJ-34) |
| §7 | Driven by `ViewObjectContents` / `UpdateObjectInventory`, or by WeenieDesc rewrites and `ServerSaysContainID` | PARITY-OK — `crates/holtburger-world/src/handlers/inventory.rs` + `crates/holtburger-world/src/events.rs:42` equipment map |
| §7 | `INVENTORY_LOC` composites: `CLOTHING_LOC 0x080001FF`, `ARMOR_LOC 0x00007E00`, `JEWELRY_LOC 0x7C0F8000`, `WEAPON_LOC 0x02500000`, `READY_SLOT_LOC 0x03F00000`, `WEAPON_READY_SLOT_LOC 0x03500000`, `SIGIL_LOC 0x70000000`, `ALL_LOC 0x7FFFFFFF` | TASK(OBJ-01), TASK(OBJ-02) — `JEWELRY` and the single-slot bits match (`crates/holtburger-common/src/properties/inventory.rs:160-190`, `:248`), but `CLOTHING` (`:246`) and `ARMOR` (`:247`) are both wrong |
| §7 | `InventoryRequest` runs `IR_NONE` … `IR_SHOP_EVENT (0xA)` | REF-ONLY |
| §7 | Wield requirements (`GetAppraisalStringFromRequirements`): types **1, 2, and 8** all resolve as skill names; 3/4 attribute; 5/6 vital; 7 level; 9/10 int property; 11 creature type; 12 heritage. `"base "` prefix on 2, 4, 6. Int 287/288/289 → Celestial Hand / Eldrytch Web / Radiant Blood | TASK(OBJ-07) |
| §8 | `ObjDesc : VisualDesc` = base palette + `Subpalette` / `TextureMapChange` / `AnimPartChange` lists; `ClothingTable::BuildObjDesc` feeds char-gen preview and the barber; **in world the server sends complete ObjDescs** | PARITY-OK — `apps/holtburger-web/src/lib.rs:5843-5846` ("ships the resulting … no need to walk inventory or parse ClothingTable — it just applies what [the server sent]"), `:11689` `ClothingTable` fetch for dye/barber; the `BuildObjDesc` raw-offset semantics are honoured at `:11864-11865` ("no /8") |
| §8 | `AppraisalProfile`: **six** stat tables (no IID, no Position), optional Creature/Hook/Weapon/Armor profiles, `_spellBook`, three highlight bitfields, **nine `base_armor_*` ints** in order head, chest, groin, bicep, wrist, hand, thigh, shin, foot | TASK(OBJ-06) — the three highlight bitfields and `spellBook` are carried (`crates/holtburger-world/src/entity.rs:910-914`, `apps/holtburger-web/src/lib.rs:25715-25720`); the nine-slot `base_armor_*` array is UNVERIFIED/ABSENT |
| §8 | **Spell IDs carry a bit-31 tag**: `id & 0x80000000` routes to "Enchantments:", clear → "Spell Descriptions:"; `Appraisal_ShowShortMagicInfo` skips high-bit entries | TASK(OBJ-03), TASK(OBJ-04) — `apps/holtburger-web/src/lib.rs:30534-30536` *strips* the bit before lookup; the routing split is ABSENT |
| §8 | Names resolve via `GetSpellName`/`GetSpellDescription` → `CSpellTable::InqSpellBase`; the player's own `CSpellBook` is **never consulted here** | PARITY-OK — `apps/holtburger-web/data/spells-catalog.json` + `holtburger_world::spell::SpellCatalog::get`, keyed by id not by spellbook |
| §8 | Highlight bitfields: low bit = modified/lowered, same bit `<<16` = raised. **Decode lives in `InqIntEnchantmentMod`/`InqFloatEnchantmentMod`**, not in `Appraisal_ShowArmorMods` (which only picks `mod_high_font` vs `mod_low_font`) | TASK(OBJ-05) |
| §8 | `ArmorEnchantment_BFIndex` (level + 8 damage types); `WeaponEnchantment_BFIndex` (offense, defense, time, damage, variance, mod); `ResistanceEnchantment_BFIndex` **15 low bits, 13 resistances** + `BF_MANA_CON_MOD 0x1000` + `BF_ELE_DAMAGE_MOD 0x2000` | TASK(OBJ-05) (same task) |
| §9 | Allegiance data types; rank is server-supplied; `_loyalty`/`_leadership` unpacked and **never used**, wire-packed **16-bit** despite `unsigned int` decl | TASK(OBJ-09) |
| §9 | Titles come from **17** hardcoded switch functions (`AllegianceSystem::GetTitle`); the extra two beyond male/female pairing are the male-only Gearknight/Tumerok/Lugian set. Aluvian male 1–10: Yeoman, Baronet, Baron, Reeve, Thane, Ealdor, Duke, Aetheling, King, High King | TASK(OBJ-08) — ABSENT; grep for `Yeoman`/`Baronet`/`Aetheling` across `crates/` + `apps/holtburger-web/{plugins,ui,src,index.html}` returns nothing. `apps/holtburger-web/plugins/allegiance-panel.js:605` renders a bare numeric rank (`[3]`) or `rank + officerName` |
| §9 | `AllegianceHierarchy::UnPack` gates every field on version (`AllegianceVersion` 1..11) | UNVERIFIED — `crates/holtburger-protocol/src/messages/allegiance/` exists; per-version gating not read |
| §9 | `gmAllegianceUI::UpdatePlayerData` reads int `0x1E`, switching to `ID_Allegiance_RankBuffed` when it differs from base and is not −1; `UpdateVassalsData` renders `_cp_tithed` | TASK(OBJ-08) (same task — the buffed-rank swap is the display rule) |
| §9 | `ChannelSystem::GetChannelID` ~18 entries; allegiance `0x2000000`, co-vassals `0x1000000`, monarch `0x4000`, patron `0x2000`, vassals `0x1000`, fellowship `0x800` | TASK(OBJ-10) |
| §9 | Fellowship cap is **9**; `GetEvenSplitXPPctg` literal table 1.0 / 0.75 / 0.60000002 / 0.55000001 / 0.5 / 0.44999999 / 0.40000001 / 0.34999999 / 0.31111109 / 0.28, default 0.0 | N/A-WEB (mostly) — XP split is server authority in ACE; TASK(OBJ-11) covers the *display* value only |
| §9 | `RecalculateEvenXPSplitting` gated on `_share_xp`; **only if the lowest member is under level 50** it applies **two independent** kills, both against the **leader's** level: `max > leader + 5 → 0` and `min + 5 < leader → 0` | TASK(OBJ-11) |
| §9 | Fellowship opcodes: inbound 702/703/704; outbound 162,163,164,165,166,656,657 | PARITY-OK — `crates/holtburger-protocol/src/opcodes.rs:781` `FellowshipFullUpdate 0x02BE` (=702) plus the fellowship action set in `messages/game_action.rs` |
| §9 | Housing types 1 cottage / 2 villa / 3 mansion / 4 apartment; rent **7776000.0 s** (90 d) apartments, **2592000.0** (30 d) otherwise; purchase cooldown literal 2592000 | TASK(OBJ-12) — ABSENT (no hits for either literal) |
| §9 | `RestrictionDB` with `IsAllowedIn`; `GuestInfo` storage permission is **per-guest**; 21 `CM_House::Event_*` opcodes (BuyHouse 540, AbandonHouse 543, RentHouse 545, SetOpenHouseStatus 583, ChangeStoragePermission 585, TeleToHouse 610, SetHooksVisibility 614, ListAvailableHouses 624) | TASK(OBJ-12) (same task) |
| §9 | `CContract` stores quest flags as **strings**; `CContractTable` fetched with `GetByEnum(23, 2, 0x10000010)` | REF-ONLY |
| §9 | `gmContractsUI::FillProgressString` decodes `_contract_stage`: 1 Available, 2 In Progress, **3 has three outcomes** (Done / `Done (<delta> to Repeat)` / Available once expired), `>= 4` is a progress counter rendered as `stage − 4` | TASK(OBJ-13) |
| §9 | `QuestTable`/`QuestProfile` have **zero occurrences** in `acclient.c`; the `questflag` hits are `CContract` string members | REF-ONLY (a useful negative — don't go looking for a client quest table) |
| §9 | `CharacterTitleTable` is `{unsigned mDisplayTitle; PList<ulong> mTitleList}` — a **list, not a bitfield**; `Pack` writes literal 1, the display title, then the packed list; names resolve through `EnumMapper::GetString(0x10000006, …)` into string table `0x10000007` | TASK(OBJ-14) |
| §9 | `PageData`/`PageDataList`; `PackNoText`; `UnPack` with a version escape; books arrive on `0xB4` using a **stack-local** `PageDataList` | TASK(OBJ-15) — the *actions* exist (`crates/holtburger-protocol/src/messages/game_action.rs:111-115` BookPageData/BookData/BookAddPage/BookModifyPage/BookDeletePage); the inbound `0xB4` `PageDataList` read is UNVERIFIED |
| §10 | **`Body` has zero readers.** `PackableHashTable<long,BodyPart>::lookup` returns nothing; across 109 references every one is ctor/dtor/Pack/pack_size/UnPack/null-check. The `0x1B2` `part` argument arrives straight off the wire, so `Body`, `BodyPart`, `ArmorCache`, `BodyPartSelectionData` are read by nothing | REF-ONLY — a strong negative: do **not** invest in a client-side body-part table. Record in `docs/`. |
| §10 | `BodyPartEnumMapper::BodyPartToString` switches on `bp + 1`; map includes `−1 UNDEFINED`, 0–23, **24 UPPER_TENTACLE**, **25 LOWER_TENTACLE**, 26 CLOAK, 27 NUM; gaps at 11 and 14 are genuine | TASK(OBJ-16) |
| §10 | `CEmoteTable` is **store-only** — allocated, unpacked, freed, null-checked, serialized, never looked up or iterated; the only content inspection is `Emote::IsValid` inside `Emote::UnPack` | PARITY-OK-by-divergence — holtburger deliberately went *further* than retail: `apps/holtburger-web/src/lib.rs:54700-54728` exposes a `CEmoteTable` **taxonomy bridge** ("NOT a DAT file"; wire parser at `crates/holtburger-protocol/src/messages/emote_table.rs`). Reading it is a client-side improvement, not a parity gap |
| §10 | `EmoteSet::UnPack` category semantics (1/6 classID; 5 style+substyle; 2 vendorType; `0xC`,`0xD`,`0x16`,`0x17`, run `0x1B`–`0x26` quest string; `0xF` min/max health floats); `Emote::UnPack` switches on **114** distinct case labels | TASK(OBJ-17) |
| §10 | `CreationProfile::UnPack` fixes the wire layout at **24 bytes** — `wcid, palette, shade (float), destination, stack_size, try_to_bond`; the **C++ layout differs** (`try_to_bond` at +8 but serializes last) | TASK(OBJ-18) |
| §10 | `_create_list` is store-only, but **`Emote::cprof` IS read** by `Emote::IsValid` (`cprof.wcid.id`, `cprof.stack_size`) and by `Emote::UnPack` for size computation — validate-and-serialize only, but "never read" is too strong | REF-ONLY (correction to an earlier draft; folded into OBJ-17/OBJ-18) |
| §11 | `PlayerModule`: `shortCuts_[18]` of `ShortCutData{index_, objectID_, spellID_}`; `favorite_spells_[8]`; desired comps; `options_`; `options2_`; `spell_filters_`; `m_pPlayerOptionsData` (a `GenericQualitiesData*`); `m_colGameplayOptions`; `m_TimeStampFormat` | PARITY-OK-partial — shortcuts wired (`apps/holtburger-web/src/lib.rs:18102` `shortcuts: Vec::new()`, `:22899-22915` Add/RemoveShortcut game actions); TASK(OBJ-19)/(OBJ-23)/(OBJ-24) for the rest |
| §11 | `Default_CharacterOption = 0x50C4A54A` (top member `UseCraftSuccessDialog 0x80000000`, also `AutoAcceptFellowRequest 0x20000000`); `Default_CharacterOptions2 = 0x948700`; ctor assigns 1355064650 / 9733888 / `spell_filters_ = 0x3FFF` | TASK(OBJ-20) — `apps/holtburger-web/src/lib.rs:18100-18101` initialises both masks to `empty()`, i.e. all-zero, not the retail defaults |
| §11 | `PlayerOption` covers `0x00`–`0x33` with `TotalNumberOfPlayerOptions = 0x34`; `AddShortCut` / `SetToggleRun` | TASK(OBJ-22) — a subset is modelled (`crates/holtburger-common/src/character.rs:39,73,90`; `RunAsDefaultMovement 0x0A` read at `apps/holtburger-web/scene3d/input.js:85,153-169`; `UseFastMissiles 0x2B` at `scene3d/picking.js:1161-1168`) |
| §11 | **`GetDefaultOptionValue` is not the decomposition of the two masks**: the masks set **19** bits (12+7) but it returns 1 for only **16**; the three defaulted-on options it returns **0** for are `ConfirmVolatileRareUse (0x2D)`, `ShowHelm (0x2F)`, `ShowCloak (0x32)` | TASK(OBJ-21) |
| §11 | `GenericQualitiesData`: four optional tables, 4-bit header (int 1, bool 2, float 4, string 8); the `CEnchantmentRegistry::pack_size` call there is an IDA mislabel. **Exactly one key is used client-side**: string key `1`, the timestamp format | TASK(OBJ-23) |
| §11 | `m_colGameplayOptions` is a `PackObjPropertyCollection` with 23 in-place buckets over an **`IntrusiveHashTable`**; the option set is **DAT-driven** (`InqGameplayOptionProperty` reads DBObj enum 21 / hash key 210; defaults from enum 22). Known props: `0x1000007F` chat text-type filter, `0x10000080`/`0x81` opacity, `0x10000086`–`0x89` window geometry, `0x1000008C` chat-option struct array | TASK(OBJ-24) |
| §11 | Wire evolution `SetPackHeader`/`UnPack` bits: `0x1` shortcuts, `0x4` 5 fav-spell lists, `0x8` desired comps, `0x10` 7 fav-spell lists, `0x20` spell filters (absent ⇒ `0x3FFF`), `0x40` options2 (absent ⇒ 9733888), **`0x80` timestamp format (read-only legacy, never set)**, `0x100` GenericQualitiesData, `0x200` gameplay options, **`0x400` 8 fav-spell lists** | TASK(OBJ-19) |
| §11 | Ships via `Event_CharacterOptionsEvent`, opcode **417** (`0x1A1`), on a **480-second** dirty flush | TASK(OBJ-25) |
| §11 | `CPlayerModule::OnChanged` has **six** switch arms plus a tail: 5 → `LScape::SetDay`, 4 → `SmartBox::EnableWeather(v4 == 0)`, `0x30` → `LScape::m_fFogEnabled`, 7 → `ClientCombatSystem::TrackTarget`, 2 (IgnoreFellowshipRequests clears auto-accept), `0x12` (auto-accept clears ignore), plus an `IsAutoSaveOption` path that fires `Event_PlayerOptionChangedEvent` immediately | TASK(OBJ-26) |
| §12 | IDA mislabels fields inside `CACQualities::UnPack` (emote table allocated under `_boolStatsTable`, create list under `_floatStatsTable`) — trust `SetPackHeader` and the `operator new` sizes | REF-ONLY |
| §12 | Type tags look like DIDs (`0x10000004`, `0x10000009` are DB_TYPE constants) | REF-ONLY — folded into TASK(OBJ-30) |
| §12 | Pack-header bit order is not field order; `PlayerModule`'s bits are not in numeric feature order | REF-ONLY — folded into TASK(OBJ-28)/(OBJ-19) |
| §12 | Not everything unpacked is used (`Body`, `CEmoteTable`, `_create_list`, `QuestTable`) | REF-ONLY |
| §12 | Property names are inferred; only `0x18` and `0x1E` have in-binary corroboration | TASK(OBJ-27) |
| §12 | "Not re-verified in the third pass" list (gameplay-property names, sub-properties 212/213/214, `GetObjectName` pluralization/"Backpack" substitution, `EnchantInt`/`EnchantFloat` virtual family, `CFactory::MakeCWeenieObject`, `ServerSaysMoveItem`) | REF-ONLY — see OPEN QUESTIONS 6 |

---

# PART 2 — TASKS

## Physics / collision / movement / animation

### PHY-01 — Restitution impulse: `elasticity` is stored and never used
- **Source**: `01-physics.md` §2 "The impulse solver".
- **Retail**: `handle_all_collisions` (acclient.c:321808) applies a genuine restitution impulse at :321876-321886 — `v13 = v·n; v14 = -(v13 * (elasticity + 1.0)); v += v14 * n`. Four guards: the whole block requires `frames_stationary_fall <= 1` (:321863, above that velocity is zeroed unconditionally at :321891-321894 regardless of elasticity); requires `collisions->collision_normal_valid` (:321865); the impulse applies only when `v·n < 0.0` (:321879, i.e. approaching); `INELASTIC_PS (0x20000)` zeroes velocity instead of bouncing (:321867-321872). Bounce is suppressed when the object was and remains on walkable ground **unless** `SLEDDING_PS` (:321829-321832) — which is what makes sledding a distinct mode.
- **Holtburger**: the value is parsed and stored but never consumed. `crates/holtburger-world/src/hydration.rs:238` `if let Some(v) = odd.elasticity { self.floats.insert(PropertyFloat::Elasticity, ...) }` and `:288-291` `PropertyBool::Inelastic` from `PhysicsState::INELASTIC`. Grep for `elasticity|restitution|collision_normal_valid` across `crates/holtburger-{core,world}/src` (excluding tests) returns only these two hydration sites. **ABSENT** — no solver reads either.
- **Proposed change**: add a `handle_all_collisions`-equivalent post-commit step in `crates/holtburger-world/src/spatial/transition.rs` (or the faithful bridge's outcome marshal) that applies the impulse using the hydrated `Elasticity` float and the transition's collision normal, honouring all four guards. Ship behind `USE_COLLISION_IMPULSE` (native const + `?collisionImpulse=on`) per the house two-carrier convention.
- **Payoff**: fidelity + gameplay. Today thrown/dropped objects, missiles hitting walls and sledding all lose their retail feel; a bouncing item just stops dead. Also unblocks PHY-13 (sledding is only distinguishable once bounce suppression has an escape).
- **Effort**: M (the normal and `frames_stationary_fall` are already marshalled out of the transition — see `spatial/transition.rs:378-385`).
- **Validation**: `__diag.physics` drift ring already samples per applied frame; add a bounce counter. Headless: `?nullRender=1&autoLogin=1`, drop an item off a ledge and assert a sign flip in `v·n`. A/B `?collisionImpulse=on|off` on the same seed.

### PHY-02 — Collision reporting to game logic + `collision_table` dedup
- **Source**: `01-physics.md` §8.
- **Retail**: `report_environment_collision` (320194, gated on `state & 8` = `REPORT_COLLISIONS_PS` at :320207) and `report_object_collision` (320228) carry `EnvCollisionProfile` / `ObjCollisionProfile`. `REPORT_COLLISIONS_AS_ENVIRONMENT_PS` re-routes at :320249-320251. Crucially, **the dedup is not in either reporter**: it lives in `CPhysicsObj::track_object_collision` (321217), which lazily allocates the table (:321234-321241) and calls `report_object_collision` only when `LongNIValHash::clobber` reports the id was **absent** (:321249-321252).
- **Holtburger**: **ABSENT**. Grep for `track_object_collision|collision_table|report_object_collision|report_environment_collision|ObjCollisionProfile|EnvCollisionProfile` across `crates/` + `apps/holtburger-web/{src,scene3d}` returns zero hits. The `PhysicsState` bits exist (`crates/holtburger-common/src/properties/object.rs`) and are hydrated to `PropertyBool::ReportCollisions` / `ScriptedCollision` / `ReportCollisionsAsEnvironment` (`hydration.rs:266-290`) but nothing reads them.
- **Proposed change**: emit a `ClientEvent::Collision { other_guid | environment, normal, velocity }` from the transition outcome, with a per-mover `collision_table` HashSet cleared on cell change (retail's clobber semantics). Wire it to (a) collision SFX, (b) `ScriptedCollision` PhysicsScript play, (c) the ACE-side collision report if/when the server wants it.
- **Payoff**: correctness + fidelity. Bumping into an NPC or a door produces no feedback at all today; scripted-collision content (traps, pressure plates rendered client-side) is silent. The dedup is what stops one frame of contact from firing 30 sounds/second.
- **Effort**: M.
- **Validation**: new `__diag.physics.collisions` counter; headless walk into a known door in the Academy and assert exactly one event per contact episode (the dedup test), plus a re-fire after leaving and re-entering.

### PHY-03 — `DetectionManager` (1 Hz enter/leave detection) + `TargetManager` quantum
- **Source**: `01-physics.md` §7.
- **Retail**: `DetectionManager` runs at **1 Hz** — gate at acclient.c:327688 — over a `LongNIHash<DetectionCylsphere>`. The range test at :327037 is `if (object_radius + detcyl->radius <= distance)` → *out of range*, so in-range is strict `<`. Returns `NoChangeDetection 0`, `EnteredDetection 1`, `LeftDetection 2`. Separately, `MoveToManager` calls `set_target_quantum(distance / speed)` once drift exceeds 1 s (:345703-345704), and `TargetManager::GetInterpolatedPosition` (328131) is `pos + velocity * quantum` with a `voyeur_table` of subscribers.
- **Holtburger**: **ABSENT** for DetectionManager (zero hits for `DetectionManager|detection_manager|EnteredDetection|LeftDetection`). TargetManager exists only as an explicit push feed, deliberately: `crates/holtburger-world/src/spatial/scene.rs:3677` "Minimal TargetManager-subset pose feed", `crates/holtburger-core/src/client/movement/move_to.rs:264` "TargetManager subscription that fed `HandleUpdateTarget`. Our [replacement]" and `:933` "plumbing for the retail TargetManager — N/A here".
- **Proposed change**: add a 1 Hz cylsphere detection pass over resident entities producing Entered/Left events. This is the natural owner for: nameplate fade-in/out hysteresis, aggro-range UI hints, proximity-triggered ambient sound, and the `set_target_quantum` adaptive-drift term for MoveTo pursuit. Keep it at 1 Hz — the low rate *is* the design.
- **Payoff**: fidelity + perf (a 1 Hz pass replaces several per-frame distance scans scattered through `entities.js`/`nameplate_sprite.js`).
- **Effort**: M.
- **Validation**: `__diag.motion` / new `__diag.detect` surface listing current in-range set; headless `@teleploi` hop and assert Entered/Left pairs balance. A-B the nameplate pop-in behaviour on the 1070.

### PHY-04 — Entity tick-cull radius is 120 m; retail's is 96
- **Source**: `01-physics.md` §2 "Activity culling".
- **Retail**: `update_object` (323081) tests `v4 > 96.0 && CPhysicsObj::obj_maint->is_active` at :323114 and clears `ACTIVE_TS` at :323115. The doc's third pass establishes that `is_active` is set in the `CObjectMaint` ctor (310043) and cleared in exactly one place, `if (testMode != 0)` at 146213 — so **in shipped play the 96-unit cull is always on**; there is no gameplay-visible mode where it is off.
- **Holtburger**: `apps/holtburger-web/scene3d/entities.js:1948-1956` `MAX_TICK_DIST` defaults to **120** m (`?maxTickDist=<metres>` tunes it), `:1957` `MAX_TICK_DIST_SQ = 14400`. A separate 96 m constant exists but for a different purpose — `crates/holtburger-world/src/spatial/scene.rs:139` `REMOTE_INTERP_PLAYER_RADIUS_M = 96.0` (the `MoveOrTeleport` hard-set gate, acclient.c:323483-323489).
- **Proposed change**: change the `MAX_TICK_DIST` default from 120 to 96 and cite acclient.c:323114 in the comment; keep `?maxTickDist` as the escape. Optionally hoist the constant so the two 96s share one definition with distinct doc comments.
- **Payoff**: perf (≈36% less culled-band area ticked: 96²/120² = 0.64) + fidelity (matches the radius at which retail stopped simulating, which is what content was authored against).
- **Effort**: S.
- **Validation**: A/B `?maxTickDist=96` vs `=120` in a busy town with `renderer.info.autoReset = false` and the cumulative-count diff protocol; assert `__diag.render` frame time drops and no visible pop at the boundary (re-entry snap is the risk).

### PHY-05 — `ACTIVE_TS` self-deactivation for stationary, manager-less objects
- **Source**: `01-physics.md` §2 "Activity culling".
- **Retail**: `ACTIVE_TS` matters more broadly than the distance cull. `UpdateObjectInternal` runs its **entire body** only for active objects (gate at :322758), and `UpdatePhysicsInternal` **self-deactivates** a stationary object that has no `movement_manager` (:317731-317735). So a settled barrel costs nothing per frame until something wakes it.
- **Holtburger**: **ABSENT**. `TransientState`'s CONTACT / ON_WALKABLE / STATIONARY_FALL analogs exist (`crates/holtburger-world/src/player/types.rs:1609`, `crates/holtburger-world/src/spatial/transition.rs:61-67`) but there is no `ACTIVE` bit and no sleep/wake. The only gating is the distance cull (PHY-04) and the animated-scenery distance cull (`apps/holtburger-web/scene3d/animated_scenery.js:934-965`).
- **Proposed change**: add an `active` flag per spatial body. Clear it when velocity ≈ 0, `CONTACT|ON_WALKABLE`, and no movement/position/sticky manager is live; set it on any velocity/force/manager install, cell change, or inbound position pack. Gate the per-tick transition solve on it.
- **Payoff**: perf. This is the retail residency trick that lets thousands of resident objects cost nothing — complements the `landblock_lru` / `fixed_grid` work rather than duplicating it (that work parks *geometry*; this parks *simulation*).
- **Effort**: M.
- **Validation**: `__diag.physics` active-vs-resident count; A/B in a dense dungeon; assert an object that is pushed still wakes (the correctness risk is a stuck sleeper).

### PHY-06 — `calc_num_steps` viewer arm (`floor+1`) is unimplemented, and the local player IS the viewer
- **Source**: `01-physics.md` §3 "Sub-stepping".
- **Retail**: `find_transitional_position` (313171) divides displacement using `calc_num_steps` (311764): `floor(dist/radius)+1` when `object_info.state & 4`, otherwise `ceil(dist/radius)` (:311796-311835). Bit `0x4` is `IS_VIEWER_OI` (`ObjectInfoEnum`, acclient.h:6182) — "the viewer gets one extra step". The last step carries the remainder (:313245-313262).
- **Holtburger**: `crates/holtburger-world/src/spatial/transition.rs:388-395` `calc_num_steps` implements the **non-viewer arm only** ("Retail `CTransition::calc_num_steps` non-viewer arm … (`state & IS_VIEWER`, floor+1 with last-step remainder) is [not implemented]"), and `:33` states plainly: "A6-T4 camera (RULINGS §1 parked — the viewer arm of `calc_num_steps` is NOT implemented)". The bit itself is defined (`:63` `IS_VIEWER: u32 = 0x4`) and threaded (`:766`).
- **Proposed change**: implement the viewer arm. `floor(d/r)+1` vs `ceil(d/r)` differ whenever `d/r` is an exact multiple *and* — more importantly — the viewer arm's per-step offset is `d/(floor+1)` with the remainder on the last step rather than `d/ceil` uniform, which changes *where* each intermediate insert lands. For a run tick at 4.4 m/s ÷ 30 Hz ≈ 0.147 m against r 0.48 both give 1 step; at the 0.2 s slice (0.88 m) retail gives 2 steps, ours gives 2 — so the divergence bites on long slices and on jump/knockback displacements.
- **Payoff**: fidelity (anti-tunnelling parity on exactly the object the player feels). Low risk: strictly more or equal substeps.
- **Effort**: S.
- **Validation**: unit tests beside `transition.rs:1344-1355` (`calc_num_steps_sub_radius_is_single_step`, `_run_tick_is_two_steps`) with the viewer bit set; then a headless jump-into-wall probe (`test_ac_jump_clip_plays.mjs` neighbourhood).

### PHY-07 — `USE_FAITHFUL_ENTITY_COLLISION` is default-off: dynamic entities never block the player
- **Source**: `01-physics.md` §3 "Per-cell dispatch" (`find_obj_collisions` 347142 → `CSphere::intersects_sphere` 359157).
- **Retail**: `CObjCell::find_obj_collisions` sweeps resident **dynamic** objects as part of every cell's collision dispatch, alongside env BSP and building/sort-cell geometry.
- **Holtburger**: `crates/holtburger-core/src/client/movement/system.rs:750` `const USE_FAITHFUL_ENTITY_COLLISION: bool = false;` with the doc block at `:726-749` naming the gap precisely: "The faithful branch … collides ONLY the cell env-BSP + baked cell statics; dynamic entities (doors, monsters, players) **NEVER block the local player** there — a parity gap versus retail". Ethereal exemption is already free via `Entity::is_collidable`, and the clamp is written (`holtburger_world::spatial::clamp_delta_against_entities`).
- **Proposed change**: flip to `true` after the A/B. Everything is built; only the promotion gate remains. Note the pinned invariant — the clamp touches the XY residual only, so grounding cannot be corrupted.
- **Payoff**: correctness. Today the player walks through closed doors and through other players; this is probably the single most visible remaining physics divergence.
- **Effort**: S (flip + eye-test) — the code exists.
- **Validation**: headless probe against a CLOSED Academy door (assert blocked) and the same door OPEN/ethereal (assert pass-through); `?faithfulEntityCollision=on|off` A/B for fps.

### PHY-08 — `MAX_QUANTUM` is 0.1 (ACE) not 0.2 (retail); `USE_RETAIL_QUANTUM` is off
- **Source**: `01-physics.md` §2 "Time quantization".
- **Retail**: acclient.c:323123-323144 — dt must exceed `0.00019999999` or it is a resync; dt above 2.0 is discarded; then `if (v6 <= MAX_QUANTUM_97) goto LABEL_21` — **a dt smaller than MAX_QUANTUM is stepped whole, with no MIN_QUANTUM test at all**. The `MIN_QUANTUM_97` test at :323138 gates only the remainder after the full-quantum loop. Live initializers: `MIN_QUANTUM_97 = 1.0/30.0` (:784229) and `MAX_QUANTUM_97 = 1.0/5.0` (:784235). Verified in the raw decomp: `acclient.c:784235: MAX_QUANTUM_97 = 1.0 / 5.0;`.
- **Holtburger**: the retail shape **is** ported but off. `crates/holtburger-core/src/client/movement/common.rs:761` `RETAIL_MAX_QUANTUM: f32 = 0.2` with the correct semantics quoted at `:755-760`; `:753` `PHYSICS_ENTRY_EPSILON = 0.0002`; `crates/holtburger-core/src/client/movement/system.rs:493-516` documents the retail loop exactly (entry epsilon consumed, HugeQuantum consumed, `dt <= 0.2` direct with **no 1/30 floor**, else 0.2 slices with the remainder carried) and then sets `const USE_RETAIL_QUANTUM: bool = false;`. Shipped value: `crates/holtburger-world/src/spatial/collision.rs:82` `MAX_QUANTUM: f32 = 0.1` ("ACE: 0.1"), asserted at `:703`.
- **Proposed change**: this is a **documented deliberate divergence** (`apps/holtburger-web/docs/2026-06-11-unification-survey/DECISIONS-A1-O5-constants.md`, the "0.1 slices to dodge ACE's documented MoveToManager-turning bug at 0.2" ruling). The task is to **reopen the ruling with the decomp evidence in hand** — retail runs 0.2 and does *not* have the ACE turning bug, so the bug is ACE's port, not the constant. Path: (1) add the `move_to.rs` turn-deadband regression at 0.2 s slices that `system.rs:511` names as the precondition; (2) flip `USE_RETAIL_QUANTUM = true`; (3) A/B feel.
- **Payoff**: fidelity. Also removes a second source of truth (two quantum shapes, one dead).
- **Effort**: M (mostly the regression test + eye-test, not code).
- **Validation**: the named `move_to.rs` turn-deadband regression; `__diag.physics` drift p99 across a fixed route with `?retailQuantum=on|off`; 1070 feel-test.

### PHY-09 — `cached_velocity` is never maintained
- **Source**: `01-physics.md` §2 "The update chain".
- **Retail**: on a successful transition `cached_velocity = offset / quantum` (:322816-322828) and `SetPositionInternal` commits; on failure the position is restored and `cached_velocity` **zeroed** (:322833-322845). It is a `CPhysicsObj` member (acclient.h:30689 member list) and is the realized-velocity source distinct from `m_velocityVector`.
- **Holtburger**: **ABSENT** — zero hits for `cached_velocity|cachedVelocity` anywhere.
- **Proposed change**: expose realized velocity (`offset / quantum`, zeroed on a failed transition) from the transition outcome. It is the correct input for: footstep-cadence selection, the `SLEDDING` yaw-align (PHY-12), the anti-ice-skating rig speed match, and any "am I actually moving" UI predicate — all of which currently read *intended* velocity and therefore lie when the mover is blocked against a wall.
- **Payoff**: correctness (walking into a wall currently keeps the run animation and footsteps playing at full rate).
- **Effort**: S.
- **Validation**: `__diag.motion` realized-vs-intended speed pair; headless walk into a wall and assert realized → 0 while intended stays 4.4.

### PHY-10 — MotionTable `modifiers` table is parsed and never applied
- **Source**: `01-physics.md` §5 "The motion table".
- **Retail**: `CMotionTable` is four hash tables — `style_defaults`, `cycles`, `modifiers`, `links`. `re_modify` (337286), `change_cycle_speed` (337269), `subtract_motion` (337506) and `combine_motion` (337477) **retune a running sequence rather than restarting it**.
- **Holtburger**: parsed at `crates/holtburger-dat/src/file_type/motion_table.rs:52` `pub modifiers: HashMap<u32, MotionData>` and `:67`, with an explicit deferral at `:26-52`: all 1,222 modifier entries are anim-free (0 anims), they are motion class `0x20000000`, "Retail applies them via `combine_motion` … switch by `re_modify` (acclient.c:337286) so a turn keeps its angular [velocity]" and "integration of these modifiers (per-entity MotionState + `combine_motion` + `re_modify` + dual-source reconciliation = 'Path B') **remains deferred**".
- **Proposed change**: implement Path B. The visible symptom the file itself names is a creature that should keep its angular velocity while transitioning between cycles; today a modifier-carried turn is dropped, so turning creatures step through their facing rather than sweeping (see also `apps/holtburger-web/scene3d/entities.js:450-473`, which papers over this with a hardcoded "human TurnRight cycle ≈ 3 rad/s" stand-in and a snap threshold at `:5344`).
- **Payoff**: fidelity — removes the hardcoded omega guess in `entities.js` and replaces it with authored data.
- **Effort**: L (needs per-entity MotionState + the dual-source reconciliation the file names).
- **Validation**: `__diag.motion`; `test_ac_locomotion_per_stance.mjs` neighbourhood; visual A/B of a turning drudge on the 1070.

### PHY-11 — `precipice_slide` outside the faithful driver
- **Source**: `01-physics.md` §3 "Edge slide".
- **Retail**: edge slide (312685) → `cliff_slide` (312714) / `precipice_slide` (312725, 312762). The gate at :312707 requires `ON_WALKABLE_OI | EDGE_SLIDE_OI` — the `EDGE_SLIDE_OI` bit comes from `state & 0x400000` in `get_object_info` (:319085-319086), so "EDGE_SLIDE_PS objects" is right **but the additional on-walkable requirement matters**. `cliff_slide` (312005) crosses the current and last contact normals (:312028-312033), zeroes z (:312037), and clamps (:312053-312076).
- **Holtburger**: the faithful driver documents a *reasoned* terrain-only deviation — `crates/holtburger-dat/src/transition/types.rs:539-567`: on pure terrain retail never reaches the precipice arm (acclient.c:354992), so branch 2 is unreachable there; a walk onto a too-steep face gets `cliff_slide` (branch 1). The legacy chain has `USE_PRECIPICE_SLIDE_REENTRY = true` (`crates/holtburger-core/src/client/movement/system.rs:355`), `USE_EDGE_SLIDE = true` (`:321`), `USE_CLIFF_SLIDE = true` (`:387`), and `crates/holtburger-world/src/spatial/physics.rs:942-945` records "the full retail `cliff_slide` cross-product skid [is not ported here] — see the TODO at the system.rs edge_slide site", with `:66-73` `USE_CLIFF_SLIDE_INTRA_SUBSTEP: bool = false`.
- **Proposed change**: (a) flip `USE_CLIFF_SLIDE_INTRA_SUBSTEP` on after A/B so the seam-skid fires *within* a substep as retail does; (b) confirm the on-walkable co-requirement is enforced at the gate (currently UNVERIFIED in the legacy chain).
- **Payoff**: fidelity — cliff-edge feel; prevents the "stuck on a lip" and "shot off a ledge" pair.
- **Effort**: S–M.
- **Validation**: `validate_physics_replay.cjs` with a recorded cliff-edge route; `?cliffSlideIntraSubstep=on|off`.

### PHY-12 — `ALIGNPATH_PS` / `SLEDDING_PS` heading alignment is an either/or, and neither arm exists
- **Source**: `01-physics.md` §2 "The update chain" (the third pass's correction).
- **Retail**: at acclient.c:322800, `ALIGNPATH_PS` aligns heading to the **position delta** (`new_pos.origin − m_position.origin`) via `set_vector_heading` (:322802-322804) — **not to velocity**. Only in the `else if` branch (:322806) do `SLEDDING_PS` objects with nonzero velocity yaw-align to velocity (:322806-322810). Earlier drafts treated these as two independent behaviours; they are mutually exclusive.
- **Holtburger**: `Frame::set_vector_heading` is ported (`crates/holtburger-dat/src/transition/frame_transform.rs:167`) and used for **billboarding** (`apps/holtburger-web/scene3d/statics.js:261`, `:3176`), not for path alignment. `PhysicsState::EDGE_SLIDE`/`SLEDDING` bits exist (`crates/holtburger-common/src/properties/object.rs:78-79`) but no mover consults `ALIGNPATH`. **ABSENT** for both arms.
- **Proposed change**: implement the either/or at the commit site. `ALIGNPATH_PS` is what makes arrows/bolts and other flying content point along their flight path; `SLEDDING` velocity-yaw is the sledding visual.
- **Payoff**: fidelity — missiles currently keep their spawn orientation (a known visual complaint class).
- **Effort**: S.
- **Validation**: `probe_cast_matrix.cjs` / a missile-flight capture; assert the arrow's forward axis tracks the position delta, not the initial heading.

### PHY-13 — `SLEDDING_PS` is never carried on the local player, so the sledding friction table is unreachable
- **Source**: `01-physics.md` §2 (`calc_acceleration`, `calc_friction`, and the bounce-suppression escape).
- **Retail**: `calc_acceleration` (317787) zeroes both acceleration and omega when `CONTACT_TS && ON_WALKABLE_TS && !SLEDDING_PS` (:317797-317808); the sledding branches of `calc_friction` are the only way a grounded object glides.
- **Holtburger**: the friction lattice is fully ported and correct — `crates/holtburger-core/src/client/movement/common.rs:615-660` (`SLEDDING_LOW_VELOCITY_SQ 1.5625`, `SLEDDING_HIGH_VELOCITY_SQ 6.25`, `SLEDDING_STEEP_NORMAL_Z 0.98480775` with an explicit note that the old `0.99999536` port had inherited a bug) — but `crates/holtburger-core/src/client/movement/system.rs:4368-4372` states: "retail's `calc_friction` only consults the SLEDDING branches when `State.HasFlag(PhysicsState.Sledding)` … **We don't carry the Sledding state bit on the local player**". `:6671` passes `true` for Sledding only on "the steep-slide state".
- **Proposed change**: hydrate `PhysicsState::SLEDDING` onto the local player from the server's PhysicsDesc and honour it in `calc_acceleration`/`calc_friction`/bounce suppression. Coupled with PHY-01.
- **Payoff**: fidelity — steep-slope glide behaviour; the `:483` comment already notes the 0.2-glide table "is only reachable by objects that carry SLEDDING_PS *and* stand on a walkable plane", i.e. currently nothing.
- **Effort**: S.
- **Validation**: `@teleloc` to a steep face; `__diag.physics` friction-branch counter; A/B glide distance.

### PHY-14 — audit our cell-array caps against retail's silent clamp-to-10
- **Source**: `01-physics.md` §3 "Cell residency and portals".
- **Retail**: `CObjCell::find_cell_list` has four overloads (346961, 347316, 347322, 347337). **The cylsphere overload silently clamps to 10** at :347351-347358, copying into a file-static scratch array **with no diagnostic**. Content was authored against a world where a mover never sees more than 10 cells at once.
- **Holtburger**: cell arrays are rebuilt from geometry every step (`crates/holtburger-dat/src/transition/driver_validate.rs:390-406`, `types.rs:380-382` `cell_array_valid`) with no documented cap. The nearest cap is `crates/holtburger-world/src/spatial/scene.rs:240` `EXIT_INDOOR_BFS_MAX_CELLS = 64` (a different pass, overflow handled at `:2400`).
- **Proposed change**: (a) instrument the max observed cell-array size in the faithful driver; (b) if it can exceed 10, decide deliberately whether to clamp (parity: content may rely on the clamp for portal-heavy cells) or keep unbounded (correctness) — and **log** either way, since retail's silence is the bug the doc calls out.
- **Payoff**: correctness insurance in dungeons with dense portal fans; cheap.
- **Effort**: S.
- **Validation**: `__diag.pvs` / `__diag.geometry` histogram; run the Town Network and Academy routes.

### PHY-15 — `PhysicsScriptTable::GetScript` bucket hash + intensity variant selection
- **Source**: `01-physics.md` §6.
- **Retail**: `CPhysicsObj::play_script` (320326) → `PhysicsScriptTable::GetScript` (336931), which hashes `type % m_numBuckets` and **picks a variant by intensity**. `PS_Invalid 0` (acclient.h:2628), `PS_Launch 4` (2632), `PS_Explode 5` (2633).
- **Holtburger**: `crates/holtburger-dat/src/file_type/physics_script.rs` parses scripts; `crates/holtburger-world/src/hydration.rs:249-256` hydrates both `PropertyDataId::PhysicsScript` and `PropertyFloat::PhysicsScriptIntensity`. The intensity-keyed **variant selection** inside a PhysicsScriptTable is UNVERIFIED — `apps/holtburger-web/scene3d/script_manager.js` takes an already-resolved script.
- **Proposed change**: implement the `type % numBuckets` lookup plus intensity-based variant pick so the same effect type at different intensities plays its authored variant (the difference between a small and a large explosion).
- **Payoff**: fidelity for the whole PhysicsScript/VFX surface; `PhysicsScriptIntensity` is currently stored and unread for selection.
- **Effort**: S–M.
- **Validation**: `test_script_manager.mjs`, `test_static_callpes.mjs`; `__diag.cast` effect-id log across intensities.

### PHY-16 — promote authored particle degrade (`?particleDegrade=retail`) to default-on
- **Source**: `01-physics.md` §6.
- **Retail**: `CPhysicsObj::ShouldDrawParticles` (body 317184, distance test :317192) gates degradation with a **direct** compare `CYpt > i_fDegradeDistance` — no sphere slack.
- **Holtburger**: implemented and correct but **default-off**. `apps/holtburger-web/scene3d/particles/particle_manager.js:253-283` documents the whole chain (`ParticleEmitter::InitEnd` stamps `degrade_distance`, ours resolves it via `fetch_particle_degrade_distance(hwGfxObjId)`), `:277` "Flag OFF (default): `degradeDistance` stays Infinity and the [term is inert]", and the OR-term at `:614-620` cites acclient.c:317195 for the no-slack compare.
- **Proposed change**: flip default-on per the house `default-on-no-eyetest-gate` rule (bar: bare-default loads + spawns + 0 errors); keep `?particleDegrade=off` as the escape. It is additive over the existing RP6 frustum/cap superset, so the risk is only "an emitter the author wanted degraded now degrades".
- **Payoff**: perf (authored culling radii are usually far tighter than the RP6 cap) + fidelity.
- **Effort**: S.
- **Validation**: `test_a11_s4_particle_degrade.mjs`; A/B fps in a spell-heavy fight with the `autoReset = false` cumulative protocol.

### PHY-17 — degraded-emitter freeze semantics: finite vs infinite emitters differ
- **Source**: `01-physics.md` §6 (last paragraph).
- **Retail**: the degraded branch does **not** keep advancing lifetimes. Finite emitters compute lifetime **once**, then `KillParticle` and stop (:331138-331182). Infinite emitters **reset every particle's birthtime to now** (:331175), freezing lifetime near zero. `Particle::Update` is skipped either way.
- **Holtburger**: `apps/holtburger-web/scene3d/particles/particle_manager.js:609-611` names "the culled path's freeze + visibility flip + re-entry restore is the SetNoDraw/degraded_out contract (acclient.c:331097-331139)" — so the *contract* is known, but whether our emitter branches finite-vs-infinite the way retail does is **UNVERIFIED** in `particles/particle_emitter.js`.
- **Proposed change**: verify and, if needed, split the branch. The observable difference: on re-entry a degraded **infinite** emitter must look freshly born (all particles near t=0), while a degraded **finite** emitter must be **gone**, not resumed. Getting this backwards produces either a burst of stale particles on approach or a fountain that never finishes.
- **Payoff**: fidelity; also a correctness prerequisite for PHY-16's promotion (default-on makes the branch reachable constantly).
- **Effort**: S.
- **Validation**: `test_a11_s0_blocking_particle.mjs` + `test_a11_s4_particle_degrade.mjs`; headless walk-away/walk-back past a brazier (finite) and a torch (infinite) and diff particle counts on re-entry.

### PHY-18 — `?rootMotionObject` flag-default footgun: comment says OFF, reader defaults ON
- **Source**: process finding while verifying `01-physics.md` §2 root-motion scaling.
- **Retail**: n/a — this is a holtburger flag-hygiene defect, and it is exactly the known `flag-default-footgun` pattern.
- **Holtburger**: `apps/holtburger-web/scene3d/entities.js:234` says "`?rootMotionObject=1` opt-in, **default OFF**" and `:243` "ours is the spec-scoped completion-time approximation". But the reader at `:248-254` is `return new URLSearchParams(...).get("rootMotionObject") !== "off";` — **absent ⇒ `true` ⇒ ON**. Only `=off` disables it. Read once into `this._rootMotionObjectOn` at `:3107`.
- **Proposed change**: decide which it should be and make comment, reader and `docs/url-flags.md` agree. Given the feature is validated and additive (the ON path is guarded by a freshness gate at `:10850-10852` and an airborne skip at `:10857`), the right fix is almost certainly **document it as default-ON** and update the two comments — not to change behaviour silently.
- **Payoff**: correctness of the flag inventory. A stale "default OFF" comment means any A/B that thought it was measuring the off-path measured the on-path.
- **Effort**: S.
- **Validation**: `test_a5_p3_root_motion.mjs`; grep-audit the sibling readers (`readDeadReckonFlag` is named as the same shape at `:246` — check it too).

### PHY-19 — per-frame object root motion vs our completion-time approximation
- **Source**: `01-physics.md` §2 + §4.
- **Retail**: `CSequence::update_internal` accumulates root displacement **per crossed frame** (:340717-340720) and `UpdatePositionInternal` composes it object-local into the new object frame at :320031, scaled by live `m_scale` when `ON_WALKABLE_TS` and by 0.0 otherwise (:320014-320026).
- **Holtburger**: `apps/holtburger-web/scene3d/entities.js:234-247` states the deviation openly: ours applies the clip's **net** rigid displacement at **completion** ("per-frame object root motion deferred", A5 §4 P3), remote entities only — the local player's anchor is owned by the wasm integrator. The scale/airborne/rotation rules are correct (`:10829-10836`, `:10856-10868`).
- **Proposed change**: move to per-frame accumulation, at minimum for translating one-shots. The visible artefact today is that a lunge/knockback holds its start anchor for the clip's whole duration and then jumps at the end.
- **Payoff**: fidelity for melee lunges, knockbacks and door swings.
- **Effort**: M (needs the wasm sequence to publish per-frame deltas, not just `rootMotionNet`).
- **Validation**: `test_a5_p3_root_motion.mjs` extended to sample mid-clip; visual A/B on the 1070.

### PHY-20 — the 30 Hz gate covers only the integrator, not the whole physics pass
- **Source**: `01-physics.md` §2 "The 30 Hz outer gate" — the doc calls this "the single most important timing fact in the subsystem", omitted from earlier drafts.
- **Retail**: `CPhysics::UseTime` (acclient.c:311335) **does nothing at all** unless `Timer::cur_time − last_update >= MIN_QUANTUM_93` (1/30), tested at :311352. When it does run it iterates the maintenance hash calling `update_object`, then `SmartBox::PlayerPhysicsUpdatedCallback` for the player, then animates static objects (and calls `UpdateTexVelocity`). Verified in the raw decomp: `acclient.c:783717: MIN_QUANTUM_93 = 1.0 / 30.0;`.
- **Holtburger**: the *integrator* respects 30 Hz (`crates/holtburger-core/src/client/movement/system.rs:1159`, `:4123`; residual accumulator at `crates/holtburger-world/src/player/types.rs:1507-1520`) and the *order* is mirrored (`apps/holtburger-web/scene3d/loop.js:2056` "world (dynamic) managers first, then statics, mirroring CPhysics::UseTime"; `crates/holtburger-core/src/client/tick_spine.rs:8`). But there is no single outer gate: statics animation, `UpdateTexVelocity` (texture-velocity hooks), particle managers and script managers all advance per rAF frame at 60+ Hz.
- **Proposed change**: introduce one 30 Hz accumulator in `loop.js` that gates the whole physics/animation-manager block (not the renderer). Anything that retail advanced only inside `CPhysics::UseTime` should advance on that tick.
- **Payoff**: **perf** (halves the per-frame cost of the manager block at 60 fps and cuts it by 4× at 120) **and** fidelity (texture-velocity scroll rates and particle birth cadence were authored against 30 Hz; running them at 60 Hz doubles effective rates unless every site is dt-correct — and a dt-correct site is not the same as a 30 Hz site for anything integer-quantized).
- **Effort**: M.
- **Validation**: `?targetFps=30|60|120` with `__diag.render`; `test_particle_clock.mjs` + `test_park_usetime.mjs`; assert texture scroll speed is fps-invariant before and after.

### PHY-21 — pin the `transitional_insert` / `step_down` retry semantics with a regression test
- **Source**: `01-physics.md` §3 (the third pass's two corrections here: retry count is a *parameter*, and the halving is a *single* `*0.5` with *two* attempts).
- **Retail**: retry counts are caller-supplied — 3 from `find_transitional_position` (:313290/:313307), 5 from `step_down` (:312662), 1 from the confirmation re-insert (:312673); limit check at :313002-313004. `transitional_insert` sets `step_down_ht = radius * 0.5` when `num_sphere < 2 && 2*radius < step_down_ht` (:312975-312980), then applies a **single** `* 0.5` at :312991 and calls `step_down` **twice with that same value** (:312993). One halving, two attempts.
- **Holtburger**: correct today — `crates/holtburger-dat/src/transition/driver_spine.rs:113` `transitional_insert(&mut self, world, num_insertion_attempts: i32)`, `:411` `let v8 = self.transitional_insert(world, 5);` inside `step_down`, `:434` "Placement re-pin (attempts 1)", `:343` "half-height; retry twice with the SAME args", limit at `:373`.
- **Proposed change**: no behaviour change. Add a **regression test** asserting the three attempt counts and the one-halving-two-attempts shape, because both are exactly the kind of detail a refactor silently turns into two halvings (which is what the earlier drafts believed).
- **Payoff**: protects a hard-won parity detail.
- **Effort**: S.
- **Validation**: unit tests in `crates/holtburger-dat/src/transition/driver_spine.rs` (the `trace.rs` hooks at `:146` and `:368` already emit the counts).

### PHY-22 — audit `fail_progress_count`: dead in retail, live in ours
- **Source**: `01-physics.md` §5 "MoveToManager".
- **Retail**: `fail_progress_count` is incremented in **two** places (:345659, :345769), zeroed in four, and **never read** — dead code.
- **Holtburger**: `crates/holtburger-core/src/client/movement/move_to.rs:976-982` increments it (and `:983` zeroes it) inside the progress branch, faithfully mirroring the retail write sites. Whether anything **reads** it is UNVERIFIED; the retail-faithful answer is that nothing should.
- **Proposed change**: confirm no reader. If a reader exists, it is behaviour retail does not have and needs a justification comment; if none, add a `#[allow(dead_code)]` + "retail-dead, kept for shape parity" note so a future cleanup doesn't delete it and lose the shape.
- **Payoff**: prevents an accidental behavioural divergence in MoveTo pursuit.
- **Effort**: S.
- **Validation**: grep + the existing `move_to.rs` stall tests (`:1459` `away_aux_fail_distance_and_stall`).

### PHY-23 — `get_block_offset` Δblock × 24.0 and the dungeon block-local coordinate rule
- **Source**: `01-physics.md` §1 "Cells".
- **Retail**: `get_block_offset` (123110): same block gives zero, otherwise **Δblock × 24.0 with z = 0** — "which is why dungeon coordinates are block-local". `LandDefs::gid_to_lcoord` (209521) treats a low word below `0x100` as outdoor (:209529).
- **Holtburger**: the outdoor/indoor discriminator is used correctly and pervasively (`crates/holtburger-world/src/spatial/scene.rs:1992`, `:2002`, `:2117`, `:2127`; `crates/holtburger-common/src/position.rs:337` test uses `0x860201AD` as "indoor (low >= 0x100)"). The `Δblock × 24.0, z = 0` cross-block offset rule is **UNVERIFIED** as a named helper — our cross-LB math goes through `METERS_PER_LANDBLOCK` (imported at `crates/holtburger-world/src/spatial/position_manager.rs:28`).
- **Proposed change**: verify that cross-block deltas use 24.0-per-cell (i.e. 192 m per LB) **with z forced to 0**, and that indoor positions are never offset across blocks. The `z = 0` detail is the trap: a naive 3-component block offset would corrupt dungeon Z.
- **Payoff**: correctness for multi-LB dungeons and cross-LB portal traversal.
- **Effort**: S.
- **Validation**: a unit test asserting `get_block_offset`-equivalent for same-block (zero), adjacent-block (24·Δ, z=0) and indoor (no offset); the Town Network route as the live check.

### PHY-24 — `LScape::PreFetchCells` ring shape and the two-tier DID fallback
- **Source**: `01-physics.md` §7 "Landblock streaming".
- **Retail**: `CellManager::PreFetchCells` (146528) → `LScape::PreFetchCells` (307068) walks **`(2 × mid_radius + 1)²`** blocks (`SetMidRadius` 306429/306440) and prefetches DID **`blockid | 0xFFFF` as type 1** (:307124) — the landblock terrain and heightmap file, consumed as `CLandBlock` at :307149 — falling back to **`(id & 0xFFFFFFFE) | 0xFFFE` as type 2** (:307141-307142) for LandBlockInfo. Individual cells arrive later via `CLandBlock::PreFetchCells`.
- **Holtburger**: `apps/holtburger-web/src/prefetch.rs` is a *different* animal — an iterative record-graph prefetch loop (`ensure_walk_prefetched`, `:205`; urgent variant `:225`) driven by what a `walk` reads, not a geometric block ring. The residency ring lives in `apps/holtburger-web/scene3d/{landblock_lru.js,fixed_grid.js,world_stream.js}`. The retail `(2r+1)²` shape and the **ordering** (terrain first, LandBlockInfo as fallback, cells last) are **UNVERIFIED** against ours.
- **Proposed change**: compare our ring radius and per-LB fetch ordering to retail's. The load-bearing part is the **ordering**: terrain+heightmap before LandBlockInfo before cells means the player always has ground to stand on before scenery arrives. If ours fetches scenery concurrently, a slow link can produce the "0 placements / no ground" states the `--check`/`_health.json` machinery exists to catch.
- **Payoff**: perf + robustness on slow links; potentially removes bespoke urgency heuristics (`landblock_lru.js` server-urgency, `test_landblock_lru_server_urgency.mjs`).
- **Effort**: M.
- **Validation**: `__diag.assets` fetch-order log; throttled-network headless boot; `test_stream_bake_guard.mjs`.

### PHY-25 — dungeons never stream landblocks (retail gates `UpdateLoadPoint` on outdoor)
- **Source**: `01-physics.md` §7.
- **Retail**: `LScape::update_loadpoint` (308283) rebuilds **only on a real block shift** (:308340), and `CellManager::UpdateLoadPoint` (146439) gates on `(u16)objcell_id < 0x100` — so **dungeons never stream landblocks**.
- **Holtburger**: the outdoor discriminator is available everywhere (see PHY-23), and `?eagerDungeons` exists as an opt-in perf flag, but whether the LB streaming ring is **suppressed entirely** while indoors is **UNVERIFIED** (`apps/holtburger-web/scene3d/world_stream.js` is only 187 lines; `landblock_lru.js` has a `null_lb` test at `test_landblock_lru_null_lb.mjs` suggesting indoor is handled but not that streaming is off).
- **Proposed change**: suppress the outdoor LB streaming ring while the player's cell low word is `>= 0x100`, and skip `update_loadpoint` rebuilds that aren't a real block shift.
- **Payoff**: **perf** — a dungeon run currently may keep re-evaluating and re-baking an outdoor ring the player cannot see. This is free frame time in exactly the place (indoor combat) where it is scarcest.
- **Effort**: S.
- **Validation**: `?lbLruDebug` + `__diag.placements`; headless `@telepoi` into a dungeon and assert the outdoor bake/fetch counters go flat.

### PHY-26 — loading-progress notice → powerbar UI
- **Source**: `01-physics.md` §7 (last paragraph).
- **Retail**: streaming progress reaches the UI through `ECM_DDD::SendNotice_RuntimeDDDStatus` — **despite the DDD name its only four call sites are in `CellManager`** (146573, 146589, 146594, 146638) — consumed by `gmPowerbarUI::RecvNotice_RuntimeDDDStatus` (265135).
- **Holtburger**: **UNVERIFIED/ABSENT** — the boot banner reads `dist/_health.json` and `?lbLruDebug` prints to console, but there is no in-world powerbar-style streaming indicator. (The retail *naming* is the finding: anyone looking for landblock-load progress would grep `DDD` and conclude it was patch-download UI.)
- **Proposed change**: surface landblock/cell streaming progress on the powerbar the way retail did. Cheap, and it makes the (real, measurable) 17.5 s post-teleport bake saturation documented at `apps/holtburger-web/scene3d/landblock_lru.js:352` legible to the player instead of looking like a hang.
- **Payoff**: UX; also a diagnostic the 1070 eye-tests can read off-screen.
- **Effort**: S.
- **Validation**: visual; `?agent=1` screenshot after a `@telepoi` hop.

### PHY-27 — audit the `MoveToStatePack` vs `AutonomousPositionPack` send paths
- **Source**: `01-physics.md` §8.
- **Retail**: the client is authoritative for its own motion. `CommandInterpreter::SendMovementEvent` (718142) builds a **`MoveToStatePack`** (:718161/:718187), *not* an `AutonomousPositionPack`. The latter is built by `CommandInterpreter::SendPositionEvent` (718202, construction :718239) and by `ACCmdInterp::SendAutonomousPositionEvent` (435905). The `AutonomousPositionPack` ctor is at 323904 and carries position, contact flag, and **instance / server-control / teleport / force-position timestamps**.
- **Holtburger**: both shapes exist — `crates/holtburger-core/src/client/movement/common.rs:368-390` builds the turn/holdkey/speed state pack ("`TurnRight×(−speed)` on the wire; observers integrate the [rest]"), and `build_autonomous_position` is imported at `crates/holtburger-core/src/client/movement/system.rs:5` with `AUTONOMOUS_POSITION_HEARTBEAT_INTERVAL` at `:2` and a change gate at `:405` (`USE_AUTONOMOUS_POSITION_CHANGE_GATE = true`).
- **Proposed change**: audit that a *movement input change* sends the state pack and *only* position heartbeats/teleport confirmations send the autonomous-position pack, and that all four timestamp fields are populated. Mixing them is the classic source of server-side "failed transition" spam and rubberbanding.
- **Payoff**: correctness of the client-authority contract against vanilla ACE.
- **Effort**: S.
- **Validation**: `__diag.wire.summary()` opcode histogram during a walk; `validate_wire_conformance.cjs`.

### PHY-31 — record the two IDA misnamings in the animation code
- **Source**: `01-physics.md` §9.
- **Retail**: `MD_Data_Fade::GetDuration` (694302) actually returns **`framerate`**, not a duration. `PhysicsDesc::get_animframe_id` returns offset **+20**, which in `AnimSequenceNode` (acclient.h:31063) is **`low_frame`**. `get_starting_frame` / `get_ending_frame` are at **341016** and **341028**, flipping on negative framerate and biasing by **−0.00019999999**.
- **Holtburger**: `apps/holtburger-web/src/motion_sequence.rs:69-76` `uniform_times(num_frames, framerate)` and `:107-135` treat framerate and duration as distinct inputs (`duration = num_frames / framerate` at `:135`) — so we are not victims of the `GetDuration` misnaming. The **−0.0002 bias on start/end frame** and the negative-framerate flip are **UNVERIFIED** in our start/end frame selection.
- **Proposed change**: (a) record both misnamings in the decomp-reading notes so nobody re-derives duration from `GetDuration`; (b) verify our start/end frame picks carry the negative-framerate flip and the −0.0002 bias — without the bias, a frame index that lands exactly on a boundary picks the wrong neighbour, which shows up as a one-frame pop at clip start/end for reverse-playing clips.
- **Payoff**: fidelity (one-frame pops) + prevents a future mis-port.
- **Effort**: S.
- **Validation**: `test_motion_sequence.mjs` / `test_phase7_4a_animation_clip.mjs` with a negative-framerate clip; `validate_motion_pose.cjs`.

## Object model / properties / inventory / appearance / social

### OBJ-01 — `EquipMask::CLOTHING` has the wrong bit (`0x80000000` instead of CLOAK `0x08000000`)
- **Source**: `03-object-model.md` §7, and re-verified against the raw header.
- **Retail**: `CLOTHING_LOC = 0x080001FF`. Verified directly: `/home/wbterminal/ac-headers/acclient.h:3227` `CLOTHING_LOC = 0x80001FF,` — i.e. `0x08000000 | 0x1FF`, where `0x08000000` is `CLOAK_LOC` (acclient.h:3223) and `0x1FF` is the nine head→foot **wear** slots. There is **no bit 31** in `INVENTORY_LOC` (the top defined bit is `SIGIL_THREE_LOC = 0x40000000`, acclient.h:3226).
- **Holtburger**: `crates/holtburger-common/src/properties/inventory.rs:246` — `const CLOTHING = 0x80000000 | EquipMask::HEAD_WEAR.bits() | ... | EquipMask::FOOT_WEAR.bits();` → **`0x800001FF`**. The single-slot bits themselves are all correct (`:160-190`, verified against acclient.h:3196-3226), and `JEWELRY` at `:248` computes to exactly the retail `0x7C0F8000`.
- **Proposed change**: `const CLOTHING = EquipMask::CLOAK.bits() | HEAD_WEAR | CHEST_WEAR | ABDOMEN_WEAR | UPPER_ARM_WEAR | LOWER_ARM_WEAR | HAND_WEAR | UPPER_LEG_WEAR | LOWER_LEG_WEAR | FOOT_WEAR` = `0x080001FF`. Cite acclient.h:3227.
- **Payoff**: correctness. **Note the honest impact assessment**: grep for `PseudoEquipMask::CLOTHING` across `crates/` + `apps/` returns **zero callers today**, so this is latent, not live. It is still worth fixing because the wrong value is a landmine for the paperdoll/dye/wardrobe work that will use it — `0x80000000` is an undefined bit that `EquipMask::from_bits_truncate` (`:257`) would silently drop, so a future `CLOTHING`-masked query would lose the cloak slot *and* the conversion would quietly discard bit 31.
- **Effort**: S.
- **Validation**: a unit test asserting `PseudoEquipMask::CLOTHING.bits() == 0x080001FF` and `ARMOR == 0x7E00` and `JEWELRY == 0x7C0F8000` (the last already passes) — pin all three composites at once.

### OBJ-02 — `EquipMask::ARMOR` wrongly includes `FOOT_WEAR` (`0x7F00` vs retail `0x7E00`)
- **Source**: `03-object-model.md` §7; re-verified at `/home/wbterminal/ac-headers/acclient.h:3228` `ARMOR_LOC = 0x7E00,`.
- **Retail**: `ARMOR_LOC = 0x00007E00` = `CHEST_ARMOR 0x200 | ABDOMEN_ARMOR 0x400 | UPPER_ARM_ARMOR 0x800 | LOWER_ARM_ARMOR 0x1000 | UPPER_LEG_ARMOR 0x2000 | LOWER_LEG_ARMOR 0x4000`. Six bits. `FOOT_WEAR_LOC (0x100)` is **not** in it — feet are a *wear* slot, and retail deliberately classes them with clothing (`CLOTHING_LOC`'s `0x1FF` includes `0x100`).
- **Holtburger**: `crates/holtburger-common/src/properties/inventory.rs:247` — `const ARMOR = CHEST_ARMOR | ABDOMEN_ARMOR | UPPER_ARM_ARMOR | LOWER_ARM_ARMOR | UPPER_LEG_ARMOR | LOWER_LEG_ARMOR | EquipMask::FOOT_WEAR.bits();` → **`0x7F00`**. The trailing `FOOT_WEAR` is the defect.
- **Proposed change**: drop `FOOT_WEAR` from `ARMOR`. Cite acclient.h:3228.
- **Payoff**: correctness. Same latency caveat as OBJ-01 (no live callers), same reason to fix: boots would be double-classified as both armour and clothing, which breaks any "sum my armour slots" or paperdoll-region grouping built on it.
- **Effort**: S.
- **Validation**: the same three-composite unit test as OBJ-01.

### OBJ-03 — appraisal spell bit-31 tag is stripped, not routed
- **Source**: `03-object-model.md` §8 "AppraisalProfile".
- **Retail**: **spell IDs carry a bit-31 tag.** `Appraisal_ShowMagicInfo` (232515) masks `id & 0x80000000` at :232581 and `id & 0x7FFFFFFF` at :232582, then routes the entry to a **"Enchantments:"** heading when the bit is set and **"Spell Descriptions:"** when it is clear (:232607). Two distinct sections in one appraisal panel.
- **Holtburger**: the bit is recognised but only as noise to remove. `apps/holtburger-web/src/lib.rs:30534-30536`: "The high bit (`0x80000000`) of a spell ID indicates an enchantment-marker variant — **the parser strips it before lookup** (mirrors `SpellCatalog::get` at `holtburger_world::spell:42-45`)." The `spellBook` array is shipped to JS flat at `:25715` with no tag preserved.
- **Proposed change**: preserve the tag alongside the masked id (e.g. `{ id, isEnchantment }`) through `spellBook`, and split the examine panel into "Enchantments:" and "Spell Descriptions:" sections per retail.
- **Payoff**: fidelity — this is a *visible* examine-panel difference on every enchanted item. Players read the two sections differently (active buffs vs the item's own spells) and we currently merge them into one undifferentiated list.
- **Effort**: S.
- **Validation**: `diag_inventory_paperdoll.cjs` / `test_examine_dye_preview.mjs` neighbourhood; examine a buffed weapon headless and assert two headings.

### OBJ-04 — `Appraisal_ShowShortMagicInfo` skips high-bit entries
- **Source**: `03-object-model.md` §8.
- **Retail**: `Appraisal_ShowShortMagicInfo` (232412) **skips high-bit entries** at :232447 — the short (tooltip/hover) form lists only the item's own spells, never active enchantments.
- **Holtburger**: **ABSENT** as a distinct rule — since the tag is stripped upstream (OBJ-03), the short form cannot filter on it.
- **Proposed change**: once OBJ-03 preserves the tag, filter the short/hover form to `!isEnchantment`.
- **Payoff**: fidelity — hover tooltips on a heavily-buffed item currently list a wall of enchantments retail deliberately omits.
- **Effort**: S (depends on OBJ-03).
- **Validation**: hover an enchanted item headless; assert the short list length equals the count of clear-bit entries.

### OBJ-05 — enchantment highlight-bitfield decode (raised vs lowered) and the three BFIndex enums
- **Source**: `03-object-model.md` §8.
- **Retail**: the highlight bitfields use **low bit = modified/lowered, the same bit `<< 16` = raised**. The **decode lives in `AppraisalProfile::InqIntEnchantmentMod` (477439) and `InqFloatEnchantmentMod` (477474)** — *not* in `Appraisal_ShowArmorMods` (231786), which merely selects between the `mod_high_font` and `mod_low_font` member handles (an earlier-draft error). The three index enums: `ArmorEnchantment_BFIndex` (acclient.h:4237) covers level plus **eight** damage types; `WeaponEnchantment_BFIndex` (4261) covers offense, defense, time, damage, variance, mod; `ResistanceEnchantment_BFIndex` (4279) has **15 low bits, of which 13 are resistances** — slash, pierce, bludgeon, fire, cold, acid, electric, health boost, stamina drain, stamina boost, mana drain, mana boost, nether — plus `BF_MANA_CON_MOD 0x1000` and `BF_ELE_DAMAGE_MOD 0x2000`.
- **Holtburger**: the three bitfields are **carried end-to-end but never decoded**. `crates/holtburger-world/src/entity.rs:910-914` `armor_highlight/weapon_highlight/resist_highlight: Option<u16>`, mirrored in `vendor.rs:25-29`, threaded at `entity.rs:1118-1122`, wire-read at `crates/holtburger-protocol/src/messages/object/types.rs:124` `pub highlights: u16` / `:166`, and shipped to JS at `apps/holtburger-web/src/lib.rs:25716-25720`. Grep for any consumer in `index.html` / `ui/` / `hud.js` returns nothing — **no site reads them**.
- **Proposed change**: implement `InqIntEnchantmentMod` / `InqFloatEnchantmentMod`-equivalent decode (bit → lowered, bit<<16 → raised), define the three BFIndex enums with the exact member orders above (note `resist` has 13 resistances in 15 bits, so index ≠ bit position), and colour the examine-panel rows high/low.
- **Payoff**: fidelity — this is the green/red "this stat is buffed/debuffed" colouring on every appraisal, one of the most-looked-at pieces of AC UI, and it is currently entirely missing despite the data already arriving.
- **Effort**: M.
- **Validation**: `__diag.combat` / examine panel screenshot A/B; unit-test the decode against a synthetic `highlights` word with a known raised+lowered mix.

### OBJ-06 — the nine `base_armor_*` slots in `AppraisalProfile`
- **Source**: `03-object-model.md` §8.
- **Retail**: `AppraisalProfile` (acclient.h:36603) has **six** stat tables (int, int64, bool, float, string, DID — **no IID, no Position**), optional Creature/Hook/Weapon/Armor profiles, a `PSmartArray<ulong> *_spellBook`, three highlight bitfields, and **nine `base_armor_*` ints in order: head, chest, groin, bicep, wrist, hand, thigh, shin, foot**.
- **Holtburger**: the six-table restriction and the highlights/spellBook are honoured (see OBJ-05 citations). The nine-slot `base_armor_*` array is **UNVERIFIED/ABSENT** — `crates/holtburger-world/src/state/types.rs:238-243` computes a single `base_armor` and passes it to `crate::magic::get_enchanted_armor` (`crates/holtburger-world/src/magic.rs:169-176`), i.e. one scalar, not nine slots.
- **Proposed change**: parse and carry the nine per-slot base-armour ints in the declared order (the order matters — it is *not* the `EquipMask` bit order) so per-slot armour can be displayed and so `get_enchanted_armor` can be applied per slot as retail does.
- **Payoff**: fidelity for armour examine; prerequisite for a correct paperdoll AL display.
- **Effort**: S–M.
- **Validation**: appraise a known armour piece and diff the nine values against an ACE DB query via the `worldbuilder-terminal` `ace-*` probes.

### OBJ-07 — wield-requirement appraisal strings: the 12 requirement types
- **Source**: `03-object-model.md` §7 (last paragraph).
- **Retail**: `GetAppraisalStringFromRequirements` (227877). Types **1, 2, and 8 all resolve as skill names** (the trap — 8 is easy to miss); 3/4 attribute; 5/6 vital; 7 level; 9/10 int property; 11 creature type; 12 heritage. The **`"base "` prefix applies to 2, 4, 6** (the even member of each pair). Int properties **287/288/289** map to **Celestial Hand / Eldrytch Web / Radiant Blood** at :227925-227932.
- **Holtburger**: **ABSENT**. `crates/holtburger-common/src/properties/world_object.rs:246-253` exposes `valid_locations()` / `wield_location()`, and `crates/holtburger-world/src/context.rs:801-804` checks `EquipMask::CASTER` / `MISSILE_WEAPON` for grip purposes — but no requirement-to-string renderer exists.
- **Proposed change**: implement the full 12-type mapping including the 1/2/8-all-skills quirk, the `"base "` prefix on 2/4/6, and the three society int-property specials.
- **Payoff**: fidelity — "Skill: Heavy Weapons: 300" / "Base Strength: 290" lines are on the appraisal of essentially every wieldable item; without them the player cannot tell why an item is unwieldable.
- **Effort**: M.
- **Validation**: appraise a society armour piece (int 287/288/289 path) and a tinkered weapon (type 8 path) headless; compare strings against the LSD weenie's `intStats`.

### OBJ-08 — allegiance rank titles: 17 hardcoded tables, entirely absent
- **Source**: `03-object-model.md` §9 "Allegiance".
- **Retail**: titles come from **17** hardcoded switch functions spanning acclient.c:482727-483643, dispatched by `AllegianceSystem::GetTitle` (483645). The extra two beyond a naive male/female pairing are the **male-only Gearknight/Tumerok/Lugian** set. Aluvian male ranks 1–10: **Yeoman, Baronet, Baron, Reeve, Thane, Ealdor, Duke, Aetheling, King, High King**. Display rule: `gmAllegianceUI::UpdatePlayerData` (204451) reads int `0x1E` at :204568 and switches to `ID_Allegiance_RankBuffed` **when it differs from base and is not −1**; `UpdateVassalsData` (205238) renders `_cp_tithed` at :205345.
- **Holtburger**: **ABSENT**. Grep for `Yeoman` / `Baronet` / `Aetheling` across `crates/`, `apps/holtburger-web/{plugins,ui,src,index.html}` returns nothing. `apps/holtburger-web/plugins/allegiance-panel.js:605` renders `const rankText = officerName ? \`${rank} ${officerName}\` : \`${rank}\`;` — a bare number, or a number plus an *officer* title (Speaker/Seneschal/Castellan, which are a different axis: `crates/holtburger-common/src/properties/property_keys/strings.rs:66-68`). `:373` renders vassals as `L${level} R${rank}`.
- **Proposed change**: add the heritage × gender × rank title table (17 variants, with the three male-only heritages folded correctly) plus the buffed-rank display rule (prefer `0x1E` = `AllegianceRank` buffed when it differs from base and isn't −1; ACE's `PropertyInt.AllegianceRank = 30` per `$ENUM/Properties/PropertyInt.cs:53`).
- **Payoff**: fidelity — the allegiance panel is currently numerals where retail showed the title players actually identify with. High visibility, self-contained, zero risk.
- **Effort**: M (the table is large but mechanical; source it from acpedia + the decomp switches).
- **Validation**: `apps/holtburger-web/plugins/allegiance-panel.js` render test; headless snapshot with a known rank/heritage/gender triple.

### OBJ-09 — allegiance `_loyalty` / `_leadership` are 16-bit on the wire despite `unsigned int` declarations
- **Source**: `03-object-model.md` §9.
- **Retail**: rank is server-supplied; `_loyalty` and `_leadership` are unpacked (:481196-481197, :481329/:481332, :481429/:481433) and **never used** — and, critically, **they are wire-packed as 16-bit despite being declared `unsigned int`**.
- **Holtburger**: **UNVERIFIED** — `crates/holtburger-protocol/src/messages/allegiance/` exists but the loyalty/leadership field widths were not read.
- **Proposed change**: verify the two fields are read as `u16`, not `u32`. This is a **stream-desync class bug**: a 32-bit read of a 16-bit field shifts every subsequent field in the allegiance profile by two bytes, which would corrupt everything after it (rank, tithe, officer data) rather than just those two values.
- **Payoff**: correctness — a silent-misparse guard on a message that is easy to get wrong and hard to notice.
- **Effort**: S.
- **Validation**: `validate_wire_conformance.cjs` against a captured allegiance-profile packet; compare against the live ACE shard's allegiance table via the `ace-*` probes.

### OBJ-10 — `ChannelSystem::GetChannelID` channel bit values
- **Source**: `03-object-model.md` §9.
- **Retail**: `ChannelSystem::GetChannelID` (507159) has ~18 entries; the six cited are **allegiance `0x2000000`, co-vassals `0x1000000`, monarch `0x4000`, patron `0x2000`, vassals `0x1000`, fellowship `0x800`**.
- **Holtburger**: **UNVERIFIED/ABSENT** — a targeted grep for these six values in the chat message/state paths returned nothing.
- **Proposed change**: record the ~18-entry table and use it for outbound channel-scoped chat and for inbound channel-tagged message routing/colouring.
- **Payoff**: correctness for `/a`, `/v`, `/p`, `/monarch`, `/f` chat routing and per-channel chat colouring.
- **Effort**: S.
- **Validation**: `__diag.strings` / chat-panel channel filter; send on each channel against the live ACE shard and assert the tag round-trips.

### OBJ-11 — fellowship even-split table and the two independent level kills
- **Source**: `03-object-model.md` §9 "Fellowship".
- **Retail**: cap is **9** (`IsFull`, 483775). `GetEvenSplitXPPctg` (484596) is a literal table: **1.0, 0.75, 0.60000002, 0.55000001, 0.5, 0.44999999, 0.40000001, 0.34999999, 0.31111109, 0.28**, default 0.0. `RecalculateEvenXPSplitting` (484008) is gated on `_share_xp`, sets `_even_xp_split = 1`, and then — **only if the lowest member is under level 50** — applies **two independent** kills, **both measured against the leader's level**: `if (max > leader + 5) → 0` and `if (min + 5 < leader) → 0`. Earlier drafts described a single group-spread test; it is two one-sided tests against the *leader*, not the group.
- **Holtburger**: XP award is server authority (vanilla ACE), so the *computation* is N/A-WEB. But the **display** is not: the fellowship panel should be able to tell the player their share percentage and whether even-split is currently disabled. **ABSENT** — no hits for the 0.31111109 / 0.28 literals or an even-split predicate.
- **Proposed change**: mirror the table and the two kills **read-only**, for display: show the current split percentage and a "even split disabled (level spread)" indicator naming which kill fired.
- **Payoff**: UX/fidelity — retail players relied on this to manage fellow composition; today the client is silent about it.
- **Effort**: S.
- **Validation**: fellowship panel render test with synthetic member level sets exercising both kills and the under-50 gate.

### OBJ-12 — housing: types, rent periods, purchase cooldown, per-guest storage permission, 21 opcodes
- **Source**: `03-object-model.md` §9 "Housing".
- **Retail**: house types **1 cottage / 2 villa / 3 mansion / 4 apartment** (412637, 430788). Rent is **7776000.0 s (90 days) for apartments, 2592000.0 (30 days) otherwise** (`GetRentPeriod`, 486149); the purchase-cooldown literal **2592000** is at :486145 inside `HasPurchaseWaitPeriodExpired` (486143), which feeds off property `0xC7` (last landscape-house purchase time). `GuestInfo` (37963) — **storage permission is per-guest**. `RestrictionDB` (37155) with `IsAllowedIn` (473082). Exactly **21** `CM_House::Event_*` opcodes span acclient.c:707405-708327, including BuyHouse 540, AbandonHouse 543, RentHouse 545, SetOpenHouseStatus 583, ChangeStoragePermission 585, TeleToHouse 610, SetHooksVisibility 614, ListAvailableHouses 624.
- **Holtburger**: **ABSENT**. Neither `7776000` nor `2592000` appears anywhere; no house-type enum; a `house` message module is listed as created in `apps/holtburger-web/docs/discord-deficiency-2026-05-25/DEFICIENCY-REPORT.md:68` but the constants and the UI are not present.
- **Proposed change**: add the house-type enum, the two rent periods, the purchase cooldown (reading `0xC7`), the per-guest storage permission flag, and the 21 opcodes. Note `PublicWeenieDesc` already carries a cut-down `RestrictionDB _db` for housing (§1), so the ingress point exists.
- **Payoff**: feature completeness — housing is entirely unreachable today. The **per-guest** storage detail is the one most implementations get wrong (they model storage as a single house-wide flag).
- **Effort**: L.
- **Validation**: `validate_event_completeness.cjs` for the 21 opcodes; live ACE shard house purchase/rent round-trip.

### OBJ-13 — contract stage decode: stage 3 has three outcomes
- **Source**: `03-object-model.md` §9 "Contracts, titles, books".
- **Retail**: `gmContractsUI::FillProgressString` (210728) decodes `_contract_stage`: **1 Available**, **2 In Progress**, **3 has three outcomes** — "Done" with no repeat time, `"Done (<delta> to Repeat)"` with a pending timer, and **"Available"** once the timer expired — and **anything `>= 4` is a progress counter rendered as `stage − 4`**. `CContract` (acclient.h:40422) stores quest flags as **strings**. `CContractTable` (40476) is fetched with `DBObj::GetByEnum(23, 2, 0x10000010)` at acclient.c:210995 / 211211 / 211296 / 211674 (an earlier draft's 451670 cite was unrelated quest-def code).
- **Holtburger**: the transport exists — `apps/holtburger-web/index.html:8046-8048` handles `evt.kind === 34 /* ContractsUpdated */` from `GameEvent::SendClientContractTrackerTable`, and `plugins/contracts-panel.js` is registered (`:1360`, `:1529`, `:1844`). The **stage decode** is UNVERIFIED/ABSENT — in particular the `>= 4 ⇒ stage − 4` progress-counter rule and the three-way stage-3 split are the kind of thing a naive port renders as "stage 7".
- **Proposed change**: implement the four-branch decode exactly, including the delta-to-repeat formatting and the expiry→"Available" transition.
- **Payoff**: fidelity — the contracts panel is otherwise showing raw stage integers or a wrong label for every repeatable quest.
- **Effort**: S.
- **Validation**: `plugins/contracts-panel.js` render test across stages 1, 2, 3(×3 timer states), 4, 9; live ACE contract via `@` admin.

### OBJ-14 — `CharacterTitleTable` is a list, not a bitfield
- **Source**: `03-object-model.md` §9.
- **Retail**: `CharacterTitleTable` (37862) is `{unsigned mDisplayTitle; PList<ulong> mTitleList}` — **a list, not a bitfield**. `Pack` (498059) writes a literal `1`, then the display title, then the packed list. Names resolve through `EnumMapper::GetString(0x10000006, …)` at :498120 into string table `0x10000007` at :498138.
- **Holtburger**: the DAT ids are correct — `crates/holtburger-dat/src/well_known_ids.rs:106` `enum_mapper::CHARACTER_TITLE = 0x22000041` and `:147` `string_table::CHARACTER_TITLE = 0x2300000E`, cross-checked at `:259` / `:276`. Note these differ from the doc's `0x10000006` / `0x10000007`, which are **DB_TYPE type tags** passed to `GetByEnum`, not DIDs — exactly the §12 "type tags look like DIDs" trap. The **list-vs-bitfield** representation and the literal-`1` pack prefix are UNVERIFIED on our side; a title *display* select exists (`social-panel.js`, referenced in the deficiency report).
- **Proposed change**: confirm titles are modelled as a list (not a 64-bit mask, which is a common shortcut) and that the pack writes the literal `1` prefix. Record the type-tag-vs-DID distinction beside the constants so nobody "fixes" `0x22000041` to `0x10000006`.
- **Payoff**: correctness — a bitfield model silently caps the title count and cannot represent duplicate/ordered awards.
- **Effort**: S.
- **Validation**: title-select round-trip against the live ACE shard; assert a character with >64 titles works.

### OBJ-15 — books: `PageDataList` on `0xB4`, and the version escape
- **Source**: `03-object-model.md` §9.
- **Retail**: `PageData` / `PageDataList` (37608, 37621); `PackNoText` (510634); `UnPack` (510580) with a **version escape at :510599-510618**. Books arrive on **`0xB4`** using a **stack-local** `PageDataList` (394966).
- **Holtburger**: the *outbound actions* are complete — `crates/holtburger-protocol/src/messages/game_action.rs:111-115` `BookPageData` / `BookData` / `BookAddPage` / `BookModifyPage` / `BookDeletePage`, unpacked at `:390-404`. The **inbound `0xB4` `PageDataList` read** and the version escape are **UNVERIFIED**.
- **Proposed change**: verify inbound book data parses via a `PageDataList` with the version escape honoured (`PackNoText` means the page *text* may be absent in the list form and fetched per page — getting that wrong yields blank books).
- **Payoff**: correctness for readable in-world books/scrolls/signs, which are a large slice of AC's lore content.
- **Effort**: S.
- **Validation**: read a known in-world book headless; `validate_wire_conformance.cjs` on the `0xB4` capture.

### OBJ-16 — `BodyPartToString`: the `bp + 1` switch, tentacles, cloak, and the genuine gaps
- **Source**: `03-object-model.md` §10.
- **Retail**: `BodyPartEnumMapper::BodyPartToString` (508933) switches on **`bp + 1`** (an off-by-one that is easy to reproduce wrongly); the full map includes **`−1 UNDEFINED`**, 0–23, **24 UPPER_TENTACLE**, **25 LOWER_TENTACLE**, **26 CLOAK**, and **27 NUM**. **The gaps at 11 and 14 are genuine** — not decompiler damage, so a dense array indexed 0..27 must leave two holes.
- **Holtburger**: **UNVERIFIED/ABSENT** as a name mapper. Combat-message body-part naming is the consumer (retail's `0x1B2` handler passes `part` straight off the wire — see the §10 ledger row).
- **Proposed change**: add the mapper with the `bp + 1` switch reproduced, `−1` handled, the two tentacle entries and CLOAK present, and the 11/14 holes explicit (not silently collapsed).
- **Payoff**: fidelity in combat text ("You slash the Olthoi's upper tentacle") — a small but constantly-visible string surface.
- **Effort**: S.
- **Validation**: `__diag.combat`; unit-test all 29 inputs including −1 and the two gaps.

### OBJ-17 — `EmoteSet` / `Emote` category semantics (114 case labels)
- **Source**: `03-object-model.md` §10.
- **Retail**: `EmoteSet::UnPack` (448305) category semantics: **1 and 6 carry a `classID`; 5 style plus substyle; 2 `vendorType`; `0xC`, `0xD`, `0x16`, `0x17`, and the contiguous run `0x1B`–`0x26` a quest string; `0xF` min/max health floats**. `Emote::UnPack` (506750) switches on **114** distinct case labels, not "roughly 80". `Emote::cprof` **is** read by `Emote::IsValid` (505773) at :505874 (`case 3`), :505878 (`0x4A`), :505887 (`0x4C`) and for size computation at :506941/:506949/:506954.
- **Holtburger**: we went *beyond* retail here (retail's `CEmoteTable` is store-only) — `apps/holtburger-web/src/lib.rs:54700-54728` exposes a `CEmoteTable` taxonomy bridge with a wire parser at `crates/holtburger-protocol/src/messages/emote_table.rs`. The **per-category field semantics** and the full **114**-label coverage are UNVERIFIED against that parser.
- **Proposed change**: audit the parser's category coverage against the 114 labels and the six category groups above; add the missing ones. The `0x1B`–`0x26` contiguous quest-string run and the `0xF` health-float pair are the two most likely to be mis-sized (a wrong size desyncs the rest of the set).
- **Payoff**: correctness — since we actually *read* the emote table (unlike retail), a mis-sized category corrupts NPC behaviour data rather than being harmlessly ignored. This is a case where holtburger is **more exposed** than retail.
- **Effort**: M.
- **Validation**: parse every emote set in the live ACE world DB via the `worldbuilder-terminal` `ace-*` ingesters and assert zero size mismatches.

### OBJ-18 — `CreationProfile`: 24-byte wire layout ≠ C++ field order
- **Source**: `03-object-model.md` §10.
- **Retail**: `CreationProfile` (37478) `UnPack` (504048) fixes the wire layout at **24 bytes** — `wcid, palette, shade (float), destination, stack_size, try_to_bond`. **The C++ layout differs**: `try_to_bond` sits at offset **+8** but **serializes last**.
- **Holtburger**: **UNVERIFIED** — reached only through the emote path (OBJ-17), where `cprof.wcid.id` and `cprof.stack_size` are the read fields.
- **Proposed change**: pin the 24-byte wire order in the parser with an explicit comment that it is **not** the struct order, and a size assertion.
- **Payoff**: correctness — a struct-order read would swap `try_to_bond` with `destination`/`stack_size` and silently mis-size the record, cascading into OBJ-17's desync.
- **Effort**: S.
- **Validation**: a 24-byte fixture round-trip test.

### OBJ-19 — `PlayerModule` pack-header bits: `0x400` is 8-spell-lists, `0x80` is legacy timestamp
- **Source**: `03-object-model.md` §11 "Wire evolution".
- **Retail**: `SetPackHeader` (512804) decoded against `UnPack` (513178): `0x1` shortcuts; `0x4` **5** favorite-spell lists; `0x8` desired comps; `0x10` **7** favorite-spell lists; `0x20` spell filters (**absent ⇒ `0x3FFF`**); `0x40` options2 (**absent ⇒ 9733888**); **`0x80` timestamp format — read-only legacy, `SetPackHeader` never sets it**; `0x100` GenericQualitiesData; `0x200` gameplay options; **`0x400` 8 favorite-spell lists**. Earlier drafts put the 8-list case on `0x100` and the timestamp on `0x400` — both wrong, and `0x100` was simultaneously documented as GenericQualitiesData, an internal contradiction.
- **Holtburger**: **ABSENT** as a full module parse. `apps/holtburger-web/src/lib.rs:18100-18102` constructs the player options from `CharacterOptions1::empty()` / `CharacterOptions2::empty()` / `shortcuts: Vec::new()` — i.e. we build state from individual game actions/echoes rather than unpacking a `PlayerModule` blob.
- **Proposed change**: implement the `PlayerModule` unpack with these exact bits, including the two **absent-⇒-default** rules (`0x20` absent ⇒ `spell_filters = 0x3FFF`; `0x40` absent ⇒ `options2 = 9733888`) and the three favorite-spell-list generations (5 / 7 / 8) so an old character's saved module still loads.
- **Payoff**: correctness — favorite spells and spell filters are currently not restored from the server's module at all, and the absent-⇒-default rules are what make an old character's spellbook filters behave.
- **Effort**: M.
- **Validation**: `probe_k1_spellbook.cjs` / `probe_ws_addspell.cjs`; login a character with saved favorites against the live shard and assert they round-trip.

### OBJ-20 — CharacterOptions defaults: `0x50C4A54A` / `0x948700` / `spell_filters 0x3FFF`
- **Source**: `03-object-model.md` §11.
- **Retail**: `Default_CharacterOption = 0x50C4A54A` (acclient.h:3434; enum head 3404, top member `UseCraftSuccessDialog 0x80000000` at 3433, also `AutoAcceptFellowRequest 0x20000000`). `Default_CharacterOptions2 = 0x948700` (acclient.h:3479; enum head 3451). The constructor assigns **1355064650** and **9733888** at acclient.c:513741 / :513742, and `spell_filters_ = 0x3FFF` at :513743. (1355064650 = 0x50C4A54A; 9733888 = 0x948700.)
- **Holtburger**: `apps/holtburger-web/src/lib.rs:18100-18101` — `options1: CharacterOptions1::empty(), options2: CharacterOptions2::empty()` — **all bits zero**, not the retail defaults. `crates/holtburger-common/src/character.rs:39` (`HEAR_ALLEGIANCE_CHAT = 0x40000000`), `:73` (`DISPLAY_NUMBER_CHARACTER_TITLES = 0x00002000`), `:90` show the enums exist.
- **Proposed change**: seed the two masks with `0x50C4A54A` / `0x948700` and `spell_filters` with `0x3FFF` for a character that arrives without them.
- **Payoff**: correctness — a fresh character currently boots with **every** option off, so allegiance chat is muted, auto-accept-fellow is off, and every confirmation dialog behaves opposite to retail defaults. Highest-value/lowest-effort item in the object-model set.
- **Effort**: S.
- **Validation**: fresh-character headless login; assert `isCharacterOptionEnabled(0x0A)` (`RunAsDefaultMovement`, read at `apps/holtburger-web/scene3d/input.js:85`, `:153-169`) matches retail's default for that bit.

### OBJ-21 — `GetDefaultOptionValue` disagrees with the two masks on three options
- **Source**: `03-object-model.md` §11 (an explicit third-pass finding).
- **Retail**: **`GetDefaultOptionValue` is not the decomposition of the two masks.** The masks set **19** bits (12 + 7), but `GetDefaultOptionValue` (510998) returns 1 for only **16**: `{0, 2, 6, 8, 0xA, 0xD, 0xE, 0xF, 0x14, 0x15, 0x19, 0x1B, 0x23, 0x24, 0x25, 0x2A}`. The three defaulted-on options it returns **0** for are **`ConfirmVolatileRareUse` (`0x2D` / opt2 `0x40000`)**, **`ShowHelm` (`0x2F` / `0x100000`)**, and **`ShowCloak` (`0x32` / `0x800000`)`**.
- **Holtburger**: **ABSENT** — no `GetDefaultOptionValue` analog; consequence of OBJ-20 (we have no defaults at all).
- **Proposed change**: implement both sources of truth as retail has them, and **preserve the disagreement**: the mask defaults are what a fresh character gets; `GetDefaultOptionValue` is what the *options panel's "reset to default"* shows. Do not "fix" the three-option gap — it is real behaviour (ShowHelm/ShowCloak default on for the character but the panel's reset turns them off).
- **Payoff**: fidelity of the options panel; prevents a well-meaning unification from changing helm/cloak visibility defaults.
- **Effort**: S (depends on OBJ-20).
- **Validation**: options-panel reset test asserting the 16-vs-19 asymmetry on exactly those three ids.

### OBJ-22 — `PlayerOption` enum `0x00`–`0x33` (`TotalNumberOfPlayerOptions = 0x34`)
- **Source**: `03-object-model.md` §11.
- **Retail**: `PlayerOption` (acclient.h:4162-4217) covers `0x00`–`0x33` with `TotalNumberOfPlayerOptions = 0x34` (52 options). `AddShortCut` is at acclient.c:11067 and `SetToggleRun` at :11093.
- **Holtburger**: a **subset** only. `RunAsDefaultMovement 0x0A` (`apps/holtburger-web/scene3d/input.js:85`, `:153-169`, with wasm `isCharacterOptionEnabled` at `:167-169`); `UseFastMissiles 0x2B` (`apps/holtburger-web/scene3d/picking.js:1161-1168`, with the `SetSingleCharacterOption` send at `:1168`); `SetCharacterOption` command at `crates/holtburger-core/src/client/types.rs:605-606` and `apps/holtburger-web/src/lib.rs:22884-22895` (sub-opcode `0x0167`); shortcuts at `:22899-22915` (`AddShortcut` `0x019C`, `RemoveShortcut` `0x019D`).
- **Proposed change**: define the full 52-entry enum (index → mask bit → name) so the options panel can be generated from it, and so the two ad-hoc constants in `input.js` / `picking.js` read from one table.
- **Payoff**: maintainability + feature completeness; removes two magic numbers.
- **Effort**: M (mechanical).
- **Validation**: `validate_enum_parity.cjs`; round-trip each option against the live shard.

### OBJ-23 — `GenericQualitiesData`: 4-bit header, and exactly one key used client-side
- **Source**: `03-object-model.md` §11.
- **Retail**: four optional tables with a **4-bit header** — int 1, bool 2, float 4, string 8 (`Pack` at acclient.c:721265, bits at :721283-721290; the `CEnchantmentRegistry::pack_size` call there is an **IDA mislabel**). **Exactly one key is used client-side**: **string key `1`, the timestamp format**, written at :513085 and read at :513371.
- **Holtburger**: **ABSENT** — no `GenericQualitiesData` parse; consequence of OBJ-19.
- **Proposed change**: parse it with the 4-bit header and wire string key `1` to the chat timestamp format. **The value of this finding is the negative**: do not build a general per-player generic-qualities store — retail uses one string key, and `PlayerModule` bit `0x80` (the *other* timestamp path) is read-only legacy that `SetPackHeader` never sets. So there is exactly one writer and one reader.
- **Payoff**: chat timestamp format persistence, at minimal cost, with a clear scope boundary.
- **Effort**: S.
- **Validation**: set a timestamp format, relog, assert persistence.

### OBJ-24 — `m_colGameplayOptions` is DAT-driven (`UIOption` enums 21/22, hash key 210)
- **Source**: `03-object-model.md` §11.
- **Retail**: a `PackObjPropertyCollection` with **23 in-place buckets**; acclient.h:30260 is an **`IntrusiveHashTable`** (earlier drafts named the type wrongly, though the bucket count was right). The option set is **DAT-driven**: `UIOption::InqGameplayOptionProperty` (283650) reads **DBObj enum 21 and hash key 210**; defaults come from `InqDefaultGameplayOptionProperty` (283953) on **enum 22**. Known property names in the `0x1000xxxx` space: `0x1000007F` chat text-type filter, `0x10000080`/`0x81` opacity, `0x10000086`–`0x89` window geometry, `0x1000008C` the chat-option struct array (`GetChatOptionStructure`, 513787).
- **Holtburger**: **ABSENT** — window geometry and chat options are handled by our own layout/localStorage machinery (`apps/holtburger-web/ui/`, `test_ac_window_position_merge.mjs`, `test_config_merge.mjs`), not from the DATs.
- **Proposed change**: read the gameplay-option **schema and defaults** from the DATs (enums 21/22, key 210) rather than hardcoding, and map the five known `0x1000xxxx` properties onto our existing window-geometry/opacity/chat-filter state. Our `worldbuilder-terminal` `ui-*` suite already renders retail UI layouts from the DATs, so the reading side exists.
- **Payoff**: fidelity of default window placement/opacity and the chat text-type filter — the things that make a client "feel like AC" on first boot. Also removes hardcoded defaults.
- **Effort**: M.
- **Validation**: `worldbuilder-terminal` `ui-layout-list` / `ui-layout-render` cross-check; fresh-profile boot screenshot vs a retail reference.

### OBJ-25 — `Event_CharacterOptionsEvent` opcode 417 (`0x1A1`) on a 480-second dirty flush
- **Source**: `03-object-model.md` §11.
- **Retail**: the module ships via `Event_CharacterOptionsEvent`, opcode **417** (function 697664, opcode written at :697682 — agreeing with `04-combat-magic.md`'s `0x1A1`), on a **480-second dirty flush** (`CPlayerModule::UseTime`, 452827).
- **Holtburger**: we send **per-option** immediately via `SetSingleCharacterOption` (`0x0167`, `apps/holtburger-web/src/lib.rs:22884-22895`). The batched 417 flush is **ABSENT**.
- **Proposed change**: add the batched dirty-flush path (480 s) alongside the immediate per-option send. Retail used both: `IsAutoSaveOption` options fire immediately (see OBJ-26) and everything else batches.
- **Payoff**: correctness of persistence for non-autosave options (today a non-autosave change may be lost on disconnect) and a large reduction in per-option wire chatter for players who fiddle with settings.
- **Effort**: S.
- **Validation**: `__diag.wire` opcode count while toggling many options; relog and assert persistence.

### OBJ-26 — `CPlayerModule::OnChanged` has six arms plus an autosave tail
- **Source**: `03-object-model.md` §11 (third-pass correction: six arms, not four).
- **Retail**: `CPlayerModule::OnChanged` (452957): option **5 → `LScape::SetDay`**; **4 → `SmartBox::EnableWeather(v4 == 0)`** (note the inversion); **`0x30` → `LScape::m_fFogEnabled`**; **7 → `ClientCombatSystem::TrackTarget`**; **2** (IgnoreFellowshipRequests) **clears auto-accept**; **`0x12`** (auto-accept) **clears ignore** — a mutual-exclusion pair; plus an **`IsAutoSaveOption`** path that fires `Event_PlayerOptionChangedEvent` **immediately** instead of dirtying.
- **Holtburger**: **ABSENT** as a dispatch. Weather/fog/day toggles exist as URL flags and graphics settings (`apps/holtburger-web/ui/graphics_settings.js`, `scene3d/weather_state.js`, `daygroup_weather.js`) but are not driven from character options; the 2/`0x12` mutual exclusion is not modelled (`crates/holtburger-common/src/character.rs` has the bits but no cross-clearing).
- **Proposed change**: implement the six arms. The **2 ↔ `0x12` mutual exclusion** is the load-bearing one: without it a player can have both IgnoreFellowshipRequests and AutoAcceptFellowRequest set, which is a contradictory state retail structurally prevents. Also honour the `EnableWeather(v4 == 0)` inversion — a naive port turns weather on when the option says off.
- **Payoff**: correctness (the contradictory-state bug) + fidelity (options 4/5/`0x30` actually affecting the scene, and 7 driving target tracking).
- **Effort**: S–M.
- **Validation**: toggle each of the six headless and assert the observable (`__diag` weather/fog/day state, `target_cycle.js` tracking); assert setting 2 clears `0x12` and vice versa.

### OBJ-27 — correct the doc's four mis-inferred property names (holtburger is right)
- **Source**: `03-object-model.md` §3 "Property-ID literals" + §4 + §12. **This task is a correction to the deep-dive, not a code change.**
- **Retail / doc claim**: the doc marks `0x18` (available skill credits) and `0x1E` (buffed allegiance rank) as **in-binary** corroborated, and everything else as **inferred from call context and outside knowledge**. Among the inferred: `0x146` "+5 all skills aug", `0x158` "luminance specialized-skill aug", `0x16D` "**enlightenment**", `0x17B` "**vitality**".
- **Ground truth** (checked against `~/ace-server/Source/ACE.Entity/Enum/Properties/PropertyInt.cs`): `0x18 = 24 = AvailableSkillCredits` ✅ (`:43`); `0x1E = 30 = AllegianceRank` ✅ (`:53`); `0x146 = 326 = AugmentationJackOfAllTrades` (`:508`); `0x158 = 344 = LumAugSkilledSpec` (`:542`); **`0x16D = 365 = LumAugAllSkills`** (`:574`) — **not** Enlightenment, which is **390 = 0x186** (`:628`); **`0x17B = 379 = GearMaxHealth`** (`:602`) — **not** "vitality".
- **Holtburger**: already correct, and its arithmetic corroborates the retail behaviour the doc describes. `crates/holtburger-core/src/client/skill_info.rs:194` `base += LumAugAllSkills` (the doc's "unconditional enlightenment at :443634"), `:197-201` `AugmentationSkilledMelee/Missile/Magic × 10` (the doc's "+10 mastery, int 300/301/302"), `:231`/`:271` `AugmentationJackOfAllTrades × 5` (the doc's "+5 for 0x146"), `:292` `LumAugSkilledSpec × 2` Specialized-only (the doc's "+2 × 0x158 when `_sac == 3`"). `crates/holtburger-core/src/client/vital_info.rs:174` `max += GearMaxHealth` Health-only (the doc's "`0x17B` only when `stype == 1`").
- **Proposed change**: annotate the deep-dive's §3 table with the four ACE-enum names and note the two doc rows that were mis-inferred. Everything the doc says about *behaviour* at those ids stands; only the names were wrong. **Do not** "fix" holtburger toward the doc's names.
- **Payoff**: prevents a future agent from renaming correct code to match a wrong doc — the highest-leverage kind of REF finding.
- **Effort**: S (documentation).
- **Validation**: n/a — the corroboration above *is* the validation (two independent sources: ACE's enum and holtburger's arithmetic matching retail's described behaviour).

### OBJ-28 — `CBaseQualities` wire gate bits are a different order from struct order
- **Source**: `03-object-model.md` §3 + §12.
- **Retail**: **struct order** is `_weenie_type`, int, int64, bool, float, string, DID, IID, Position (acclient.h:37238-37249). **Wire gate bits are a different order** (`SetPackHeader`, acclient.c:447580-447597): **int `0x1`, bool `0x2`, float `0x4`, DID `0x8`, string `0x10`, Position `0x20`, IID `0x40`, int64 `0x80`**. `CBaseQualities::UnPack` (447729) reads the header at :447771, `_weenie_type` at :447777, and dispatches the gated tables from :447780.
- **Holtburger**: the eight typed maps exist (`crates/holtburger-world/src/entity.rs`), and per-message property ingest is field-driven, so this monolithic blob may never be parsed. **UNVERIFIED** whether any code path unpacks a `CBaseQualities` blob.
- **Proposed change**: if such a path exists, pin the eight gate bits in the declared **wire** order with a comment that it is deliberately *not* the struct order. If no such path exists, record the mapping in the wire-format notes for whenever one is added — this is a classic silent-desync source (a struct-order reader would read int64 where bool belongs).
- **Payoff**: correctness insurance on a high-fan-in decode.
- **Effort**: S.
- **Validation**: fixture round-trip with all eight tables present, then with sparse subsets.

### OBJ-29 — `StatType` enum and the `StatType << 16` timestamp key masks
- **Source**: `03-object-model.md` §3 "StatType" + §6.
- **Retail**: acclient.h:2879-2899 — `Undef 0`, Int 1, Float 2, Position 3, Skill 4, String 5, DID 6, IID 7, Attribute 8, Attribute2nd 9, **BodyDamageValue `0xA`, BodyDamageVariance `0xB`, BodyArmorValue `0xC`** (the third is *armor*, an easy mis-name), Bool `0xD`, Int64 `0xE`, `Num_StatTypes 0xF`. Corroborated by the `WTimeStamper` key masks, which are **exactly `StatType << 16`**: Int `0x10000`, Float `0x20000`, Position `0x30000`, Skill `0x40000`, String `0x50000`, DID `0x60000`, IID `0x70000`, Attribute `0x80000`, Attribute2nd `0x90000`, Bool `0xD0000`, Int64 `0xE0000`. Per-type update instantiations carry them: Skill `|0x40000` (391438/391460/391483), Int `|0x10000` (391505), Int64 `|0xE0000` (391528), Bool `|0xD0000` (391550), Float — none.
- **Holtburger**: **ABSENT** — property updates are handled per-opcode (`crates/holtburger-protocol/src/opcodes.rs:105-130`, `messages/game_message/unpack.rs:253-260`) with no unified `StatType` enum and no timestamp-key derivation.
- **Proposed change**: define `StatType` with these 15 values and derive timestamp keys as `(StatType << 16) | id`. This gives one keyspace for "when was property X last updated", which is what retail used to reject stale updates. **Note Float has no mask in the observed instantiations** — worth confirming rather than assuming `0x20000`.
- **Payoff**: correctness — a shared timestamp keyspace is the mechanism for dropping out-of-order property echoes, which we currently handle ad hoc (or not at all). Also documents the Bool/Int64 gap (`0xA`-`0xC` are body stats, so `0xD`/`0xE` are non-contiguous with the first eight).
- **Effort**: M.
- **Validation**: `validate_enum_parity.cjs`; inject out-of-order property updates and assert the stale one is dropped.

### OBJ-30 — the DID → DB_TYPE map, with the **bounded** COMBAT_TABLE range
- **Source**: `03-object-model.md` §5 + §12.
- **Retail**: `gmMasterDBMap::DivineType_Internal` (acclient.c:514291) is authoritative; constants at :42117-42132. Fifteen rows: `0x00000001`–`0x0000FFFF` → WEENIE_DEF `0x10000001`; `0x0E000002` CHAR_GEN; `0x0E000003` ATTRIBUTE_2ND_TABLE; `0x0E000004` SKILL_TABLE; `0x0E00000E` SPELL_TABLE; `0x0E00000F` SPELLCOMPONENT_TABLE; `0x0E000011` W_TREASURE_SYSTEM; `0x0E000018` XP_TABLE (`0x10000009`); `0x0E000019` W_CRAFT_TABLE; `0x0E00001B` QUEST_DEF_DB; `0x0E00001C` GAME_EVENT_DB; `0x0E00001D` CONTRACT_TABLE (`0x10000010`); `0x0E010000`–`0x0E01FFFF` QUALITY_FILTER; **`0x30000000`–`0x3000FFFF`** COMBAT_TABLE `0x1000000D`; `0x38000000`–`0x3800FFFF` MUTATE_FILTER. **The COMBAT_TABLE row is bounded, not open-ended** — an earlier draft's `>= 0x30000000` would swallow MUTATE_FILTER and everything above it; the `else` arm at :514297 tests `did.id > 0x3000FFFF` and excludes it. Confirmed identically in the 2015 build.
- **Holtburger**: no `DivineType`-style dispatch; DAT tables are reached by direct well-known DID (`crates/holtburger-dat/src/well_known_ids.rs`, e.g. `:106`/`:147`). **The DID ranges themselves are what matter** for any "what kind of thing is this DID" classifier.
- **Proposed change**: record the 15-row map (with the bounded COMBAT_TABLE) in `crates/holtburger-dat/src/well_known_ids.rs` as range constants + a `divine_type(did)` helper, and **note the §12 trap in a comment**: `0x10000004` / `0x10000009` etc. are **DB_TYPE type tags**, not DIDs — the real DIDs are `0x0E0000xx`.
- **Payoff**: correctness for DID classification (the CombatTable/MutateFilter boundary is exactly the kind of off-by-one that misroutes a whole table) + it kills the type-tag-vs-DID confusion at the source.
- **Effort**: S.
- **Validation**: unit test asserting `0x3000FFFF` → COMBAT_TABLE and `0x30010000` → not-COMBAT_TABLE; cross-check against `worldbuilder-terminal chorizite-parse-dat-record`.

### OBJ-33 — `OnStatUpdated` fires in seven instantiations, not two
- **Source**: `03-object-model.md` §6 (an explicit third-pass correction of a bolded false claim).
- **Retail**: **`OnStatUpdated` fires in seven instantiations** — 391375 (AttributeLevel), 391420 (Attribute2ndLevel), 391465 (SkillLevel), 391510 (Int), 391555 (Bool), 391627 (DataID), 391650 (InstanceID).
- **Holtburger**: the seven update paths all exist as opcodes and unpack (`crates/holtburger-protocol/src/opcodes.rs:105-130`), and per-vital/per-skill events exist (`test_per_vital_events.mjs`, `test_train_skill.mjs`). Whether a **single** change-notification fan-out fires for all seven is **UNVERIFIED** — the risk is that some of the seven (DataID and InstanceID are the likely omissions) update state without notifying dependents.
- **Proposed change**: audit that all seven emit one uniform "stat updated" notification; add the missing ones. **DataID** and **InstanceID** matter most: a DID change is what drives an appearance/icon refresh, and an IID change is what drives wielder/container re-parenting — precisely the two classes of bug where the model updates but the scene doesn't (cf. the `index.html:8210-8217` note about held-item re-parenting on a `Wielder` IID transition having been missed).
- **Payoff**: correctness — closes a family of "state changed, visuals didn't" bugs by construction.
- **Effort**: M.
- **Validation**: `__diag.events` diff; change each of the seven via `@` admin on the live shard and assert exactly one notification each plus the expected visual refresh.

### OBJ-34 — `PackableList<InventoryPlacement>` (container slot ordering)
- **Source**: `03-object-model.md` §7.
- **Retail**: `CObjectInventory` (acclient.h:33202) = `IDList _itemsList`, `IDList _containersList`, **`PackableList<InventoryPlacement>`** (33178). Three lists, not one — items, containers, and an explicit **placement** list.
- **Holtburger**: **ABSENT**. The only `InventoryPlacement`-adjacent site is `crates/holtburger-world/src/hydration.rs:225-228`, which is about `animation_frame`/`Placement` for *held-item grip pose* — a different `Placement`. Equipment is a `HashMap<Guid, EquipMask>` (`crates/holtburger-world/src/events.rs:42`), which has no ordering.
- **Proposed change**: model the third list. `InventoryPlacement` is what preserves **slot order within a pack** — without it, item order in a container is whatever the map iteration yields, so a player's carefully-arranged backpack reshuffles on every relog and after every add/remove.
- **Payoff**: correctness/UX — persistent inventory ordering is a thing players notice immediately.
- **Effort**: M.
- **Validation**: `diag_inventory_paperdoll.cjs`; add/remove/relog and assert slot order is stable.

### OBJ-35 — `ExperienceTable` (six sub-tables) and `GetExperienceForLevel`
- **Source**: `03-object-model.md` §4 "XP".
- **Retail**: **XP is table-driven.** `ExperienceSystem` (from 499328) loads via `DBObj::GetByEnum(3, 2, 0x10000009)` at :499332 — `0x10000009` is a **type tag**, the DID is **`0x0E000018`** (§5). `ExperienceTable` (acclient.h:59315-59328) holds `_level_table`, `_attribute_table`, `_attribute2nd_table`, `_trained_skill_table`, `_specialized_skill_table`, and `_credit_table` (`Credit_ExperienceType = 6`, acclient.h:7581). `GetExperienceForLevel` (501001) is a bounds-checked index.
- **Holtburger**: **UNVERIFIED/ABSENT** as a DAT-loaded table. `apps/holtburger-web/src/lib.rs:23355-23392` handles `AvailableExperience` / `AvailableSkillCredits` / attribute+skill raise costs and broadcasts `PrivateUpdateSkill` / `PrivateUpdateAttribute` / `PrivateUpdateAttribute2nd` — i.e. we know the *deltas* the server reports but may not have the **cost tables** locally.
- **Proposed change**: load the XP table from DID `0x0E000018` (six sub-tables) and use it for **client-side cost preview** — "raising this skill costs N XP", "you are M XP from level L". Retail had this locally, which is why the retail UI could show costs before you committed.
- **Payoff**: fidelity/UX — the train-skill and raise-attribute panels currently cannot show costs without a server round-trip. Also gives a client-side sanity check on server-reported costs.
- **Effort**: M.
- **Validation**: `test_train_skill.mjs`, `test_tradeskill.mjs`; compare computed costs against the live shard's accepted raises.

### OBJ-36 — `SmartBox`: the single-owner aggregate and `DispatchSmartBoxEvent`
- **Source**: `03-object-model.md` §2.
- **Retail**: `SmartBox` (acclient.h:35189, static instance at acclient.c:52134) owns **the viewer Position, `CameraManager`, `CellManager`, `CPhysics`, `CObjectMaint`, `LScape`, `Ambient`, the `CommandInterpreter`, and `player_id`/`player`**. Its three-entry vtable (acclient.h:35230-35235) is essentially `DispatchSmartBoxEvent` (acclient.c:143041). Also referenced from physics: `SmartBox::PlayerPhysicsUpdatedCallback` is what `CPhysics::UseTime` calls for the player (`01-physics.md` §2).
- **Holtburger**: **PARITY-OK-by-divergence, but worth recording as an architectural finding.** Our equivalent state is distributed: `WorldState` (`crates/holtburger-world`), `SpatialScene` (`spatial/scene.rs`), `MovementSystem` (`movement/system.rs`), `EntityManager` + `cameraSwitcher` (JS). The known symptom of not having one owner is the documented `liveScene3d-is-a-snapshot` trap (a one-time init snapshot, not a live facade) — `apps/holtburger-web/scene3d/rust_pose.js:10-11` and the memory note both record it.
- **Proposed change**: **not** to build a SmartBox — the distribution is deliberate and mostly good. The task is narrower: give the JS side **one live facade** with the SmartBox membership list as its checklist (viewer pose, camera, cells, physics, object registry, landscape, ambient, command interpreter, player id), so late-stamped subsystems stop reading `null` forever. Retail's membership list is the useful artefact here.
- **Payoff**: maintainability — closes the `liveScene3d` snapshot class of bug by construction rather than per-site.
- **Effort**: M.
- **Validation**: `test_init3d_idempotency_guard.mjs`; assert every listed member is non-null at `__bootState === 'in-world'` and stays live across a landblock change.

### OBJ-37 — `ACCObjectMaint::CreateObject` recycles both halves (object pooling)
- **Source**: `03-object-model.md` §1.
- **Retail**: creation goes `SmartBox::HandleCreateObject` (acclient.c:145881) → `ACCObjectMaint::CreateObject` (391856), which **recycles or builds** both halves, applies the WeenieDesc via `SetWeenieDesc` (391179), cross-links them, and for the player runs `init_player` and `enter_world`.
- **Holtburger**: entity creation allocates fresh (`crates/holtburger-world/src/entity.rs:1319-1323` default construction) and JS rigs are built per spawn. Some pooling exists on the render side — `apps/holtburger-web/scene3d/particles/particle_manager.js:688-700` documents a per-slot **material** pool added precisely because clone/dispose churn was "the GC source behind the sustained-combat cast stutter".
- **Proposed change**: recycle **entity records and rigs** on despawn/respawn the way retail recycled both halves, keyed by setup/appearance so a re-spawning creature of the same type reuses its rig. This is the same lesson the material pool already learned, applied one level up.
- **Payoff**: **perf** — spawn/despawn churn in busy areas and during combat is a known GC source; this is the retail technique for it. Complements the existing `landblock_lru`/`fixed_grid` residency work.
- **Effort**: M–L.
- **Validation**: `take_heapsnapshot` before/after a spawn-heavy soak (`capture_phase_d_spawns.cjs`, `smoke_wave3_keepalive.cjs`); assert allocation rate drops with no visual regression.

### OBJ-38 — `CObjectMaint`'s registries are deliberately different container types
- **Source**: `03-object-model.md` §1 + `01-physics.md` §1.
- **Retail**: `CObjectMaint` (acclient.h:33078) holds `object_table` / `null_object_table` / `weenie_object_table` / `null_weenie_object_table` as **`LongHash`**, `visible_object_table` as a **`HashSet`**, `destruction_object_table` as a **`HashTable<ulong,double,0>`** (id → time), plus `object_inventory_table`, **`lost_cell_table` (33082)**, and **`object_destruction_queue` (33090)**. The `null_*` pairs are the interesting part: retail explicitly tracks objects it has been told about but has **no data for**.
- **Holtburger**: entities live in one map (`crates/holtburger-world/src/entity.rs`; JS `entityMap`). We do have adjacent machinery — `apps/holtburger-web/scene3d/pre_create_buffer.js` and `test_a8_m4_pre_create_buffer.mjs` handle "events for an entity that hasn't spawned yet", which is functionally the `null_object_table`. `lost_cell_table` and a **timed** destruction table are **ABSENT**.
- **Proposed change**: (a) name our pre-create buffer as the `null_object_table` analog in comments so the correspondence is findable; (b) add a `lost_cell_table` (objects whose cell we don't have resident — currently these are probably just dropped, which is why an entity in an unloaded cell can vanish permanently instead of reappearing); (c) make destruction time-based (id → despawn time) rather than immediate, so a delete racing a re-create doesn't lose the object.
- **Payoff**: correctness — (b) and (c) are two known classes of "entity disappeared and never came back". The container-type differences are a hint that retail needed *timed* destruction and *deferred* cell association, not just presence sets.
- **Effort**: M.
- **Validation**: `test_diag_spawnfailed_lbkey.mjs`, `test_phase7_batch9_entity_lifecycle.mjs`; force a delete-then-create race headless and assert the entity survives.

### OBJ-39 — UI "base" skill values legitimately include enlightenment and mastery
- **Source**: `03-object-model.md` §4 (`InqSkill`).
- **Retail**: `InqSkill` (443603-443693) adds `_init_level + _level_from_pp` (:443631), `0x16D` (:443634) and **+10** mastery (switch opens :443637, cases to :443665) **unconditionally**. The `if (!raw)` block opens at **:443666** and gates **only** `EnchantSkill` (:443670), +5 for `0x146` (:443671), and +2 × `0x158` when `_sac == 3` (:443673). **So UI "base" values still include enlightenment and mastery.**
- **Holtburger**: arithmetically correct (`crates/holtburger-core/src/client/skill_info.rs:194`, `:197-201` in the `base` path; `:271`, `:292` in the `effective_base`/current path). What is unverified is whether our **UI labels** communicate this — a "Base" column that includes two augmentation bonuses is surprising unless you know retail did the same.
- **Proposed change**: no arithmetic change. Add a comment at the two call sites and, if the skill panel has a "base" tooltip, state that base includes `LumAugAllSkills` and the Skilled-augmentation +10 per retail. This exists purely to stop a future "bug report" from being fixed into a divergence.
- **Payoff**: prevents a regression that would look like a fix.
- **Effort**: S.
- **Validation**: n/a (documentation); the existing `skill_info.rs:525`, `:579-609`, `:682-711` tests already pin the behaviour.

### OBJ-40 — `ClothingTable::BuildObjDesc` is char-gen/barber only; in world the server sends complete ObjDescs
- **Source**: `03-object-model.md` §8.
- **Retail**: `ObjDesc : VisualDesc` (acclient.h:39630) is a base palette plus `Subpalette`, `TextureMapChange` and `AnimPartChange` lists. `ClothingTable::BuildObjDesc` feeds **char-gen preview** (call at :283284 inside `gmCG3DView::Update`, 283108) and **the barber**; **in world the server sends complete ObjDescs** (`HandleObjDescEvent`, 144356).
- **Holtburger**: **PARITY-OK** and worth recording as a *confirmed-correct architectural choice*. `apps/holtburger-web/src/lib.rs:5843-5846` states we apply what the server sends with "no need to walk inventory or parse `ClothingTable`", and the `ClothingTable` fetch at `:11689` exists for the dye/barber preview path — exactly retail's split. The raw-offset semantics are honoured at `:11864-11865` ("ClothingTable CloSubPaletteRange offset/numColors are already absolute (acclient BuildObjDesc copies them raw — **no /8**)"), which is a real trap correctly avoided.
- **Proposed change**: none. Record the division of responsibility in `docs/` so nobody "optimises" by building ObjDescs client-side in world (which would fight the server and desync appearance).
- **Payoff**: prevents a plausible-sounding refactor from breaking appearance.
- **Effort**: S (documentation).
- **Validation**: `test_recolor_escape_entmb.mjs`, `test_examine_dye_preview.mjs`, `__diag.clothing`.

---

# PART 3 — OPEN QUESTIONS

**OQ-1 — Is the 30 Hz outer gate a net perf win or a feel regression at 120 fps? (PHY-20)**
Retail gated the *entire* physics pass at 1/30 s (acclient.c:311352). Our integrator honours it but the manager block does not. Gating everything would halve manager cost at 60 fps — but our renderer runs at rAF rate and our camera/prediction lerps are tuned against a 30 Hz *emit* cadence (`apps/holtburger-web/scene3d/camera.js:1591`, `:1867`). Needs a live 1070 feel-test at 30/60/120 to answer whether a 30 Hz manager tick reads as "correct" or as "chunky". **Human/live test required.**

**OQ-2 — Does the retail quantum shape (0.2) actually reproduce ACE's MoveToManager turning bug? (PHY-08)**
`crates/holtburger-core/src/client/movement/system.rs:509-512` says the 0.1 ruling exists to "dodge ACE's documented MoveToManager-turning bug at 0.2". But retail *runs* at 0.2 (acclient.c:784235, verified) and did not have that bug — so the bug is in ACE's port, not the constant. Someone needs to reproduce the ACE bug at 0.2 with our `move_to.rs` (which is a decomp port, not an ACE port) and see whether it manifests at all. If it doesn't, `USE_RETAIL_QUANTUM` can flip and one of two quantum shapes can die. **Needs a live test + the DECISIONS-A1-O5 ruling reopened.**

**OQ-3 — Walk base speed: 2.602 (authored cycle) vs 3.1199999 (`get_state_velocity`).**
The doc's §5 gives `get_state_velocity` walk = **3.1199999** (acclient.c:343561) and run = **4.0** (:343565). Our `USE_INTERPRETED_VELOCITY` doc block (`movement/system.rs:551`) says ground velocity is "AUTHORED MotionData cycle base speed (**run 4.000 / walk 2.602**) × interpreted `speed_mod`". Run agrees; **walk does not** (2.602 vs 3.12 = 0.83×). Two readings are possible: (a) the authored human-MT walk cycle genuinely carries 2.602 and `WalkAnimSpeed 3.12` is the *anim-rate* multiplier applied elsewhere, so the two are not comparable; or (b) we are walking 17% slow. The `SIDESTEP_ADJUST_FACTOR` derivation (`common.rs:782-783`: `0.5 × (WalkAnimSpeed 3.1199999 / SidestepAnimSpeed 1.25) = 1.248`) treats 3.12 as the walk anim speed, which supports (a) — but then the ground velocity should be `3.12 × speed_mod`, not `2.602 × speed_mod`. **Needs someone to read `add_motion`/`get_state_velocity` composition end-to-end and measure walk speed against the live ACE shard's `UpdatePosition` deltas.** This is the single most likely remaining *quantitative* movement divergence.

**OQ-4 — Does `Float` really have no `WTimeStamper` mask? (OBJ-29)**
The doc's §6 per-type table lists timestamp masks for Skill/Int/Int64/Bool and an em-dash for **Float** (391563, mask column empty), while §3's mask list *does* include Float `0x20000`. Either the Float instantiation omits the mask (a retail inconsistency worth reproducing) or the doc's third pass simply didn't find it. **Needs a decomp re-read at acclient.c:391563.**

**OQ-5 — What is the `?maxTickDist` re-entry snap cost at 96 m? (PHY-04)**
Tightening 120 → 96 saves 36% of culled-band area but the comment at `entities.js:1944-1947` notes "A SMALLER value culls more distant entities' tick bodies (bigger time-budget win, **more re-entry snap**)". Retail had the same 96 and presumably the same snap; whether *our* re-entry (which involves dead-reckon/heading-ease targets rather than retail's `ACTIVE_TS` wake) snaps worse needs an eye-test. **Live A/B on the 1070.**

**OQ-6 — The deep-dive's own "not re-verified in the third pass" list.**
`03-object-model.md` §12 flags these as located but not read line-by-line, and they intersect real holtburger surfaces: the `0x1000xxxx` gameplay-property names beyond their constants (blocks OBJ-24 from being fully data-driven), the `InqGameplayOptionProperty` sub-property numbers **212/213/214** (OBJ-24 needs these — only key 210 is documented), `GetObjectName`'s pluralization and **"Backpack" substitution** (we render item names constantly and have no pluralization rule), the `EnchantInt`/`EnchantFloat` virtual family (OBJ-05 depends on it for the *values*, not just the highlight bits), and `CFactory::MakeCWeenieObject` / `ServerSaysMoveItem` (OBJ-34/OBJ-37 touch both). **A wave-2 decomp pass should close these five before OBJ-05/OBJ-24/OBJ-34 are attempted.**

**OQ-7 — Is our `find_cell_list`-equivalent ever above 10 cells? (PHY-14)**
Retail clamps to 10 silently. If our unbounded rebuild routinely sees 12-15 cells in portal-dense dungeons, then either (a) retail was quietly dropping collision geometry there and content was authored around it, or (b) retail never exceeded 10 and our count means our cell-flood predicate is too wide. These have opposite fixes. **Needs instrumentation on a live Town Network / Academy run before deciding.**

**OQ-8 — Do any of the three `PseudoEquipMask` composites have future callers we should coordinate with? (OBJ-01/OBJ-02)**
Both defective composites currently have **zero** callers, so fixing them is free — but if paperdoll/wardrobe work is in flight elsewhere it may already depend on the wrong values (e.g. treating boots as armour). **Worth a one-line check with whoever owns the inventory/paperdoll surface before the fix lands.**

---

# DISPOSITION TALLY

Counted mechanically from the Part-1 tables (final column of every `| §…` row).

| Disposition | `01-physics.md` | `03-object-model.md` | Total |
|---|---|---|---|
| **TASK(ids)** | 27 | 40 | **67** |
| **PARITY-OK** (incl. `-partial` / `-by-design` / `-with-note` / `-by-divergence`) | 67 | 15 | **82** |
| **REF-ONLY** | 7 | 15 | **22** |
| **N/A-WEB** | 0 | 1 | **1** |
| **UNVERIFIED** (located, not readable to a conclusion) | 0 | 1 | **1** |
| **Ledger rows** | **101** | **72** | **173** |

`01-physics.md` skews heavily PARITY-OK because holtburger already carries a
decomp-faithful `CTransition` port that is live and default-on; `03-object-model.md`
skews TASK because the social/housing/options/appraisal-formatting surfaces are
largely unbuilt.

**Distinct task entries written: 66** — `PHY-01 … PHY-27` + `PHY-31` (28) and
`OBJ-01 … OBJ-30`, `OBJ-33 … OBJ-40` (38). Gaps are deliberate: PHY-28/29/30 and
OBJ-31/32 were provisionally reserved during the read and then resolved to
PARITY-OK on verification (respectively: `z_for_landing`/`walkable_allowance`
raising, the stationary-fall failsafe, `IS_VIEWER` bit semantics; and the
quality-update / remove ordinals, which the opcode table verified clean). The ids
are left unused rather than renumbered so the ledger's `TASK(...)` references stay
stable.

Row count (67) exceeds distinct task ids (66 written, of which 55 are referenced
from the ledger) because several ledger rows fold into one task — e.g. the four
impulse-solver rows all point at PHY-01, and the two collision-reporting rows both
point at PHY-02.
