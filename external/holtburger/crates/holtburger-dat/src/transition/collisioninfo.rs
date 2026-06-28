//! `COLLISIONINFO` setters + `SPHEREPATH` response-recording helpers — the
//! leaf-layer mutators the swept-sphere response functions (`slide_sphere`,
//! `collide_with_point`, `step_sphere_*`, `walkable_hits_sphere`, …) call to
//! record the contact plane / collision normal / sliding normal they find and
//! to advance / latch the swept path. Ported decomp-faithfully from
//! `acclient.c`.
//!
//! Owns (methods on [`super::types::CollisionInfo`]):
//! - [`CollisionInfo::set_contact_plane`]   — `COLLISIONINFO::set_contact_plane`   (acclient.c:311581)
//! - [`CollisionInfo::set_collision_normal`] — `COLLISIONINFO::set_collision_normal` (acclient.c:311726)
//! - [`CollisionInfo::set_sliding_normal`]  — `COLLISIONINFO::set_sliding_normal`  (acclient.c:311744)
//!
//! Owns (methods on [`super::types::SpherePath`]):
//! - [`SpherePath::add_offset_to_check_pos`]             — `SPHEREPATH::add_offset_to_check_pos` (acclient.c:311557)
//! - [`SpherePath::add_offset_to_check_pos_with_radius`] — `SPHEREPATH::add_offset_to_check_pos` (acclient.c:358526, radius overload)
//! - [`SpherePath::set_collide`]                         — `SPHEREPATH::set_collide`             (acclient.c:359050)
//! - [`SpherePath::set_walkable`]                        — `SPHEREPATH::set_walkable`            (acclient.c:361094)
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
//!
//! ## Phase-1 deferrals (`// TYPES-NEEDS:`)
//! The `SPHEREPATH` helpers touch several fields the Phase-1 `types.rs` has
//! not yet materialized (they sit in its `// PHASE2:` / `// PHASE3` stub
//! list). To keep this file compiling against the *current* `types.rs` and to
//! keep the shared build green, the writes to those absent fields are recorded
//! as `// TYPES-NEEDS:` notes at the exact decomp call site rather than as
//! code; the synthesis agent reconciles them when the fields land. The
//! collision-essential writes that DO have backing fields are applied for
//! real (and tested):
//! - `add_offset_to_check_pos`: the `check_pos` origin translation (real);
//!   the `cell_array_valid` invalidation + `cache_global_sphere` are deferred.
//! - `set_collide`: the `collide` latch + `walk_interp = 1.0` (real); the
//!   `step_up_normal` / `backup_check_pos` / `backup_cell` snapshot deferred.
//! - `set_walkable`: every target field (`walkable*`) is Phase-2 — the method
//!   is Phase-1-inert (see its doc warning).

use super::types::{CellPos, CollisionInfo, SpherePath, normalize_check_small};
use crate::physics::ResolvedPolygon;
use holtburger_common::{Plane, Sphere, Vector3};

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
}

impl SpherePath {
    /// `SPHEREPATH::add_offset_to_check_pos` (`acclient.c:311557`, idb
    /// `00509D10`). Translates the candidate (`check_pos`) origin by `offset`
    /// and invalidates the cached cell-array / global-sphere derived from the
    /// old position. This is how every swept-sphere response (slide / collide /
    /// step) nudges the moving sphere onto its valid resting position.
    ///
    /// Decomp:
    /// ```text
    /// this->cell_array_valid = 0;
    /// this->check_pos.frame.m_fOrigin.x += offset->x;
    /// this->check_pos.frame.m_fOrigin.y += offset->y;
    /// this->check_pos.frame.m_fOrigin.z += offset->z;
    /// SPHEREPATH::cache_global_sphere(this, offset);
    /// ```
    /// The origin translation is applied for real; the two cache side-effects
    /// have no Phase-1 backing field/method yet:
    // TYPES-NEEDS: `SpherePath.cell_array_valid: bool` — cleared here so the
    //   driver re-derives the 3×3 cell ring after the position moves.
    // TYPES-NEEDS: `SPHEREPATH::cache_global_sphere(offset)` (PHASE2) — slides
    //   the cached `global_sphere` center(s) by `offset` instead of recomputing.
    // acclient.c:311557
    pub fn add_offset_to_check_pos(&mut self, offset: &Vector3) {
        // self.cell_array_valid = false;            // TYPES-NEEDS (see above)
        self.check_pos.origin.x += offset.x;
        self.check_pos.origin.y += offset.y;
        self.check_pos.origin.z += offset.z;
        // self.cache_global_sphere(offset);          // TYPES-NEEDS (PHASE2)
    }

