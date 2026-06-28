//! `COLLISIONINFO` setters — the leaf-layer mutators the swept-sphere response
//! functions (`slide_sphere`, `collide_with_point`, `step_sphere_*`,
//! `walkable_hits_sphere`, …) call to record the contact plane / collision
//! normal / sliding normal they find. Ported decomp-faithfully from
//! `acclient.c`.
//!
//! Owns (methods on [`super::types::CollisionInfo`]):
//! - [`CollisionInfo::set_contact_plane`]   — `COLLISIONINFO::set_contact_plane`   (acclient.c:311581)
//! - [`CollisionInfo::set_collision_normal`] — `COLLISIONINFO::set_collision_normal` (acclient.c:311726)
//! - [`CollisionInfo::set_sliding_normal`]  — `COLLISIONINFO::set_sliding_normal`  (acclient.c:311744)
//!
//! The `SPHEREPATH` mutators (`add_offset_to_check_pos`[`_with_radius`],
//! `set_collide`, `set_walkable`, …) once lived here as **Phase-1-inert**
//! stand-ins (written before the types agent fleshed `SpherePath` to its full
//! 592-byte shape, so they referenced the retired `check_pos.origin` /
//! `CellPos` layout and recorded nothing for the walkable / cache side-effects).
//! Their authoritative, field-complete Phase-2 ports now live in
//! [`super::spherepath_methods`]; the inert duplicates were removed here during
//! resolver reconciliation so the two no longer collide as duplicate method
//! definitions.
//!
//! ## DECOMP vs. ACE
//! ACE's `CollisionInfo.SetCollisionNormal` (CollisionInfo.cs:50) stores the
//! *un-normalized* input and only zeroes it when degenerate (its own
//! `// use original?` comment flags the doubt). The decomp normalizes the
//! stored vector IN PLACE (`normalize_check_small(&this->collision_normal)`),
//! so the recorded normal is a UNIT vector (or zero). Per the Phase-1 ruling
//! the decomp wins: these store the normalized result.
//!
//! The decomp's `_valid: bool` + value pairs collapse to `Option<…>` here
//! (see [`super::types`]): `Some(_)` is "valid". The decomp sets `*_valid = 1`
//! UNCONDITIONALLY — even for a degenerate (zeroed) normal — so these always
//! write `Some(...)`, with `Some(Vector3::zero())` standing for "valid but
//! collapsed".

use super::types::{CollisionInfo, TransitionState, normalize_check_small};
use holtburger_common::{Plane, Vector3};

impl CollisionInfo {
    /// `COLLISIONINFO::set_contact_plane` (`acclient.c:311581`). Records the
    /// resting/contact plane and whether it is a water surface.
    ///
    /// Decomp:
    /// ```text
    /// this->contact_plane_valid   = 1;
    /// this->contact_plane         = *plane;
    /// this->contact_plane_is_water = is_water;
    /// ```
    /// The `_valid = 1` becomes `Some(plane)`.
    // acclient.c:311581
    pub fn set_contact_plane(&mut self, plane: Plane, is_water: bool) {
        self.contact_plane = Some(plane);
        self.contact_plane_is_water = is_water;
    }

    /// `COLLISIONINFO::set_collision_normal` (`acclient.c:311726`, idb
    /// `0050A000`). Stores the input normal, normalizes it IN PLACE, and — if
    /// the input was sub-epsilon ("too small to normalize") — collapses it to
    /// zero. The `_valid` flag is set FIRST and unconditionally, so the result
    /// is always `Some(...)` (a zero vector for the degenerate case),
    /// mirroring the decomp's `*_valid = 1` followed by the in-place
    /// `normalize_check_small`.
    ///
    /// Decomp:
    /// ```text
    /// this->collision_normal_valid = 1;
    /// this->collision_normal = *normal;
    /// if ( normalize_check_small(&this->collision_normal) )
    ///     this->collision_normal = {0,0,0};
    /// ```
    // acclient.c:311726
    pub fn set_collision_normal(&mut self, normal: Vector3) {
        let mut n = normal;
        if normalize_check_small(&mut n) {
            // "too small to normalize" → the decomp zeroes the stored vector
            // (but leaves `_valid = 1`).
            n = Vector3::zero();
        }
        self.collision_normal = Some(n);
    }

