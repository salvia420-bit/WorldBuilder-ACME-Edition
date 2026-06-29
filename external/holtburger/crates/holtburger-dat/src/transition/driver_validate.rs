//! Phase-3 driver — transition validation + the top dispatcher (B2, agent A06).
//!
//! Decomp-faithful ports of:
//! - `CTransition::validate_transition`            (acclient.c:312194)
//! - `CTransition::validate_placement_transition`  (acclient.c:312355)
//! - `CTransition::find_valid_position`            (acclient.c:313419)
//!
//! ## Reconciliation to the B2a foundation + B2b spine
//! The small helpers A06 carried inline now live in their proper homes (all
//! landed in this stage): `ObjectInfo::{is_valid_walkable,kill_velocity}`
//! (`objectinfo.rs`), `SpherePath::{set_check_pos,cache_global_curr_center}`
//! (`spherepath_methods.rs`), `CollisionInfo::init` (`collisioninfo.rs`),
//! `Frame::is_equal` (`frame_transform.rs`). `build_cell_array` is the real B2c
//! port (cell-world threaded). `find_{transitional,placement}_position` are B3.
//!
//! ## Object-physics seam (kill_velocity / gravity)
//! The decomp reaches the moving object's `CPhysicsObj` through
//! `object_info.object`. `kill_velocity` is a faithful no-op here (CPhysicsObj
//! velocity is B3 — see `ObjectInfo::kill_velocity`). The one remaining live
//! query is `object->state & GRAVITY_PS` (0x400, acclient.c:312274), threaded as
//! [`MovingObjectPhysics`] (B3/A13). `world: &dyn CellWorld` is threaded for
//! `build_cell_array` (design decision #2).

use super::frame_transform::Frame;
use super::objcell::CellWorld;
use super::types::{
    object_info_state, CTransition, InsertType, TransitionState, EPSILON, Z_FOR_LANDING,
};
use holtburger_common::{Plane, Vector3};

/// Raw resolver `int` codes used by the B3 search loops (1=OK 2=COLLIDED).
const OK: i32 = TransitionState::Ok as i32;
const COLLIDED: i32 = TransitionState::Collided as i32;

/// SEAM (B3 / A13 — `CPhysicsObj`): the one moving-object physics query the
/// validation path still needs live. `object_info.object->state & GRAVITY_PS`
/// (0x400) — is the moving object gravity-affected? (acclient.c:312274.)
pub trait MovingObjectPhysics {
    fn has_gravity(&self) -> bool;
}