    /// `SPHEREPATH::add_offset_to_check_pos` — the radius overload
    /// (`acclient.c:358526`, idb `00536AB0` neighbour). In the retail decomp
    /// this overload's body is **byte-for-byte identical** to the no-radius
    /// one (acclient.c:311557): the `radius` argument is accepted but never
    /// read. The slide / collide callers pass `check_pos->radius`; it is a
    /// vestigial parameter. Kept as a distinct entry point so the Phase-3
    /// driver can replay the exact retail call shape; it simply forwards.
    // acclient.c:358526
    pub fn add_offset_to_check_pos_with_radius(&mut self, offset: &Vector3, radius: f32) {
        // `radius` is unused in the retail body — bind to `_` to make the
        // vestigial-ness explicit rather than rely on the no-warn-on-param rule.
        let _ = radius;
        self.add_offset_to_check_pos(offset);
    }

    /// `SPHEREPATH::set_collide` (`acclient.c:359050`, idb `00509D80`-region).
    /// Latches the path into the COLLIDED state: marks `collide`, snapshots the
    /// pre-collision check position/cell into the backup slots, stores the
    /// collision normal as the step-up normal, and resets the walk
    /// interpolation parameter to `1.0`.
    ///
    /// Decomp:
    /// ```text
    /// this->collide      = 1;
    /// this->backup_cell  = this->check_cell;
    /// this->backup_check_pos.objcell_id = this->check_pos.objcell_id;
    /// this->backup_check_pos.frame      = this->check_pos.frame;
    /// this->step_up_normal = *collision_normal;
    /// this->walk_interp    = 1.0;          // 1065353216 == 1.0f
    /// ```
    /// The `collide` latch and `walk_interp = 1.0` are applied for real; the
    /// snapshot writes have no Phase-1 backing field yet:
    // TYPES-NEEDS: `SpherePath.step_up_normal: Vector3` (in the types agent's
    //   PHASE2 list) — receives `*collision_normal`; consumed by `step_sphere_up`.
    // TYPES-NEEDS: `SpherePath.backup_check_pos: CellPos` (PHASE2) — snapshot of
    //   `check_pos` (objcell_id + origin/frame) so the driver can rewind.
    // TYPES-NEEDS: `SpherePath.check_cell` / `SpherePath.backup_cell`
    //   (PHASE3 `CObjCell*`) — the cell snapshot paired with `backup_check_pos`.
    // acclient.c:359050
    pub fn set_collide(&mut self, collision_normal: &Vector3) {
        // self.backup_cell = self.check_cell;                       // TYPES-NEEDS (PHASE3)
        self.collide = true;
        // self.backup_check_pos = self.check_pos;                   // TYPES-NEEDS (PHASE2)
        // self.step_up_normal = *collision_normal;                  // TYPES-NEEDS (PHASE2)
        let _ = collision_normal; // consumed by `step_up_normal` once it lands.
        self.walk_interp = 1.0;
    }