    /// `COLLISIONINFO::set_sliding_normal` (`acclient.c:311744`, idb
    /// `0050A060`). Projects the normal onto the XY plane (`z = 0`), normalizes
    /// it IN PLACE, and stores it; a sub-epsilon projection collapses to zero
    /// (still "valid"). The sliding normal is the horizontal direction an
    /// object skids along when it cannot climb a surface.
    ///
    /// Decomp:
    /// ```text
    /// this->sliding_normal_valid = 1;
    /// this->sliding_normal.x = normal->x;
    /// this->sliding_normal.y = normal->y;
    /// this->sliding_normal.z = 0;
    /// if ( normalize_check_small(&this->sliding_normal) )
    ///     this->sliding_normal = {0,0,0};
    /// ```
    // acclient.c:311744
    pub fn set_sliding_normal(&mut self, normal: Vector3) {
        let mut n = Vector3::new(normal.x, normal.y, 0.0);
        if normalize_check_small(&mut n) {
            n = Vector3::zero();
        }
        self.sliding_normal = Some(n);
    }

    /// `COLLISIONINFO::add_object` (`acclient.c:718729`). Records `object` as a
    /// collided object IF not already present (the decomp scans
    /// `[0, num_collide_object)` and bails on a hit). On a fresh add the decomp
    /// grows the `DArray` (`Vec::push`) and — when the transition result `ts`
    /// is NOT `Ok` — latches `last_collided_object`.
    // acclient.c:718729
    pub fn add_object(&mut self, object: u32, ts: TransitionState) {
        // Dedup scan (acclient.c:718739-718748). Already present → no-op.
        if self.collide_object.iter().any(|&o| o == object) {
            return;
        }
        // Fresh add (acclient.c:718753-718755); grow handled by Vec::push.
        self.collide_object.push(object);
        self.num_collide_object = self.collide_object.len() as u32;
        // acclient.c:718756-718757 — ts != Ok latches the last collided object.
        if ts != TransitionState::Ok {
            self.last_collided_object = Some(object);
        }
    }