impl CTransition {
    /// `CTransition::validate_transition` (acclient.c:312194). The normal-path
    /// state machine run after every swept step: settle the contact plane, kill
    /// velocity / re-pin the last-known plane on a non-OK step, detect the
    /// falling-but-stationary edge case, and recompute the CONTACT / ON_WALKABLE
    /// object-state bits. `redo` is written `false` and never rewritten (the
    /// out-param is unused by this method; A15/A06 — the decompiler's `redoa` is
    /// the recycled `ts` slot, the internal flag `redoa` below). Returns the
    /// (possibly promoted-to-`Ok`) `TransitionState`.
    // acclient.c:312194
    pub fn validate_transition(
        &mut self,
        ts: TransitionState,
        redo: &mut bool,
        world: &dyn CellWorld,
        phys: &dyn MovingObjectPhysics,
    ) -> TransitionState {
        *redo = false; // out-param never changed again
        let mut redoa = true; // decomp: redoa = 1
        let mut v3 = ts; // returned at the end

        // Top condition: A1 && (redoa = 0, ts != Ok). `||`/`&&` short-circuit
        // exactly as the decomp (is_equal reached only when ts==Ok and the
        // objcell ids already match). acclient.c:312218-312221.
        let a1 = ts != TransitionState::Ok
            || (self.sphere_path.check_pos.objcell_id == self.sphere_path.curr_pos.objcell_id
                && self
                    .sphere_path
                    .check_pos
                    .frame
                    .is_equal(&self.sphere_path.curr_pos.frame));
        let take_branch_a = if a1 {
            redoa = false; // the `redoa = 0` comma side-effect
            ts != TransitionState::Ok
        } else {
            false // A1 false → right side not evaluated → redoa stays true
        };

        if take_branch_a {
            // ── BRANCH A: ts != Ok (acclient.c:312223-312254) ──
            if (ts as i32) > 1 && (ts as i32) <= 4 {
                if let Some(lk) = self.collision_info.last_known_contact_plane {
                    self.object_info.kill_velocity(); // SEAM(B3): CPhysicsObj

                    // radius + EPSILON > |global_curr_center · N + d| ?
                    let gcc = self.sphere_path.global_curr_center;
                    let dist =
                        gcc.x * lk.normal.x + gcc.y * lk.normal.y + gcc.z * lk.normal.z + lk.d;
                    if self.sphere_path.global_sphere[0].radius + EPSILON > dist.abs() {
                        let is_water = self.collision_info.last_known_contact_plane_is_water;
                        self.collision_info.set_contact_plane(lk, is_water);
                        self.collision_info.contact_plane_cell_id =
                            self.collision_info.last_known_contact_plane_cell_id;
                        if self.object_info.state & object_info_state::ON_WALKABLE != 0 {
                            redoa = true; // decomp: if (state & 2) redoa = 1
                        }
                    }
                }

                if self.collision_info.collision_normal.is_none() {
                    self.collision_info
                        .set_collision_normal(Vector3::new(0.0, 0.0, 1.0));
                }

                // set_check_pos(&curr_pos, curr_cell) — copy out first (Copy).
                let curr_pos = self.sphere_path.curr_pos;
                let curr_cell = self.sphere_path.curr_cell;
                self.sphere_path.set_check_pos(&curr_pos, curr_cell);

                self.build_cell_array(world, None); // CTransition::build_cell_array(this, 0)
                v3 = TransitionState::Ok; // v3 = 1
            }
        } else {
            // ── BRANCH B: ts == Ok (or position changed) (acclient.c:312256-312268) ──
            let v5 = self.sphere_path.check_cell;
            self.sphere_path.curr_pos.objcell_id = self.sphere_path.check_pos.objcell_id;
            self.sphere_path.curr_pos.frame = self.sphere_path.check_pos.frame;
            self.sphere_path.curr_cell = v5;
            self.sphere_path.cache_global_curr_center();
            // check_pos<-curr_pos / check_cell<-curr_cell (no-ops after the copy
            // above, but ported verbatim).
            let v6 = self.sphere_path.curr_cell;
            self.sphere_path.check_pos.objcell_id = self.sphere_path.curr_pos.objcell_id;
            self.sphere_path.check_pos.frame = self.sphere_path.curr_pos.frame;
            self.sphere_path.check_cell = v6;
            self.sphere_path.cell_array_valid = false;
            self.sphere_path.cache_global_sphere(None);
        }

        // ── Common tail (acclient.c:312270-312350) ──
        if let Some(cn) = self.collision_info.collision_normal {
            self.collision_info.set_sliding_normal(cn);
        }

        if self.object_info.state & object_info_state::IS_VIEWER == 0 {
            // object_info.object->state & GRAVITY_PS (0x400) — SEAM.
            if phys.has_gravity() {
                if redoa {
                    self.collision_info.frames_stationary_fall = 0;
                } else {
                    let v8 = self.collision_info.frames_stationary_fall;
                    if v8 != 0 {
                        if v8 == 1 {
                            self.collision_info.frames_stationary_fall = 2;
                        } else {
                            // v8 >= 2: synthesize a flat resting floor.
                            let gsphere = self.sphere_path.global_sphere[0];
                            self.collision_info.frames_stationary_fall = 3;
                            let v11 = gsphere.center.z; // (x+y)*0.0 + z artifact → z
                            let n = Vector3::new(0.0, 0.0, 1.0);
                            let plane = Plane {
                                normal: n,
                                d: gsphere.radius - v11,
                            };
                            self.collision_info.set_contact_plane(plane, false);
                            let not_in_contact =
                                self.object_info.state & object_info_state::CONTACT == 0;
                            self.collision_info.contact_plane_cell_id =
                                self.sphere_path.check_pos.objcell_id;
                            if not_in_contact {
                                self.collision_info.set_collision_normal(n);
                                self.collision_info.collided_with_environment = true;
                            }
                        }
                    } else {
                        self.collision_info.frames_stationary_fall = 1;
                    }
                }
            }
        }

        // last_known_contact_plane = contact_plane (valid mirrors); copy the
        // companions only when the plane is valid. acclient.c:312317-312329.
        self.collision_info.last_known_contact_plane = self.collision_info.contact_plane;
        if self.collision_info.contact_plane.is_some() {
            self.collision_info.last_known_contact_plane_cell_id =
                self.collision_info.contact_plane_cell_id;
            self.collision_info.last_known_contact_plane_is_water =
                self.collision_info.contact_plane_is_water;
        }

        // Recompute CONTACT / ON_WALKABLE from the contact plane.
        // acclient.c:312330-312350.
        if let Some(cp) = self.collision_info.contact_plane {
            self.object_info.state |= object_info_state::CONTACT;
            if self.object_info.is_valid_walkable(&cp.normal) {
                self.object_info.state |= object_info_state::ON_WALKABLE;
            } else {
                self.object_info.state &= !object_info_state::ON_WALKABLE;
            }
        } else {
            self.object_info.state &=
                !(object_info_state::CONTACT | object_info_state::ON_WALKABLE);
        }

        v3
    }