    /// `SPHEREPATH::set_walkable` (`acclient.c:361094`, idb `0053A040`-region).
    /// Records the walkable surface a swept sphere came to rest on: the sphere
    /// at the resting position, the supporting polygon, the surface "up" axis,
    /// the local position, and the object scale. The driver later promotes this
    /// to a real landing (sets the `ON_WALKABLE` object state).
    ///
    /// Decomp:
    /// ```text
    /// this->walkable_check_pos = *sphere;
    /// this->walkable           = poly;
    /// this->walkable_up        = *zaxis;
    /// this->walkable_pos.objcell_id = local_pos->objcell_id;
    /// this->walkable_pos.frame      = local_pos->frame;
    /// this->walkable_scale     = scale;
    /// ```
    ///
    /// ## ⚠ Phase-1-inert
    /// EVERY field this method writes (`walkable_check_pos`, `walkable`,
    /// `walkable_up`, `walkable_pos`, `walkable_scale`) is in the types agent's
    /// `// PHASE2:` stub list and does not yet exist on [`SpherePath`]. With no
    /// backing storage, this Phase-1 port is a faithful-signature **no-op**: it
    /// reads its inputs but records nothing, so callers must NOT yet rely on the
    /// walkable surface being remembered. The body documents each deferred write
    /// at its decomp call site:
    // TYPES-NEEDS: `SpherePath.walkable_check_pos: Sphere` (PHASE2) = `*sphere`.
    // TYPES-NEEDS: `SpherePath.walkable: Option<ResolvedPolygon>` (PHASE2) — the
    //   resting polygon `poly` (the decomp keeps a `CPolygon*`; an owned clone
    //   or a cell-poly index is the Phase-2 reconciliation choice).
    // TYPES-NEEDS: `SpherePath.walkable_up: Vector3` (PHASE2) = `*zaxis`.
    // TYPES-NEEDS: `SpherePath.walkable_pos: CellPos` (PHASE2) = `*local_pos`
    //   (objcell_id + origin/frame).
    // TYPES-NEEDS: `SpherePath.walkable_scale: f32` (PHASE2) = `scale`.
    // acclient.c:361094
    pub fn set_walkable(
        &mut self,
        sphere: &Sphere,
        poly: &ResolvedPolygon,
        zaxis: &Vector3,
        local_pos: &CellPos,
        scale: f32,
    ) {
        // self.walkable_check_pos = *sphere;        // TYPES-NEEDS (PHASE2)
        // self.walkable           = Some(poly.clone()); // TYPES-NEEDS (PHASE2)
        // self.walkable_up        = *zaxis;         // TYPES-NEEDS (PHASE2)
        // self.walkable_pos       = *local_pos;     // TYPES-NEEDS (PHASE2)
        // self.walkable_scale     = scale;          // TYPES-NEEDS (PHASE2)
        let _ = (sphere, poly, zaxis, local_pos, scale);
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

    // ── SPHEREPATH::add_offset_to_check_pos (acclient.c:311557 / 358526) ────

    #[test]
    fn add_offset_translates_check_pos_origin() {
        let mut path = SpherePath::default();
        path.check_pos = CellPos {
            objcell_id: 0xAB,
            origin: v(1.0, 2.0, 3.0),
        };

        // Case 1: (1,2,3) + (0.5,-1,2) = (1.5,1,5). objcell_id is untouched.
        path.add_offset_to_check_pos(&v(0.5, -1.0, 2.0));
        assert!(approx(path.check_pos.origin, v(1.5, 1.0, 5.0)));
        assert_eq!(path.check_pos.objcell_id, 0xAB);

        // Case 2: a second offset accumulates: (1.5,1,5) + (-0.5,0,-5) = (1,1,0).
        path.add_offset_to_check_pos(&v(-0.5, 0.0, -5.0));
        assert!(approx(path.check_pos.origin, v(1.0, 1.0, 0.0)));
    }

    #[test]
    fn add_offset_with_radius_is_identical_radius_ignored() {
        // The retail radius overload shares the no-radius body verbatim; the
        // radius is never read. Two distinct radii must give the same result.
        let mut a = SpherePath::default();
        a.check_pos.origin = v(-2.5, 3.25, 0.75);
        let mut b = a.clone();

        a.add_offset_to_check_pos_with_radius(&v(2.5, -3.25, -0.75), 1.7);
        b.add_offset_to_check_pos_with_radius(&v(2.5, -3.25, -0.75), 99.0);

        assert!(approx(a.check_pos.origin, Vector3::zero()));
        assert_eq!(a.check_pos.origin, b.check_pos.origin);

        // …and identical to the no-radius entry point.
        let mut c = SpherePath::default();
        c.check_pos.origin = v(-2.5, 3.25, 0.75);
        c.add_offset_to_check_pos(&v(2.5, -3.25, -0.75));
        assert_eq!(a.check_pos.origin, c.check_pos.origin);
    }

    // ── SPHEREPATH::set_collide (acclient.c:359050) ─────────────────────────

    #[test]
    fn set_collide_latches_flag_and_resets_walk_interp() {
        let mut path = SpherePath::default();
        assert!(!path.collide);
        path.walk_interp = 0.25; // pre-collision interpolation value

        // Case 1: any collision normal latches collide + resets walk_interp=1.
        path.set_collide(&v(1.0, 0.0, 0.0));
        assert!(path.collide);
        assert!((path.walk_interp - 1.0).abs() < TOL);

        // Case 2: idempotent on the latch; walk_interp re-pinned to 1 even if a
        // later step nudged it. (The normal differs; only the observable
        // Phase-1 fields are asserted — `step_up_normal` is TYPES-NEEDS.)
        path.walk_interp = 0.0;
        path.set_collide(&v(0.0, -1.0, 0.0));
        assert!(path.collide);
        assert!((path.walk_interp - 1.0).abs() < TOL);
    }

    // ── SPHEREPATH::set_walkable (acclient.c:361094) ────────────────────────
    //
    // Phase-1-inert: every target field is PHASE2 and absent, so the port is a
    // documented no-op. These cases pin that contract — calling it must NOT
    // disturb the existing (Phase-1) SpherePath state — so a regression that
    // accidentally writes a real field (or panics) is caught.

    fn sample_poly() -> ResolvedPolygon {
        ResolvedPolygon {
            num_points: 3,
            vertices: vec![v(0.0, 0.0, 0.0), v(1.0, 0.0, 0.0), v(0.0, 1.0, 0.0)],
            plane: Plane {
                normal: v(0.0, 0.0, 1.0),
                d: 0.0,
            },
        }
    }

    #[test]
    fn set_walkable_is_phase1_inert_on_existing_state() {
        // Case 1: a path mid-collision with a moved check_pos.
        let mut path = SpherePath::default();
        path.collide = true;
        path.walk_interp = 0.5;
        path.check_pos = CellPos {
            objcell_id: 0x100,
            origin: v(7.0, 8.0, 9.0),
        };
        let before = path.clone();

        path.set_walkable(
            &Sphere {
                center: v(7.0, 8.0, 9.0),
                radius: 1.1,
            },
            &sample_poly(),
            &v(0.0, 0.0, 1.0),
            &CellPos {
                objcell_id: 0x100,
                origin: v(7.0, 8.0, 9.0),
            },
            1.0,
        );
        // No existing field changed (the walkable_* writes are deferred).
        assert_eq!(path, before);

        // Case 2: a fresh default path with different inputs — still inert.
        let mut path2 = SpherePath::default();
        let before2 = path2.clone();
        path2.set_walkable(
            &Sphere {
                center: v(-3.0, 0.5, 2.0),
                radius: 0.6,
            },
            &sample_poly(),
            &v(0.5773503, 0.5773503, 0.5773503),
            &CellPos {
                objcell_id: 0x2A,
                origin: v(-3.0, 0.5, 2.0),
            },
            2.5,
        );
        assert_eq!(path2, before2);
    }
}
