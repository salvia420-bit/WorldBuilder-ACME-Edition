//! Phase-3 driver — placement search slice (B3, agent A04). The radial
//! placement search and the placement↔insert validation recursion that
//! `find_placement_position` (in `driver_validate.rs`) drives. Ported
//! decomp-faithfully from `acclient.c`:
//!
//! - [`CTransition::find_placement_pos`] — `acclient.c:313015`
//! - [`CTransition::placement_insert`]   — `acclient.c:312579`
//! - [`CTransition::validate_placement`] — `acclient.c:312601`
//!
//! ## Reconciliation to the committed B2 dispatch / validation layer
//! The decomp holds live `CObjCell*` cells; this crate keeps `Option<u32>` cell
//! ids and resolves them through `world.get_visible(id)` (design decision #1 —
//! `world` is threaded, never a `CTransition` field). So `insert_into_cell`
//! takes the resolved handle and `check_other_cells`/`transitional_insert`/
//! `step_down` all take `world`. The placement validators carry the resolver's
//! `TransitionState`; `transitional_insert`'s raw `i32` is mapped via
//! [`super::types::TransitionState::from_i32`]. `validate_placement_transition`
//! is the committed B2 method (`driver_validate.rs`) — NOT re-ported here.
//!
//! Transition-state codes follow the resolver convention (`i32`): 1=OK 2=COLLIDED
//! 3=ADJUSTED 4=SLID.

use super::objcell::CellWorld;
use super::types::{CTransition, TransitionState, EPSILON};
use holtburger_common::Vector3;

const OK_TS: i32 = TransitionState::Ok as i32; // 1
const COLLIDED_TS: i32 = TransitionState::Collided as i32; // 2
const SLID_TS: i32 = TransitionState::Slid as i32; // 4

impl CTransition {
    /// `CTransition::find_placement_pos` (`acclient.c:313015`). Radial placement
    /// search: pin the candidate to the accepted position, try a straight insert,
    /// and — if that fails and sliding is allowed — sweep a fan of radial offsets
    /// (`num_steps` rings × `num_rad` angular samples), each run through
    /// `adjust_offset`'s slide projection, until an insert validates OK. Returns
    /// `true` on the first OK, `false` when the schedule is exhausted or sliding
    /// is disallowed.
    // acclient.c:313015
    pub fn find_placement_pos(&mut self, world: &dyn CellWorld) -> bool {
        // 313057-313063: candidate ← current accepted position.
        let cur_pos = self.sphere_path.curr_pos;
        let cur_cell = self.sphere_path.curr_cell;
        self.sphere_path.set_check_pos(&cur_pos, cur_cell);

        // 313064-313066: clear the prior collision record.
        self.collision_info.sliding_normal = None;
        self.collision_info.contact_plane = None;
        self.collision_info.contact_plane_is_water = false;

        // 313067-313068: straight insert at the requested position.
        let mut redo = false;
        let v4 = self.transitional_insert(world, 3);
        if self.validate_placement_transition(TransitionState::from_i32(v4), &mut redo) == OK_TS {
            return true; // first insert OK
        }

        // 313070-313071: no sliding allowed → give up.
        if !self.sphere_path.placement_allows_sliding {
            return false;
        }

        // 313072-313096: derive the radial-search schedule from the sphere radius.
        let mut sphere_rad = self.sphere_path.local_sphere[0].radius; // j
        let mut fake_sphere = false; // v5
        let mut adjust_rad = 4.0_f32;
        if sphere_rad >= 0.125 {
            if sphere_rad < 0.47999999 {
                sphere_rad = 0.47999999;
            }
        } else {
            fake_sphere = true;
            adjust_rad = 2.0;
        }
        let mut f_num_steps = 4.0 / (1.0 * sphere_rad); // v6
        if fake_sphere {
            f_num_steps *= 0.5;
        }
        if f_num_steps <= 1.0 {
            return false; // 313088-313089
        }
        let f_num_steps = f_num_steps.ceil(); // v8
        let dist_per_step = adjust_rad / f_num_steps;
        let num_steps = f_num_steps as u32;
        let radians_per_step = dist_per_step / sphere_rad * 3.1415999; // d_num_radial
        if num_steps == 0 {
            return false; // 313097-313098 (dead after the >1 guard; kept faithful)
        }

        let mut total_dist = 0.0_f32; // distance
        let mut total_rad = 0.0_f32; // adjust_rada

        // 313099-313165: outer radial-step loop.
        for _i in 0..num_steps {
            total_dist += dist_per_step;
            total_rad += radians_per_step;
            let num_rad = (total_rad.ceil() as u32) * 2; // 2 * ceil(total_rad)
            let angle_offset = 360.0 / num_rad as f32;

            // 313107-313115: fresh identity offset frame (decomp inits the
            // quaternion to identity then `Frame::cache` ⇒ `Frame::identity`).
            let mut offset_frame = super::frame_transform::Frame::identity();

            // 313125-313165: inner angular loop.
            for ja in 0..num_rad {
                // 313127-313133: re-pin the candidate to the accepted position.
                self.sphere_path.set_check_pos(&cur_pos, cur_cell);

                // 313134-313146: radial offset = heading(ja·angle)·total_dist.
                offset_frame.set_heading(ja as f32 * angle_offset);
                let heading = offset_frame.get_vector_heading();
                let offset = Vector3::new(
                    total_dist * heading.x,
                    total_dist * heading.y,
                    total_dist * heading.z,
                );
                let global_offset = self.adjust_offset(offset);
                self.sphere_path.global_offset = global_offset;

                // 313148: only try a non-degenerate offset (the opaque `c0|c3`
                // FPU flags resolve to `GlobalOffset.Length() >= EPSILON`, ACE).
                if global_offset.length() >= EPSILON {
                    self.sphere_path.add_offset_to_check_pos(&global_offset);
                    self.collision_info.sliding_normal = None;
                    self.collision_info.contact_plane = None;
                    self.collision_info.contact_plane_is_water = false;
                    let v23 = self.transitional_insert(world, 3);
                    if self.validate_placement_transition(TransitionState::from_i32(v23), &mut redo)
                        == OK_TS
                    {
                        return true; // 313159-313160
                    }
                }
            }
        }
        false // 313122 schedule exhausted
    }