    /// `CTransition::validate_placement_transition` (acclient.c:312355). The
    /// simplified placement path: sync curr⟵check on an OK placement, or reset
    /// the collision accumulators when a non-OK placement is allowed to slide.
    /// Returns `2` (no candidate cell), else `ts`. `redo` is set false / unused.
    // acclient.c:312355
    pub fn validate_placement_transition(&mut self, ts: TransitionState, redo: &mut bool) -> i32 {
        *redo = false;
        let v3 = self.sphere_path.check_cell;
        if v3.is_none() {
            return 2; // no candidate cell → COLLIDED
        }
        if ts == TransitionState::Ok {
            self.sphere_path.curr_pos.objcell_id = self.sphere_path.check_pos.objcell_id;
            self.sphere_path.curr_pos.frame = self.sphere_path.check_pos.frame;
            self.sphere_path.curr_cell = v3;
            self.sphere_path.cache_global_curr_center();
        } else if (ts as i32) > 1 && (ts as i32) <= 4 && self.sphere_path.placement_allows_sliding {
            self.collision_info.init();
            return ts as i32;
        }
        ts as i32
    }

    /// `CTransition::find_valid_position` (acclient.c:313419). Dispatcher on
    /// `insert_type`: any placement variant (`insert_type != Transition`) →
    /// placement search; `Transition` → transitional search. Returns the
    /// search's `int` (nonzero = a valid position was found).
    // acclient.c:313419
    pub fn find_valid_position(
        &mut self,
        world: &dyn CellWorld,
        phys: &dyn MovingObjectPhysics,
    ) -> i32 {
        if self.sphere_path.insert_type != InsertType::Transition {
            self.find_placement_position(world, phys) // SEAM(B3): A04
        } else {
            self.find_transitional_position(world, phys) // SEAM(B3): A03
        }
    }

    /// `CTransition::find_placement_position` (acclient.c:313341, A04). The
    /// placement wrapper: initial-placement insert (`insert_into_cell` +
    /// `check_other_cells`) → `validate_placement` → radial `find_placement_pos`
    /// → optional `step_down` settle → final `validate_placement`. Returns `1`
    /// iff the object settles into a validated placement, else `0`. `phys` is
    /// unused (the decomp's placement path takes no gravity query).
    // acclient.c:313341
    fn find_placement_position(
        &mut self,
        world: &dyn CellWorld,
        _phys: &dyn MovingObjectPhysics,
    ) -> i32 {
        // 313356-313360: candidate ← current accepted position.
        let cur_pos = self.sphere_path.curr_pos;
        let cur_cell = self.sphere_path.curr_cell;
        self.sphere_path.set_check_pos(&cur_pos, cur_cell);
        // 313362: initial-placement insert mode.
        self.sphere_path.insert_type = InsertType::InitialPlacement;

        // 313361-313372: insert into the check cell + its neighbours.
        let check_cell = self.sphere_path.check_cell;
        let ts = if check_cell.is_some() {
            let cell = check_cell.and_then(|id| world.get_visible(id));
            let v5 = self.insert_into_cell(cell.as_deref(), 3);
            if v5 == OK {
                self.check_other_cells(world, self.sphere_path.check_cell)
            } else {
                v5
            }
        } else {
            COLLIDED // 313371
        };

        // 313373-313374: validate (with adjust); bail if not OK.
        if self.validate_placement(world, ts, true) != OK {
            return 0;
        }

        // 313375-313377: switch to placement mode, run the radial search.
        self.sphere_path.insert_type = InsertType::Placement;
        if !self.find_placement_pos(world) {
            return 0;
        }

        // 313378: no step-down configured → just validate.
        if !self.object_info.step_down {
            return (self.validate_placement(world, OK, true) == OK) as i32; // 313415
        }

        // 313380-313390: prepare step-down.
        let mut step_down_ht = self.object_info.step_down_height;
        self.sphere_path.walkable_allowance = Z_FOR_LANDING;
        self.sphere_path.save_check_pos();
        self.sphere_path.backup = self.sphere_path.insert_type;
        self.sphere_path.insert_type = InsertType::Transition;
        if self.sphere_path.num_sphere < 2 {
            let r = self.sphere_path.global_sphere[0].radius;
            if r + r < step_down_ht {
                step_down_ht = r * 0.5;
            }
        }

        // 313391-313406: one or two descent attempts. The decomp's else-branch
        // `if (step_down(half)) goto LABEL_18` short-circuit is the `&&` below
        // (first success skips the second attempt AND the rewind).
        let r = self.sphere_path.global_sphere[0].radius;
        if r + r >= step_down_ht {
            if self.step_down(world, step_down_ht, Z_FOR_LANDING) == 0 {
                self.sphere_path.restore_check_pos();
                self.collision_info.contact_plane = None;
                self.collision_info.contact_plane_is_water = false;
            }
        } else {
            let half = step_down_ht * 0.5;
            if self.step_down(world, half, Z_FOR_LANDING) == 0
                && self.step_down(world, half, Z_FOR_LANDING) == 0
            {
                self.sphere_path.restore_check_pos();
                self.collision_info.contact_plane = None;
                self.collision_info.contact_plane_is_water = false;
            }
        }

        // LABEL_18 (313400-313403): restore insert type, clear walkable, validate.
        self.sphere_path.insert_type = self.sphere_path.backup;
        self.sphere_path.walkable = None;
        (self.validate_placement(world, OK, true) == OK) as i32
    }

