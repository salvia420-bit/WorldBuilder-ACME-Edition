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

use super::objcell::CellWorld;
use super::types::{object_info_state, CTransition, InsertType, TransitionState, EPSILON};
use holtburger_common::{Plane, Vector3};

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

    /// SEAM(B3): `CTransition::find_placement_position` (acclient.c:313341, A04).
    /// Drives `validate_placement` → `find_placement_pos` → `step_down`. NOT
    /// ported in B2; returns `0` (no valid position found). B3 ports the body.
    fn find_placement_position(
        &mut self,
        world: &dyn CellWorld,
        phys: &dyn MovingObjectPhysics,
    ) -> i32 {
        let _ = (world, phys);
        0
    }

    /// SEAM(B3): `CTransition::find_transitional_position` (acclient.c:313171,
    /// A03). The per-step sweep loop (`calc_num_steps` → N× `adjust_offset` +
    /// `transitional_insert` + `validate_transition`). NOT ported in B2; returns
    /// `0`. B3 ports the body (and is the canonical caller of
    /// `validate_transition`).
    fn find_transitional_position(
        &mut self,
        world: &dyn CellWorld,
        phys: &dyn MovingObjectPhysics,
    ) -> i32 {
        let _ = (world, phys);
        0
    }
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
