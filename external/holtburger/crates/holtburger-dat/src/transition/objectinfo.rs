//! `OBJECTINFO` walkable-threshold helpers + the 8-arg walkable validator —
//! the driver-facing `OBJECTINFO` methods the Phase-3 `CTransition` spine calls.
//! Ported decomp-faithfully from `acclient.c`.
//!
//! Owns (methods on [`super::types::ObjectInfo`]):
//! - [`ObjectInfo::get_walkable_z`]   — `OBJECTINFO::get_walkable_z`  (acclient.c:314109 → `CPhysicsObj::get_walkable_z` 316507)
//! - [`ObjectInfo::is_valid_walkable`]— `OBJECTINFO::is_valid_walkable` (→ `CPhysicsObj::is_valid_walkable` 316500)
//! - [`ObjectInfo::validate_walkable`]— `OBJECTINFO::validate_walkable` (acclient.c:314161, 8-arg)
//!
//! ## FLOOR_Z, NOT Z_FOR_LANDING (A15 D6/R2)
//! `is_valid_walkable`/`get_walkable_z` use [`FLOOR_Z`] (cos 48.4°, the
//! `ON_WALKABLE`/state-bit gate) — a DIFFERENT, tighter threshold than
//! [`super::types::Z_FOR_LANDING`] (cos 85°, the BSP `walkable_allowance`
//! default). The two are never merged. The decomp helpers read a global, not
//! `this->object` (`CPhysicsObj::is_valid_walkable` is `__stdcall`, ignoring its
//! receiver), so these are pure threshold functions.

use super::types::{object_info_state, CollisionInfo, ObjectInfo, SpherePath, EPSILON, FLOOR_Z};
use holtburger_common::{Plane, Sphere, Vector3};

impl ObjectInfo {
    /// `OBJECTINFO::get_walkable_z` (`acclient.c:314109`) → `CPhysicsObj::
    /// get_walkable_z` (`acclient.c:316507`), which returns
    /// `PhysicsGlobals::floor_z` — a global constant identical for every object
    /// (the decomp body does not read `this`). See [`FLOOR_Z`].
    // acclient.c:314109
    pub fn get_walkable_z(&self) -> f32 {
        FLOOR_Z
    }

    /// `OBJECTINFO::is_valid_walkable` → `CPhysicsObj::is_valid_walkable`
    /// (`acclient.c:316500`): `normal->z >= PhysicsGlobals::floor_z`. The decomp
    /// `__stdcall` ignores its receiver — a pure threshold test against
    /// [`FLOOR_Z`] (NOT `Z_FOR_LANDING`; see the module note and A15 D6/R2).
    // acclient.c:316500
    pub fn is_valid_walkable(&self, normal: &Vector3) -> bool {
        // decomp compares `normal->z >= (double)floor_z`; the f32 compare is
        // bit-equivalent for this threshold.
        normal.z >= FLOOR_Z
    }