    /// `CTransition::find_transitional_position` (acclient.c:313171, A03). THE
    /// swept-step driver search: split the begin→end motion into `calc_num_steps`
    /// increments, and per step `adjust_offset` the per-step offset, interpolate
    /// orientation, advance `check_pos`, `transitional_insert`, and
    /// `validate_transition`. The canonical caller of `validate_transition`.
    /// Returns `1` on a clean transition, `0` on a blocked/failed one.
    ///
    /// Control-flow: the decomp's `goto LABEL_20/29/19` collapse to `return 1` /
    /// `return 0` / `return (ts == Ok) as i32` respectively (LABEL_19 = "succeed
    /// iff the last transition state was OK").
    // acclient.c:313171
    fn find_transitional_position(
        &mut self,
        world: &dyn CellWorld,
        phys: &dyn MovingObjectPhysics,
    ) -> i32 {
        // begin_cell == null → fail outright (313203).
        if self.sphere_path.begin_cell.is_none() {
            return 0;
        }

        let mut ts: i32 = TransitionState::Ok as i32; // ts starts OK (313205)
        // `redo` is a write-only out-param the validators set false; the decomp's
        // step-index writes are dead. One bool covers every call site.
        let mut redo = false;

        // calc_num_steps → offset, offset_per_step, num_steps (313207).
        let (offset, mut offset_per_step, num_steps) = self.calc_num_steps();

        // FREE_ROTATE (0x10): snap curr_pos orientation to the end up front
        // (313208-313214). SEAM(B4): Frame carries no quaternion — see
        // `frame_orient_snap`.
        if self.object_info.state & object_info_state::FREE_ROTATE != 0 {
            let end = self.sphere_path.end_pos.frame;
            frame_orient_snap(&mut self.sphere_path.curr_pos.frame, &end);
        }

        // check_pos := curr_pos ; check_cell := curr_cell (313215-313221).
        self.sphere_path.check_pos.objcell_id = self.sphere_path.curr_pos.objcell_id;
        self.sphere_path.check_pos.frame = self.sphere_path.curr_pos.frame;
        self.sphere_path.check_cell = self.sphere_path.curr_cell;
        self.sphere_path.cell_array_valid = false;
        self.sphere_path.cache_global_sphere(None);

        if num_steps == 0 {
            // No motion (313223-313237).
            if self.object_info.state & object_info_state::FREE_ROTATE == 0 {
                let end = self.sphere_path.end_pos.frame;
                frame_orient_snap(&mut self.sphere_path.curr_pos.frame, &end);
            }
            let curr_pos = self.sphere_path.curr_pos;
            let curr_cell = self.sphere_path.curr_cell;
            self.sphere_path.set_check_pos(&curr_pos, curr_cell);
            self.sphere_path.cell_array_valid = true;
            self.sphere_path.hits_interior_cell = false;
            // find_cell_list(&cell_array, NULL, &path) ≡ build_cell_array(world, None).
            self.build_cell_array(world, None); // 313235
            return 1;
        }

        // num_steps > 0 — the stepping loop (313238-313318).
        let mut i: u32 = 0; // v4
        loop {
            let state = self.object_info.state; // re-read each iteration (v12)

            // IS_VIEWER (0x4): on the LAST step, rescale offset_per_step to land
            // exactly on the target (313243-313262).
            if state & object_info_state::IS_VIEWER != 0 {
                let last = num_steps - 1; // v7
                if i == last {
                    let dist = length_f64(offset); // v8 = |offset|
                    if dist > EPSILON as f64 {
                        let radius = self.sphere_path.local_sphere[0].radius as f64; // v9
                        let scale = (dist - radius * last as f64) / dist; // v10
                        offset_per_step = Vector3::new(
                            (offset.x as f64 * scale) as f32,
                            (offset.y as f64 * scale) as f32,
                            (offset.z as f64 * scale) as f32,
                        );
                    }
                }
            }

            // Adjust the raw per-step offset against contact/sliding state (313264).
            self.sphere_path.global_offset = self.adjust_offset(offset_per_step);

            // Non-IS_VIEWER: stop the search the moment the adjusted step points
            // UP (313269-313274). `!(c0|c3)` from `ftst` == `z > 0`.
            //
            // E1b/WS-B: this is the VERBATIM faithful decomp early-stop. E1 v1
            // relaxed it with an `allow_contact_stepup = faithful_stepup && CONTACT`
            // bypass — that hook was refuted by the recon as a live no-op (the
            // grounded mover walks dz=0, so `global_offset.z > 0.0` never fires on a
            // flat-floor frame and the bypass changed nothing; ON==OFF byte-identical
            // in play). The genuine vertical-lip step-up is restored in WS-C by
            // fixing the `ON_WALKABLE` precondition so the emergent
            // `step_sphere_down`/`adjust_sphere_to_plane` chain lifts the mover; the
            // `?stepUp` / `faithful_stepup` flag now gates THAT fix, not this gate.
            if state & object_info_state::IS_VIEWER == 0 && self.sphere_path.global_offset.z > 0.0 {
                if i == 0 {
                    return 0; // LABEL_29
                }
                return (ts == TransitionState::Ok as i32) as i32; // LABEL_19
            }

            // Non-FREE_ROTATE: interpolate orientation toward the target at
            // t = (i+1)/num_steps (313275-313284). SEAM(B4): see
            // `frame_orient_interp`.
            if state & object_info_state::FREE_ROTATE == 0 {
                let t = (i + 1) as f32 / num_steps as f32;
                let begin = self.sphere_path.begin_pos.frame;
                let end = self.sphere_path.end_pos.frame;
                frame_orient_interp(&mut self.sphere_path.check_pos.frame, &begin, &end, t);
            }

            // Clear per-step collision scratch (313285-313287).
            self.collision_info.sliding_normal = None;
            self.collision_info.contact_plane = None;
            self.collision_info.contact_plane_is_water = false;

            if self.sphere_path.insert_type != InsertType::Transition {
                // ── PLACEMENT branch (313288-313297). ──
                let v19 = self.transitional_insert(world, 3);
                ts = self
                    .validate_placement_transition(TransitionState::from_i32(v19), &mut redo);
                if ts == TransitionState::Ok as i32 {
                    return 1; // LABEL_20
                }
                if !self.sphere_path.placement_allows_sliding {
                    return 0; // LABEL_29
                }
                let go = self.sphere_path.global_offset;
                self.sphere_path.add_offset_to_check_pos(&go);
            } else {
                // ── TRANSITION branch (313298-313311). ──
                self.sphere_path.cell_array_valid = false;
                let go = self.sphere_path.global_offset;
                self.sphere_path.check_pos.frame.origin.x += go.x;
                self.sphere_path.check_pos.frame.origin.y += go.y;
                self.sphere_path.check_pos.frame.origin.z += go.z;
                self.sphere_path.cache_global_sphere(Some(&go));
                let v18 = self.transitional_insert(world, 3);
                ts = self
                    .validate_transition(TransitionState::from_i32(v18), &mut redo, world, phys)
                    as i32;
                if self.collision_info.frames_stationary_fall != 0 {
                    return (ts == TransitionState::Ok as i32) as i32; // LABEL_19
                }
            }

            // Shared: a hard collision while PATH_CLIPPED (0x8) ends the search
            // (313312-313313).
            if self.collision_info.collision_normal.is_some()
                && state & object_info_state::PATH_CLIPPED != 0
            {
                return (ts == TransitionState::Ok as i32) as i32; // LABEL_19
            }

            // Advance / bound check (313314-313317).
            i += 1;
            if i >= num_steps {
                return (ts == TransitionState::Ok as i32) as i32; // LABEL_19
            }
        }
    }