    /// The object-object subset of `COLLISIONINFO::init` (`acclient.c:311573`):
    /// clear the collided-objects list. The decomp zeroes `num_collide_object`
    /// / `last_collided_object` (retaining the `DArray` buffer); `Vec::clear`
    /// is the observable equivalent.
    // acclient.c:311573
    pub fn reset_objects(&mut self) {
        self.num_collide_object = 0;
        self.collide_object.clear();
        self.last_collided_object = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(x: f32, y: f32, z: f32) -> Vector3 {
        Vector3::new(x, y, z)
    }

    const TOL: f32 = 1e-4;

    fn approx(a: Vector3, b: Vector3) -> bool {
        (a.x - b.x).abs() < TOL && (a.y - b.y).abs() < TOL && (a.z - b.z).abs() < TOL
    }

    // ── COLLISIONINFO::set_contact_plane (acclient.c:311581) ────────────────

    #[test]
    fn set_contact_plane_records_plane_and_water() {
        let mut ci = CollisionInfo::default();

        // Case 1: a flat floor plane at z = 5, water surface.
        let floor = Plane {
            normal: v(0.0, 0.0, 1.0),
            d: -5.0,
        };
        ci.set_contact_plane(floor, true);
        assert_eq!(ci.contact_plane, Some(floor));
        assert!(ci.contact_plane_is_water);

        // Case 2: a tilted dry ramp — overwrites; water flag flips to false.
        let ramp = Plane {
            normal: v(0.6, 0.0, 0.8),
            d: -2.0,
        };
        ci.set_contact_plane(ramp, false);
        assert_eq!(ci.contact_plane, Some(ramp));
        assert!(!ci.contact_plane_is_water);
    }

    // ── COLLISIONINFO::set_collision_normal (acclient.c:311726) ─────────────

    #[test]
    fn set_collision_normal_normalizes_in_place() {
        let mut ci = CollisionInfo::default();

        // Case 1: (0,3,4) has length 5 → unit (0, 0.6, 0.8).
        ci.set_collision_normal(v(0.0, 3.0, 4.0));
        let n = ci.collision_normal.expect("valid");
        assert!(approx(n, v(0.0, 0.6, 0.8)), "got {n:?}");

        // Case 2: an already-unit, all-axes normal stays put.
        // (1,2,2)/3 = (0.333…, 0.666…, 0.666…), length 1.
        ci.set_collision_normal(v(1.0, 2.0, 2.0));
        let n = ci.collision_normal.expect("valid");
        assert!(approx(n, v(1.0 / 3.0, 2.0 / 3.0, 2.0 / 3.0)), "got {n:?}");

        // Case 3 (degenerate): sub-epsilon input collapses to zero but stays
        // valid (Some), mirroring `*_valid = 1` + in-place zero.
        ci.set_collision_normal(v(0.0, 0.0, 0.0));
        assert_eq!(ci.collision_normal, Some(Vector3::zero()));
    }

    // ── COLLISIONINFO::set_sliding_normal (acclient.c:311744) ───────────────

    #[test]
    fn set_sliding_normal_drops_z_then_normalizes() {
        let mut ci = CollisionInfo::default();

        // Case 1: (3,4,9) → drop z → (3,4,0), length 5 → unit (0.6,0.8,0).
        ci.set_sliding_normal(v(3.0, 4.0, 9.0));
        let n = ci.sliding_normal.expect("valid");
        assert!(approx(n, v(0.6, 0.8, 0.0)), "got {n:?}");

        // Case 2: a purely vertical normal projects to (0,0,0) in XY →
        // collapsed to zero (still Some).
        ci.set_sliding_normal(v(0.0, 0.0, 1.0));
        assert_eq!(ci.sliding_normal, Some(Vector3::zero()));
    }

    // ── COLLISIONINFO::add_object (acclient.c:718729) ───────────────────────

    #[test]
    fn add_object_dedups_and_latches_last_on_non_ok() {
        let mut ci = CollisionInfo::default();

        // First add with COLLIDED (ts != Ok) → recorded + latched.
        ci.add_object(0x1001, TransitionState::Collided);
        assert_eq!(ci.collide_object, vec![0x1001]);
        assert_eq!(ci.num_collide_object, 1);
        assert_eq!(ci.last_collided_object, Some(0x1001));

        // Duplicate → no-op.
        ci.add_object(0x1001, TransitionState::Slid);
        assert_eq!(ci.collide_object, vec![0x1001]);
        assert_eq!(ci.num_collide_object, 1);
        assert_eq!(ci.last_collided_object, Some(0x1001));

        // New object with ts == Ok → recorded but does NOT latch last.
        ci.add_object(0x2002, TransitionState::Ok);
        assert_eq!(ci.collide_object, vec![0x1001, 0x2002]);
        assert_eq!(ci.num_collide_object, 2);
        assert_eq!(ci.last_collided_object, Some(0x1001));

        // New object with ts != Ok → recorded and latches last.
        ci.add_object(0x3003, TransitionState::Adjusted);
        assert_eq!(ci.num_collide_object, 3);
        assert_eq!(ci.last_collided_object, Some(0x3003));

        // reset_objects clears the list.
        ci.reset_objects();
        assert_eq!(ci.num_collide_object, 0);
        assert!(ci.collide_object.is_empty());
        assert!(ci.last_collided_object.is_none());
    }
}