    /// `OBJECTINFO::validate_walkable` (`acclient.c:314161`). Given a candidate
    /// sphere `check_pos` resting against `contact_plane`, decide whether the
    /// object is walkably supported, hovering, or penetrating — and record the
    /// contact plane / collision normal and (when penetrating) push the sphere
    /// back out of the surface via `SPHEREPATH::add_offset_to_check_pos`.
    ///
    /// Returns the decomp `signed int`: `1` OK (clear/supported), `2` COLLIDED
    /// (penetration the recursion must reject), `3` ADJUSTED (pushed out / nudged
    /// back along the path). `TransitionState` as a raw code.
    ///
    /// Two top-level branches on `state & IS_VIEWER` (`0x4`):
    /// - **viewer** (`0x4` set): a camera-style probe — if it clears the plane
    ///   (or the path can't reach it from an interior `begin_pos`) it's OK,
    ///   else nudge it back along `global_curr_center → center` and ADJUST.
    /// - **non-viewer**: the floor/landing test using the sphere's *bottom*
    ///   (`center.z − radius`) plus `water_depth`; supported → set contact (and
    ///   collision when not contacting/stepping), penetrating → `check_walkable`
    ///   gate returns COLLIDED, else push straight up by `−v17/N.z` and ADJUST.
    ///
    /// Pure decomp port — every callee (`add_offset_to_check_pos`,
    /// `set_collision_normal`, `set_contact_plane`, `is_valid_walkable`) is
    /// already ported, so there is no `// SEAM:` here.
    // acclient.c:314161
    #[allow(clippy::too_many_arguments)]
    pub fn validate_walkable(
        &self,
        check_pos: &Sphere,
        contact_plane: &Plane,
        is_water: bool,
        water_depth: f32,
        path: &mut SpherePath,
        collisions: &mut CollisionInfo,
        land_cell_id: u32,
    ) -> i32 {
        let n = contact_plane.normal;
        let c = check_pos.center;
        let mut ts: i32 = 1; // ts = 1

        // ── viewer branch: if ( this->state & 4 /* IS_VIEWER */ ) ──
        if self.state & object_info_state::IS_VIEWER != 0 {
            // check_posa = N·center + d − radius (signed distance of the
            // sphere's near point to the plane). acclient.c:314185-314190
            let dist = n.x * c.x + n.y * c.y + c.z * n.z + contact_plane.d - check_pos.radius;

            // offset = center − global_curr_center; v12 = offset.z.
            let gcc = path.global_curr_center;
            let mut off = Vector3::new(c.x - gcc.x, c.y - gcc.y, 0.0);
            let v12 = c.z - gcc.z;
            // v13 = check_posa / (offset · N). acclient.c:314198
            let v13 = dist / (v12 * n.z + off.x * n.x + off.y * n.y);
            // begin_pos interior test. The decomp's `begin_pos != 0` null-check
            // folds into this: in the value model `begin_pos` is always present,
            // and a default/unset one (objcell_id 0) fails `>= 0x100` anyway.
            let begin_interior = (path.begin_pos.objcell_id & 0xFFFF) >= 0x100;

            // result = 1 when it clears the plane, OR the path parameter is out
            // of (0,1] AND we started inside an interior cell. acclient.c:314185-314206
            if dist > -EPSILON || ((v13 <= 0.0 || v13 > 1.0) && begin_interior) {
                return 1;
            }

            // else: push the sphere back along the path by −v13·offset and
            // report ADJUSTED (3). acclient.c:314208-314219
            let v16 = -v13;
            off.z = v12 * v16;
            off.x *= v16;
            off.y *= v16;
            path.add_offset_to_check_pos(&off);
            collisions.set_collision_normal(n);
            collisions.collided_with_environment = true;
            return 3;
        }

        // ── non-viewer branch ──
        // v17 = N·(center with z lowered by radius) + d + water_depth — the
        // signed distance of the sphere BOTTOM to the (water-raised) plane.
        // acclient.c:314223-314227
        let v17 =
            c.y * n.y + (c.z - check_pos.radius) * n.z + c.x * n.x + contact_plane.d + water_depth;

        if v17 >= -EPSILON {
            // Clear of / resting on the surface.
            if v17 > EPSILON {
                return 1; // hovering above → OK, no contact recorded
            }
            // Exactly resting (within ±EPSILON): record contact / collision.
            let valid = self.is_valid_walkable(&n);
            // if ( step_down || !(state & ON_WALKABLE) || valid )
            if path.step_down || self.state & object_info_state::ON_WALKABLE == 0 || valid {
                collisions.set_contact_plane(*contact_plane, is_water);
                collisions.contact_plane_cell_id = land_cell_id;
            }
            // if ( !(state & CONTACT) && !step_down )
            if self.state & object_info_state::CONTACT == 0 && !path.step_down {
                collisions.set_collision_normal(n);
                collisions.collided_with_environment = true;
            }
            ts = 1;
        } else {
            // Penetrating the surface (v17 < −EPSILON).
            // check_walkable gate: this is the recursion's reject path.
            if path.check_walkable {
                return 2;
            }
            let patha = v17 / n.z; // depth along the plane normal's z
            let valid = self.is_valid_walkable(&n);
            // if ( step_down || !(state & ON_WALKABLE) || valid )
            if path.step_down || self.state & object_info_state::ON_WALKABLE == 0 || valid {
                collisions.set_contact_plane(*contact_plane, is_water);
                collisions.contact_plane_cell_id = land_cell_id;
                if path.step_down {
                    // Interpolate the step-down so a single tick doesn't drop
                    // more than walk_interp allows. acclient.c:314268-314273
                    let v21 = (1.0 - (-1.0 / (path.step_down_amt * path.walk_interp)) * patha)
                        * path.walk_interp;
                    if v21 >= path.walk_interp || v21 < -0.1 {
                        return 2;
                    }
                    path.walk_interp = v21;
                }
                // Push straight up out of the surface by −patha. acclient.c:314276-314280
                let offset = Vector3::new(0.0, 0.0, -patha);
                path.add_offset_to_check_pos(&offset);
                ts = 3;
            }
            // if ( !(state & CONTACT) && !step_down ) → record + early return.
            if self.state & object_info_state::CONTACT == 0 && !path.step_down {
                collisions.set_collision_normal(n);
                collisions.collided_with_environment = true;
                return ts;
            }
        }
        ts
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::types::Z_FOR_LANDING;

    fn v(x: f32, y: f32, z: f32) -> Vector3 {
        Vector3::new(x, y, z)
    }
    const TOL: f32 = 1e-4;

    // ── get_walkable_z / is_valid_walkable (316500/316507) ──
    #[test]
    fn walkable_z_is_floor_z_and_distinct_from_landing() {
        let oi = ObjectInfo::default();
        assert_eq!(oi.get_walkable_z(), FLOOR_Z);
        // FLOOR_Z (cos 48.4°) is the tighter gate, well above Z_FOR_LANDING.
        assert!(FLOOR_Z > Z_FOR_LANDING);

        // is_valid_walkable: flat floor normal (z=1) passes; a 60°-from-up
        // normal (z=0.5 < FLOOR_Z) fails; a vertical wall (z=0) fails.
        assert!(oi.is_valid_walkable(&v(0.0, 0.0, 1.0)));
        assert!(!oi.is_valid_walkable(&v(0.0, 0.8, 0.5)));
        assert!(!oi.is_valid_walkable(&v(1.0, 0.0, 0.0)));
        // Exactly at the threshold passes (>=).
        assert!(oi.is_valid_walkable(&v(0.0, 0.0, FLOOR_Z)));
    }

    // shared flat floor: plane z = 0, normal up.
    fn floor() -> Plane {
        Plane { normal: v(0.0, 0.0, 1.0), d: 0.0 }
    }
    fn at(z: f32, r: f32) -> Sphere {
        Sphere { center: v(0.0, 0.0, z), radius: r }
    }

    // ── validate_walkable: non-viewer resting on floor → OK + contact ──
    #[test]
    fn non_viewer_resting_records_contact_and_collision() {
        let oi = ObjectInfo { state: object_info_state::DEFAULT, ..Default::default() };
        let mut path = SpherePath::default();
        path.num_sphere = 1;
        let mut ci = CollisionInfo::default();

        // sphere bottom exactly on the floor (center z = r) → v17 == 0.
        let r = oi.validate_walkable(&at(1.0, 1.0), &floor(), false, 0.0, &mut path, &mut ci, 0xABCD);
        assert_eq!(r, 1);
        assert!(ci.contact_plane.is_some());
        assert_eq!(ci.contact_plane_cell_id, 0xABCD);
        assert!(ci.collision_normal.is_some());
        assert!(ci.collided_with_environment);
    }

    // ── non-viewer hovering above surface → OK, NO contact ──
    #[test]
    fn non_viewer_hovering_is_ok_without_contact() {
        let oi = ObjectInfo::default();
        let mut path = SpherePath::default();
        let mut ci = CollisionInfo::default();
        // bottom at z = 1 (above floor) → v17 = 1 > EPSILON.
        let r = oi.validate_walkable(&at(2.0, 1.0), &floor(), false, 0.0, &mut path, &mut ci, 7);
        assert_eq!(r, 1);
        assert!(ci.contact_plane.is_none());
        assert!(ci.collision_normal.is_none());
    }

    // ── non-viewer penetrating + check_walkable gate → COLLIDED (2) ──
    #[test]
    fn non_viewer_penetrating_with_check_walkable_returns_collided() {
        let oi = ObjectInfo::default();
        let mut path = SpherePath::default();
        path.check_walkable = true;
        let mut ci = CollisionInfo::default();
        // bottom at z = -0.5 → v17 = -0.5 < -EPSILON.
        let r = oi.validate_walkable(&at(0.5, 1.0), &floor(), false, 0.0, &mut path, &mut ci, 1);
        assert_eq!(r, 2);
    }

    // ── non-viewer penetrating (no check_walkable) → push up + ADJUSTED (3) ──
    #[test]
    fn non_viewer_penetrating_pushes_up_and_adjusts() {
        let oi = ObjectInfo::default();
        let mut path = SpherePath::default();
        path.num_sphere = 1;
        let mut ci = CollisionInfo::default();
        // bottom at z = -0.5 → patha = -0.5; offset = (0,0,0.5).
        let r = oi.validate_walkable(&at(0.5, 1.0), &floor(), false, 0.0, &mut path, &mut ci, 5);
        assert_eq!(r, 3);
        assert!((path.check_pos.frame.origin.z - 0.5).abs() < TOL); // pushed up by 0.5
        assert!(ci.contact_plane.is_some());
        assert!(ci.collision_normal.is_some());
        assert!(ci.collided_with_environment);
    }

    // ── viewer clearing the plane → OK (1) ──
    #[test]
    fn viewer_clearing_plane_is_ok() {
        let oi = ObjectInfo { state: object_info_state::IS_VIEWER, ..Default::default() };
        let mut path = SpherePath::default();
        let mut ci = CollisionInfo::default();
        // dist = N·center + d - r = 1 - 1 = 0 > -EPSILON → OK.
        let r = oi.validate_walkable(&at(1.0, 1.0), &floor(), false, 0.0, &mut path, &mut ci, 0);
        assert_eq!(r, 1);
        assert!(ci.contact_plane.is_none());
    }

    // ── viewer penetrating (outdoor begin) → nudge back + ADJUSTED (3) ──
    #[test]
    fn viewer_penetrating_nudges_and_adjusts() {
        let oi = ObjectInfo { state: object_info_state::IS_VIEWER, ..Default::default() };
        let mut path = SpherePath::default();
        path.num_sphere = 1;
        // begin_pos outdoor (objcell_id low u16 < 0x100) → begin_interior false.
        path.begin_pos.objcell_id = 0x0001_0001;
        path.global_curr_center = v(0.0, 0.0, 0.0);
        let mut ci = CollisionInfo::default();
        // center (0,0,0.5), r=1 → dist = 0.5 - 1 = -0.5; v12 = 0.5; v13 = -1.
        let r = oi.validate_walkable(&at(0.5, 1.0), &floor(), false, 0.0, &mut path, &mut ci, 0);
        assert_eq!(r, 3);
        // offset = -v13 * (offset) with offset.z = v12 = 0.5 → push by (0,0,0.5).
        assert!((path.check_pos.frame.origin.z - 0.5).abs() < TOL);
        assert!(ci.collision_normal.is_some());
        assert!(ci.collided_with_environment);
    }

    // ── viewer penetrating but interior begin + out-of-range param → OK (1) ──
    #[test]
    fn viewer_interior_begin_out_of_param_is_ok() {
        let oi = ObjectInfo { state: object_info_state::IS_VIEWER, ..Default::default() };
        let mut path = SpherePath::default();
        // interior begin (low u16 >= 0x100) makes the (v13<=0||v13>1) branch fire.
        path.begin_pos.objcell_id = 0x0001_0100;
        path.global_curr_center = v(0.0, 0.0, 0.0);
        let mut ci = CollisionInfo::default();
        // v13 = -1 (<= 0) AND begin_interior → result 1.
        let r = oi.validate_walkable(&at(0.5, 1.0), &floor(), false, 0.0, &mut path, &mut ci, 0);
        assert_eq!(r, 1);
        assert!(ci.collision_normal.is_none());
    }
}