    /// `CTransition::calc_num_steps` (acclient.c:311764, A03). Splits the
    /// begin→end motion into a per-step offset and a step count. On IS_VIEWER
    /// (0x4): `steps = floor(dist/radius) + 1` (fine continuous sweep); else
    /// `steps = ceil(dist/radius)` when `dist/radius > 1`, a single whole-offset
    /// step, or 0 for a zero move. Returns `(offset, offset_per_step, num_steps)`.
    ///
    /// A15 R5 guard: a zero/tiny `local_sphere[0].radius` would make `dist/radius`
    /// explode into an enormous (finite) step count; we guard `radius > EPSILON`
    /// before dividing and treat a sub-epsilon radius as a single whole-offset
    /// step (the decomp ships no zero-radius movers, so this only bounds misuse).
    // acclient.c:311764
    pub fn calc_num_steps(&self) -> (Vector3, Vector3, u32) {
        // offset = end - begin (+ cross-cell block offset) — 311790.
        let offset = self
            .sphere_path
            .begin_pos
            .get_offset(&self.sphere_path.end_pos);
        let radius = self.sphere_path.local_sphere[0].radius; // v7
        let dist = length_f64(offset); // v8 = |offset|

        // A15 R5: never divide by a zero/tiny radius. A degenerate radius
        // collapses to the "single whole-offset step (or none)" regime.
        if radius <= EPSILON {
            return if offset.x != 0.0 || offset.y != 0.0 || offset.z != 0.0 {
                (offset, offset, 1)
            } else {
                (offset, Vector3::zero(), 0)
            };
        }

        if self.object_info.state & object_info_state::IS_VIEWER != 0 {
            // 311796-311818
            if dist <= EPSILON as f64 {
                (offset, Vector3::zero(), 0)
            } else {
                let v9 = dist / radius as f64; // dist/radius
                let inv = 1.0 / v9;
                let ops = Vector3::new(
                    (inv * offset.x as f64) as f32,
                    (inv * offset.y as f64) as f32,
                    (inv * offset.z as f64) as f32,
                );
                (offset, ops, v9.floor() as u32 + 1)
            }
        } else {
            // 311820-311848
            let v15 = dist / (1.0 * radius as f64); // dist/radius
            if v15 > 1.0 {
                let v16 = v15.ceil();
                let inv = 1.0 / v16;
                let ops = Vector3::new(
                    (inv * offset.x as f64) as f32,
                    (inv * offset.y as f64) as f32,
                    (inv * offset.z as f64) as f32,
                );
                (offset, ops, v16 as u32)
            } else if offset.x != 0.0 || offset.y != 0.0 || offset.z != 0.0 {
                (offset, offset, 1)
            } else {
                (offset, Vector3::zero(), 0)
            }
        }
    }
}