    /// `CTransition::placement_insert` (`acclient.c:312579`). `insert_into_cell`,
    /// then (on OK) `check_other_cells` — the re-insert `validate_placement` falls
    /// back on when a slid/adjusted candidate needs re-seating.
    // acclient.c:312579
    pub fn placement_insert(&mut self, world: &dyn CellWorld) -> i32 {
        let check_cell = self.sphere_path.check_cell;
        if check_cell.is_none() {
            return COLLIDED_TS; // 312593-312595
        }
        // Resolve the candidate cell id → live handle through the world.
        let cell = check_cell.and_then(|id| world.get_visible(id));
        let mut result = self.insert_into_cell(cell.as_deref(), 3);
        if result == OK_TS {
            result = self.check_other_cells(world, self.sphere_path.check_cell);
        }
        result
    }

    /// `CTransition::validate_placement` (`acclient.c:312601`). OK → commit the
    /// candidate as the accepted position. Adjusted/Slid with `adjust` → re-insert
    /// (`placement_insert`) and re-validate WITHOUT adjust (depth-2 cap). Returns
    /// `2` when there is no candidate cell, else the (possibly re-validated) `ts`.
    // acclient.c:312601
    pub fn validate_placement(&mut self, world: &dyn CellWorld, ts: i32, adjust: bool) -> i32 {
        if self.sphere_path.check_cell.is_none() {
            return COLLIDED_TS; // 312610-312611
        }
        if ts == OK_TS {
            // 312615-312618: commit check_pos → curr_pos, check_cell → curr_cell.
            self.sphere_path.curr_pos.objcell_id = self.sphere_path.check_pos.objcell_id;
            self.sphere_path.curr_pos.frame = self.sphere_path.check_pos.frame;
            self.sphere_path.curr_cell = self.sphere_path.check_cell;
            self.sphere_path.cache_global_curr_center();
        } else if ts > COLLIDED_TS && ts <= SLID_TS && adjust {
            // 312620-312623: ts in {Adjusted,Slid} — re-seat and re-validate.
            let v6 = self.placement_insert(world);
            return self.validate_placement(world, v6, false);
        }
        ts // 312625
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transition::test_utils::{build, scenes, Scene, SceneWorld, SynthEnvCell, ENV_CELL_ID};
    use crate::transition::objcell::CObjCell;
    use crate::transition::types::InsertType;
    use holtburger_common::Plane;
    use std::rc::Rc;

    fn v(x: f32, y: f32, z: f32) -> Vector3 {
        Vector3::new(x, y, z)
    }

    fn world_for(scene: Scene) -> SceneWorld {
        let cell: Rc<dyn CObjCell> = SynthEnvCell::new(scene).handle();
        SceneWorld::single(cell)
    }

    // ── validate_placement: SEAM-free OK / Collided / no-cell paths ──
    #[test]
    fn validate_placement_no_cell_returns_collided() {
        let world = world_for(scenes::flat_floor());
        let mut t = CTransition::default();
        t.sphere_path.check_cell = None;
        assert_eq!(t.validate_placement(&world, OK_TS, true), COLLIDED_TS);
    }

    #[test]
    fn validate_placement_ok_commits_and_collided_passes_through() {
        let world = world_for(scenes::flat_floor());
        let mut t = CTransition::default();
        t.sphere_path.num_sphere = 1;
        t.sphere_path.check_cell = Some(2);
        t.sphere_path.check_pos.objcell_id = 0xAB;
        t.sphere_path.check_pos.frame.origin = v(1.0, 1.0, 1.0);
        assert_eq!(t.validate_placement(&world, OK_TS, true), OK_TS);
        assert_eq!(t.sphere_path.curr_cell, Some(2));
        assert_eq!(t.sphere_path.curr_pos.objcell_id, 0xAB);
        // Collided (2) is NOT > 2 → no recursion, returns verbatim.
        assert_eq!(t.validate_placement(&world, COLLIDED_TS, true), COLLIDED_TS);
    }

    // ── placement_insert: no-cell short-circuit ──
    #[test]
    fn placement_insert_none_cell_is_collided() {
        let world = world_for(scenes::flat_floor());
        let mut t = CTransition::default();
        t.sphere_path.check_cell = None;
        assert_eq!(t.placement_insert(&world), COLLIDED_TS);
    }

    // ── find_placement_pos end-to-end through the real synthetic floor ──
    #[test]
    fn find_placement_pos_above_floor_settles_ok() {
        // A sphere hovering just clear of the floor (centre z=0.6, r=0.5 ⇒ 0.1
        // gap, within point_in_cell's distance gate) inserts OK on the straight
        // (non-radial) attempt and commits the candidate as the accepted pos.
        let world = world_for(scenes::flat_floor());
        let mut t = build::sweep(
            ENV_CELL_ID,
            build::walker(0.5, 0.5),
            0.5,
            v(1.0, 1.0, 0.6),
            v(1.0, 1.0, 0.6),
        );
        t.sphere_path.insert_type = InsertType::Placement;
        t.sphere_path.placement_allows_sliding = true;
        assert!(t.find_placement_pos(&world));
        assert_eq!(t.sphere_path.curr_cell, Some(ENV_CELL_ID));
    }

    #[test]
    fn find_placement_pos_no_sliding_into_solid_fails() {
        // A sphere buried in the floor solid, sliding disallowed → straight
        // insert is non-OK and the search gives up.
        let world = world_for(scenes::flat_floor());
        let mut t = build::sweep(
            ENV_CELL_ID,
            build::walker(0.5, 0.5),
            0.5,
            v(1.0, 1.0, -0.2),
            v(1.0, 1.0, -0.2),
        );
        t.sphere_path.insert_type = InsertType::Placement;
        t.sphere_path.placement_allows_sliding = false;
        assert!(!t.find_placement_pos(&world));
    }

    // ── adjust_offset side-effect reached from a placement candidate ──
    #[test]
    fn placement_path_keeps_contact_plane_state_consistent() {
        let world = world_for(scenes::flat_floor());
        let mut t = build::sweep(
            ENV_CELL_ID,
            build::walker(0.5, 0.5),
            0.5,
            v(1.0, 1.0, 1.0),
            v(1.0, 1.0, 1.0),
        );
        t.collision_info.contact_plane = Some(Plane { normal: v(0.0, 0.0, 1.0), d: 0.0 });
        t.sphere_path.insert_type = InsertType::Placement;
        // find_placement_pos clears the contact plane on entry (313064-313066).
        let _ = t.find_placement_pos(&world);
        // sliding_normal must be cleared along the way (no stale constraint).
        assert!(t.collision_info.sliding_normal.is_none());
    }
}