/// `sqrt(x²+y²+z²)` accumulated in `f64`, matching the decomp's `long double`
/// length math (the same convention as `normalize_check_small`). Step-count
/// `floor`/`ceil` boundary determinism depends on it.
#[inline]
fn length_f64(v: Vector3) -> f64 {
    (v.x as f64 * v.x as f64 + v.y as f64 * v.y as f64 + v.z as f64 * v.z as f64).sqrt()
}

/// SEAM(B4): `Frame::set_rotate` (acclient.c:357063) snaps `dst`'s orientation
/// to `src`'s from `src`'s quaternion. The holtburger `Frame` carries no
/// quaternion, so we copy the `fl2gv` basis directly (origin untouched) — exact
/// for the pure-translation sweeps every synthetic scene uses (begin/end share
/// an orientation). A genuine reorientation needs the B4 quaternion path.
fn frame_orient_snap(dst: &mut Frame, src: &Frame) {
    dst.fl2gv = src.fl2gv;
}

/// SEAM(B4): `Frame::interpolate_rotation` (acclient.c:357258) SLERPs `dst`'s
/// orientation from `begin`→`end` at fraction `t`. Without the quaternion we
/// reproduce the exact result for equal begin/end orientation (that shared
/// basis); a genuine reorientation is approximated by snapping to `end` (B4
/// owns the real SLERP). `dst`'s origin is untouched.
fn frame_orient_interp(dst: &mut Frame, begin: &Frame, end: &Frame, _t: f32) {
    dst.fl2gv = if begin.fl2gv == end.fl2gv {
        begin.fl2gv
    } else {
        end.fl2gv
    };
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::objcell::{CObjCell, CellArrayApi};
    use super::super::types::{object_info_state, Position, SpherePath};
    use holtburger_common::Sphere;
    use std::rc::Rc;

    fn v(x: f32, y: f32, z: f32) -> Vector3 {
        Vector3::new(x, y, z)
    }
    const TOL: f32 = 1e-4;
    fn approx(a: Vector3, b: Vector3) -> bool {
        (a.x - b.x).abs() < TOL && (a.y - b.y).abs() < TOL && (a.z - b.z).abs() < TOL
    }

    struct Phys(bool);
    impl MovingObjectPhysics for Phys {
        fn has_gravity(&self) -> bool {
            self.0
        }
    }

    // A no-cell world; build_cell_array's find_cell_list runs but seeds nothing
    // (curr cell 0 → no visible cell, outdoor branch no-ops). The branch-A tests
    // assert set_check_pos effects, not cell_array contents.
    struct NoWorld;
    impl CellWorld for NoWorld {
        fn get_visible(&self, _id: u32) -> Option<Rc<dyn CObjCell>> {
            None
        }
        fn add_all_outside_cells(
            &self,
            _p: &Position,
            _n: u32,
            _s: &[Sphere],
            _ca: &mut dyn CellArrayApi,
        ) {
        }
        fn block_offset(&self, _b: u32, _o: u32) -> Vector3 {
            Vector3::zero()
        }
    }

    fn one_sphere_path(c: Vector3, radius: f32) -> SpherePath {
        let mut sp = SpherePath::default();
        sp.num_sphere = 1;
        sp.local_sphere[0] = Sphere { center: c, radius };
        sp.global_sphere[0] = Sphere { center: c, radius };
        sp.global_curr_center = c;
        sp
    }

    #[test]
    fn validate_transition_branch_b_syncs_curr_from_check() {
        let mut t = CTransition::default();
        t.sphere_path = one_sphere_path(v(0.0, 0.0, 5.0), 1.0);
        t.sphere_path.check_pos.frame.origin = v(0.0, 0.0, 5.0);
        t.sphere_path.check_cell = Some(3);
        let mut redo = true;

        let r = t.validate_transition(TransitionState::Ok, &mut redo, &NoWorld, &Phys(false));

        assert_eq!(r, TransitionState::Ok);
        assert!(!redo);
        assert_eq!(t.sphere_path.curr_cell, Some(3));
        assert!(approx(t.sphere_path.curr_pos.frame.origin, v(0.0, 0.0, 5.0)));
        assert_eq!(t.object_info.state & object_info_state::CONTACT, 0);
        assert!(t.collision_info.contact_plane.is_none());
    }

    #[test]
    fn validate_transition_stationary_fall_progression() {
        let mut t = CTransition::default();
        t.object_info.state = object_info_state::DEFAULT;
        t.sphere_path = one_sphere_path(v(0.0, 0.0, 5.0), 1.0);
        let mut redo = false;

        t.validate_transition(TransitionState::Ok, &mut redo, &NoWorld, &Phys(true));
        assert_eq!(t.collision_info.frames_stationary_fall, 1);

        t.validate_transition(TransitionState::Ok, &mut redo, &NoWorld, &Phys(true));
        assert_eq!(t.collision_info.frames_stationary_fall, 2);

        t.validate_transition(TransitionState::Ok, &mut redo, &NoWorld, &Phys(true));
        assert_eq!(t.collision_info.frames_stationary_fall, 3);
        let cp = t.collision_info.contact_plane.expect("synth plane");
        assert!(approx(cp.normal, v(0.0, 0.0, 1.0)));
        assert!((cp.d - (-4.0)).abs() < TOL); // r - center.z = 1 - 5
        assert!(approx(t.collision_info.collision_normal.unwrap(), v(0.0, 0.0, 1.0)));
        assert!(t.collision_info.collided_with_environment);
        assert_ne!(t.object_info.state & object_info_state::CONTACT, 0);
        assert_ne!(t.object_info.state & object_info_state::ON_WALKABLE, 0);
    }

    #[test]
    fn validate_transition_redoa_resets_fall_counter() {
        let mut t = CTransition::default();
        t.object_info.state = object_info_state::DEFAULT;
        t.sphere_path = one_sphere_path(v(0.0, 0.0, 5.0), 1.0);
        t.sphere_path.check_pos.objcell_id = 1;
        t.sphere_path.curr_pos.objcell_id = 0;
        t.collision_info.frames_stationary_fall = 2;
        let mut redo = false;
        t.validate_transition(TransitionState::Ok, &mut redo, &NoWorld, &Phys(true));
        assert_eq!(t.collision_info.frames_stationary_fall, 0);
    }

    #[test]
    fn validate_transition_branch_a_repins_last_known_plane() {
        let mut t = CTransition::default();
        t.object_info.object_id = 42;
        t.object_info.state = object_info_state::DEFAULT;
        t.sphere_path = one_sphere_path(v(0.0, 0.0, 0.5), 1.0);
        t.sphere_path.curr_cell = Some(9);
        t.collision_info.last_known_contact_plane =
            Some(Plane { normal: v(0.0, 0.0, 1.0), d: 0.0 });
        t.collision_info.last_known_contact_plane_cell_id = 77;
        let mut redo = true;

        let r = t.validate_transition(TransitionState::Slid, &mut redo, &NoWorld, &Phys(false));

        assert_eq!(r, TransitionState::Ok); // promoted to 1
        assert!(!redo);
        let cp = t.collision_info.contact_plane.expect("repinned");
        assert!(approx(cp.normal, v(0.0, 0.0, 1.0)));
        assert_eq!(t.collision_info.contact_plane_cell_id, 77);
        assert!(approx(t.collision_info.collision_normal.unwrap(), v(0.0, 0.0, 1.0)));
        assert_eq!(t.sphere_path.check_cell, Some(9));
        assert_ne!(t.object_info.state & object_info_state::ON_WALKABLE, 0);
    }

    #[test]
    fn validate_transition_invalid_state_falls_through() {
        let mut t = CTransition::default();
        t.object_info.state = object_info_state::CONTACT | object_info_state::ON_WALKABLE;
        t.sphere_path = one_sphere_path(v(0.0, 0.0, 0.0), 1.0);
        let mut redo = true;

        let r = t.validate_transition(TransitionState::Invalid, &mut redo, &NoWorld, &Phys(false));

        assert_eq!(r, TransitionState::Invalid);
        assert!(t.collision_info.contact_plane.is_none());
        assert_eq!(
            t.object_info.state & (object_info_state::CONTACT | object_info_state::ON_WALKABLE),
            0
        );
    }

    #[test]
    fn validate_placement_no_cell_returns_2() {
        let mut t = CTransition::default();
        t.sphere_path.check_cell = None;
        let mut redo = true;
        assert_eq!(t.validate_placement_transition(TransitionState::Ok, &mut redo), 2);
        assert!(!redo);
    }

    #[test]
    fn validate_placement_ok_syncs_curr_and_caches() {
        let mut t = CTransition::default();
        t.sphere_path = one_sphere_path(v(0.0, 0.0, 0.0), 1.0);
        t.sphere_path.local_sphere[0] = Sphere { center: v(1.0, 0.0, 2.0), radius: 1.0 };
        t.sphere_path.check_cell = Some(4);
        t.sphere_path.check_pos.objcell_id = 0x88;
        t.sphere_path.check_pos.frame.origin = v(5.0, 0.0, 0.0);
        let mut redo = true;

        let r = t.validate_placement_transition(TransitionState::Ok, &mut redo);
        assert_eq!(r, 1);
        assert_eq!(t.sphere_path.curr_pos.objcell_id, 0x88);
        assert_eq!(t.sphere_path.curr_cell, Some(4));
        assert!(approx(t.sphere_path.global_curr_center, v(6.0, 0.0, 2.0)));
    }

    #[test]
    fn validate_placement_slide_allowed_inits_collisions_and_returns_ts() {
        let mut t = CTransition::default();
        t.sphere_path.check_cell = Some(1);
        t.sphere_path.placement_allows_sliding = true;
        t.collision_info.contact_plane = Some(Plane { normal: v(0.0, 0.0, 1.0), d: -1.0 });
        t.collision_info.frames_stationary_fall = 5;
        let mut redo = true;

        let r = t.validate_placement_transition(TransitionState::Collided, &mut redo);
        assert_eq!(r, 2);
        assert!(t.collision_info.contact_plane.is_none());
        assert_eq!(t.collision_info.frames_stationary_fall, 0);
    }

    #[test]
    fn validate_placement_slide_disallowed_no_init() {
        let mut t = CTransition::default();
        t.sphere_path.check_cell = Some(1);
        t.sphere_path.placement_allows_sliding = false;
        t.collision_info.contact_plane = Some(Plane { normal: v(0.0, 0.0, 1.0), d: -1.0 });
        let mut redo = true;

        let r = t.validate_placement_transition(TransitionState::Collided, &mut redo);
        assert_eq!(r, 2);
        assert!(t.collision_info.contact_plane.is_some());
    }

    #[test]
    fn find_valid_position_dispatches_on_insert_type() {
        // B3 stubs both return 0; we assert the dispatch path runs (no panic) and
        // returns the stub's 0 for each insert_type. (Re-baseline when A03/A04 land.)
        let mut t = CTransition::default();
        t.sphere_path.insert_type = InsertType::Transition;
        assert_eq!(t.find_valid_position(&NoWorld, &Phys(false)), 0);

        let mut p = CTransition::default();
        p.sphere_path.insert_type = InsertType::Placement;
        assert_eq!(p.find_valid_position(&NoWorld, &Phys(false)), 0);

        let mut ip = CTransition::default();
        ip.sphere_path.insert_type = InsertType::InitialPlacement;
        assert_eq!(ip.find_valid_position(&NoWorld, &Phys(false)), 0);
    }
}
