//! Phase-3 driver — collision-response slide geometry (B3, agent A05). The
//! methods that re-aim a swept sphere's movement offset once a contact is found,
//! plus the small `Position`/`Plane` helpers the search loops lean on. Ported
//! decomp-faithfully from `acclient.c`:
//!
//! - [`CTransition::adjust_offset`] — `acclient.c:311864`
//! - [`CTransition::cliff_slide`]   — `acclient.c:312005`
//! - [`snap_to_plane`]              — `Plane::snap_to_plane`  (acclient.c:311527)
//! - [`Position::get_offset`]       — `Position::get_offset`  (acclient.c:311691)
//!
//! `adjust_offset` is the ONE canonical port shared by `find_transitional_position`
//! (A03) and `find_placement_pos` (A04); both call it through `&mut self`. The
//! decomp renders its two slide projections through a `coffset` temp whose
//! `new_offset = coffset` mid-copy is a Hex-Rays aliasing artifact — the intended
//! op is the plain projection `new_offset -= K·(K·new_offset)` (ACE `AdjustOffset`
//! confirms; A05 reconciliation note).

use super::trace::trace;
use super::types::{normalize_check_small, CTransition, LandDefs, Position, EPSILON};
use holtburger_common::{Plane, Vector3};

/// `Plane::snap_to_plane` (`acclient.c:311527`). Rewrites `offset.z` so the
/// offset lies parallel to `plane` (snaps a DIRECTION, not a point — the `±d`
/// terms cancel algebraically; kept un-cancelled for float fidelity). No-op when
/// the plane is near-vertical (`|N.z| ≤ EPSILON`).
// acclient.c:311527
pub(crate) fn snap_to_plane(plane: &Plane, offset: &mut Vector3) {
    let n = plane.normal;
    if n.z.abs() > EPSILON {
        offset.z = 0.0; // LODWORD(offset->z) = 0
        offset.z = -(offset.y * n.y + offset.x * n.x + n.z * 0.0 + plane.d) * (1.0 / n.z)
            - (1.0 / n.z) * (-plane.d);
    }
}

impl Position {
    /// `Position::get_offset` (`acclient.c:311691`). The vector from `self` to
    /// `p` in `self`'s local space: `(p.origin + block_offset) − self.origin`,
    /// where `block_offset = LandDefs::get_block_offset(self.id, p.id)` carries
    /// the cross-landblock delta (zero within one landblock).
    // acclient.c:311691
    pub fn get_offset(&self, p: &Position) -> Vector3 {
        let block_offset = LandDefs::get_block_offset(self.objcell_id, p.objcell_id);
        Vector3::new(
            (block_offset.x + p.frame.origin.x) - self.frame.origin.x,
            (block_offset.y + p.frame.origin.y) - self.frame.origin.y,
            (block_offset.z + p.frame.origin.z) - self.frame.origin.z,
        )
    }
}

impl CTransition {
    /// `CTransition::adjust_offset` (`acclient.c:311864`). Re-aims the desired
    /// per-step `offset` so it respects the contact constraints the collision
    /// pass recorded, returning the adjusted offset. Side effects: may drop a
    /// no-longer-opposing `sliding_normal`, and may push `check_pos` out of a
    /// penetrated (non-water) contact plane via `add_offset_to_check_pos`.
    // acclient.c:311864
    pub fn adjust_offset(&mut self, offset: Vector3) -> Vector3 {
        let mut new_offset = offset; // new_offset = *offset (311889-311896)
        let mut sliding_opposes = false; // v7

        // 311897-311905: sliding-normal gate. Keep the slide only when the move
        // opposes the sliding normal; otherwise drop the (stale) normal.
        if let Some(sn) = self.collision_info.sliding_normal {
            if new_offset.z * sn.z + new_offset.y * sn.y + new_offset.x * sn.x < 0.0 {
                sliding_opposes = true; // v7 = 1
            } else {
                self.collision_info.sliding_normal = None; // sliding_normal_valid = 0
            }
        }
        trace(|| {
            format!(
                "adjust_offset ENTER offset={offset:?} sliding_normal={:?} sliding_opposes={sliding_opposes} \
                 contact_plane={:?}",
                self.collision_info.sliding_normal,
                self.collision_info.contact_plane.map(|p| p.normal),
            )
        });

        if let Some(cp) = self.collision_info.contact_plane {
            let n = cp.normal;
            // offseta = offset · contact_plane.N (311909-311911)
            let offseta = new_offset.z * n.z + new_offset.y * n.y + new_offset.x * n.x;

            if sliding_opposes {
                // 311912-311939: slide along the contact∧sliding edge.
                // coffset = contact_plane.N × sliding_normal (component order
                // below matches the decomp). A degenerate cross ⇒ kill the move.
                let sn = self
                    .collision_info
                    .sliding_normal
                    .expect("v7 implies sliding_normal still valid");
                let mut coffset = Vector3::new(
                    sn.z * n.y - sn.y * n.z, // coffset.x
                    sn.x * n.z - sn.z * n.x, // coffset.y
                    sn.y * n.x - sn.x * n.y, // coffset.z
                );
                if normalize_check_small(&mut coffset) {
                    new_offset = Vector3::zero();
                    trace(|| "adjust_offset: edge-slide branch, degenerate cross -> offset zeroed".to_string());
                } else {
                    let v9 =
                        coffset.z * new_offset.z + coffset.y * new_offset.y + coffset.x * new_offset.x;
                    new_offset = Vector3::new(coffset.x * v9, coffset.y * v9, coffset.z * v9);
                    trace(|| {
                        format!(
                            "adjust_offset: edge-slide branch coffset(N x sliding_normal)={coffset:?} \
                             v9(coffset.offset)={v9:.6} -> new_offset={new_offset:?}"
                        )
                    });
                }
            } else if offseta <= 0.0 {
                // 311941-311950: project onto the plane — new_offset -= offseta·N.
                // (The decomp's `coffset`/`new_offset = coffset` mid-copy is a
                // Hex-Rays aliasing artifact; ACE confirms the plain projection.)
                new_offset = Vector3::new(
                    new_offset.x - offseta * n.x,
                    new_offset.y - offseta * n.y,
                    new_offset.z - offseta * n.z,
                );
                trace(|| format!("adjust_offset: project-onto-plane branch offseta={offseta:.6} -> new_offset={new_offset:?}"));
            } else {
                // 311951-311954: offset leaving the plane → snap onto it.
                snap_to_plane(&cp, &mut new_offset);
                trace(|| format!("adjust_offset: leaving-plane snap branch offseta={offseta:.6} -> new_offset={new_offset:?}"));
            }

            // 311955-311979: push check_pos out of a penetrated, non-water,
            // known-cell contact plane.
            if !self.collision_info.contact_plane_is_water
                && self.collision_info.contact_plane_cell_id != 0
            {
                let block = LandDefs::get_block_offset(
                    self.sphere_path.check_pos.objcell_id,
                    self.collision_info.contact_plane_cell_id,
                );
                let gs = self.sphere_path.global_sphere[0]; // v12 = global_sphere[0]
                // v13 = ((center − block_offset) · N) + d
                let v13 = (gs.center.z - block.z) * n.z
                    + (gs.center.y - block.y) * n.y
                    + (gs.center.x - block.x) * n.x
                    + cp.d;
                if v13 < gs.radius - EPSILON {
                    let v14 = (gs.radius - v13) / n.z; // 311970
                    if gs.radius > v14.abs() {
                        // lift check_pos straight up by v14.
                        let push = Vector3::new(0.0, 0.0, v14);
                        self.sphere_path.add_offset_to_check_pos(&push);
                    }
                }
            }
        } else if sliding_opposes {
            // 311982-311993: no contact plane; project the offset off the
            // (opposing) sliding normal.
            let sn = self
                .collision_info
                .sliding_normal
                .expect("v7 implies sliding_normal still valid");
            let v15 = new_offset.x * sn.x + new_offset.z * sn.z + new_offset.y * sn.y;
            new_offset = Vector3::new(
                new_offset.x - v15 * sn.x,
                new_offset.y - v15 * sn.y,
                new_offset.z - v15 * sn.z,
            );
        }

        trace(|| format!("adjust_offset EXIT -> {new_offset:?}"));
        new_offset // 311995-312001: result = new_offset
    }

    /// `CTransition::cliff_slide` (`acclient.c:312005`). When the object walks
    /// off a ledge, slide it horizontally along the edge formed by the new
    /// `contact_plane` and the `last_known_contact_plane`. A degenerate edge ⇒
    /// `1` (OK, no slide); otherwise project the realized displacement onto the
    /// edge normal, push `check_pos` back, record the (sign-corrected) collision
    /// normal, and return `3` (ADJUSTED).
    // acclient.c:312005
    #[allow(clippy::erasing_op)]
    pub fn cliff_slide(&mut self, contact_plane: &Plane) -> i32 {
        let a = contact_plane.normal; // contact_plane->N
        let b = self
            .collision_info
            .last_known_contact_plane
            .map(|p| p.normal)
            .unwrap_or_else(Vector3::zero); // last_known.N (read unconditionally)

        // collision_normal = (-(a×b).y, (a×b).x, 0). The `*0.0` terms are
        // identically zero; kept for faithfulness.
        let v3 = a.y * b.z - a.z * b.y; // (a×b).x
        let v4 = b.x * a.z - b.z * a.x; // (a×b).y
        let v5 = (a.x * b.y - a.y * b.x) * 0.0; // ≡ 0.0
        let mut collision_normal = Vector3::new(v5 - v4, v3 - v5, v4 * 0.0 - v3 * 0.0);

        if normalize_check_small(&mut collision_normal) {
            1 // 312040: no edge direction → OK, no slide.
        } else {
            let block = LandDefs::get_block_offset(
                self.sphere_path.curr_pos.objcell_id,
                self.sphere_path.check_pos.objcell_id,
            );
            let center = self.sphere_path.global_sphere[0].center;
            let curr = self.sphere_path.global_curr_center;
            // gDelta = global_sphere.center − global_curr_center.
            let g = Vector3::new(center.x - curr.x, center.y - curr.y, center.z - curr.z);
            // v13 = (block + gDelta) · collision_normal.
            let v13 = (block.z + g.z) * collision_normal.z
                + (block.y + g.y) * collision_normal.y
                + (block.x + g.x) * collision_normal.x;

            let stored_normal;
            if v13 <= 0.0 {
                let result = Vector3::new(
                    collision_normal.x * v13,
                    collision_normal.y * v13,
                    collision_normal.z * v13,
                );
                self.sphere_path.add_offset_to_check_pos(&result);
                stored_normal = collision_normal;
            } else {
                let v14 = -v13;
                let result = Vector3::new(
                    collision_normal.x * v14,
                    collision_normal.y * v14,
                    collision_normal.z * v14,
                );
                self.sphere_path.add_offset_to_check_pos(&result);
                stored_normal =
                    Vector3::new(-collision_normal.x, -collision_normal.y, -collision_normal.z);
            }
            self.collision_info.set_collision_normal(stored_normal); // normalizes in place
            3 // 312077
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transition::types::CollisionInfo;
    use holtburger_common::Sphere;

    const TOL: f32 = 1e-4;
    fn v(x: f32, y: f32, z: f32) -> Vector3 {
        Vector3::new(x, y, z)
    }
    fn approx(a: Vector3, b: Vector3) -> bool {
        (a.x - b.x).abs() < TOL && (a.y - b.y).abs() < TOL && (a.z - b.z).abs() < TOL
    }
    fn plane(n: Vector3, d: f32) -> Plane {
        Plane { normal: n, d }
    }

    // ── snap_to_plane (311527) ──
    #[test]
    fn snap_to_plane_zeros_normal_component_and_skips_vertical() {
        let p = plane(v(0.0, 0.0, 1.0), -5.0);
        let mut o = v(1.0, 2.0, 3.0);
        snap_to_plane(&p, &mut o);
        assert!(approx(o, v(1.0, 2.0, 0.0)));

        let p2 = plane(v(0.6, 0.0, 0.8), 0.0);
        let mut o2 = v(1.0, 0.0, 1.0);
        snap_to_plane(&p2, &mut o2);
        assert!(approx(o2, v(1.0, 0.0, -0.75)));
        assert!(o2.dot(&v(0.6, 0.0, 0.8)).abs() < TOL);

        let p3 = plane(v(1.0, 0.0, 0.0), 0.0);
        let mut o3 = v(3.0, 4.0, 5.0);
        snap_to_plane(&p3, &mut o3);
        assert!(approx(o3, v(3.0, 4.0, 5.0)));
    }

    // ── Position::get_offset (311691) ──
    #[test]
    fn get_offset_is_end_minus_begin() {
        let mut begin = Position::default();
        begin.frame.origin = v(1.0, 2.0, 3.0);
        let mut end = Position::default();
        end.frame.origin = v(4.0, 6.0, 8.0);
        assert!(approx(begin.get_offset(&end), v(3.0, 4.0, 5.0)));
        assert!(approx(end.get_offset(&begin), v(-3.0, -4.0, -5.0)));
    }

    // ── adjust_offset (311864) — every branch ──
    #[test]
    fn adjust_offset_no_constraints_passthrough() {
        let mut t = CTransition::default();
        assert!(approx(t.adjust_offset(v(1.0, 2.0, 3.0)), v(1.0, 2.0, 3.0)));
    }

    #[test]
    fn adjust_offset_sliding_nonopposing_is_dropped() {
        let mut t = CTransition::default();
        t.collision_info.sliding_normal = Some(v(1.0, 0.0, 0.0));
        let r = t.adjust_offset(v(2.0, 3.0, 0.0)); // dot = 2 ≥ 0
        assert!(approx(r, v(2.0, 3.0, 0.0)));
        assert!(t.collision_info.sliding_normal.is_none());
    }

    #[test]
    fn adjust_offset_sliding_opposing_no_plane_projects_off_normal() {
        let mut t = CTransition::default();
        t.collision_info.sliding_normal = Some(v(1.0, 0.0, 0.0));
        let r = t.adjust_offset(v(-2.0, 3.0, 0.0)); // dot = -2 < 0
        assert!(approx(r, v(0.0, 3.0, 0.0)));
        assert!(t.collision_info.sliding_normal.is_some());
    }

    #[test]
    fn adjust_offset_contact_plane_projection_when_into_plane() {
        let mut t = CTransition::default();
        t.collision_info.contact_plane = Some(plane(v(0.0, 0.0, 1.0), -5.0));
        let r = t.adjust_offset(v(1.0, 2.0, -3.0)); // offseta = -3 ≤ 0
        assert!(approx(r, v(1.0, 2.0, 0.0)));
    }

    #[test]
    fn adjust_offset_contact_plane_snaps_when_leaving_plane() {
        let mut t = CTransition::default();
        t.collision_info.contact_plane = Some(plane(v(0.6, 0.0, 0.8), 0.0));
        let r = t.adjust_offset(v(1.0, 0.0, 1.0)); // offseta = 1.4 > 0
        assert!(approx(r, v(1.0, 0.0, -0.75)));
    }

    #[test]
    fn adjust_offset_cross_product_edge_slide() {
        let mut t = CTransition::default();
        t.collision_info.contact_plane = Some(plane(v(0.0, 0.0, 1.0), 0.0));
        t.collision_info.sliding_normal = Some(v(1.0, 0.0, 0.0));
        let r = t.adjust_offset(v(-1.0, 2.0, 5.0)); // opposes s
        assert!(approx(r, v(0.0, 2.0, 0.0)));
        assert!(t.collision_info.sliding_normal.is_some());
    }

    #[test]
    fn adjust_offset_degenerate_cross_zeroes_offset() {
        let mut t = CTransition::default();
        t.collision_info.contact_plane = Some(plane(v(0.0, 0.0, 1.0), 0.0));
        t.collision_info.sliding_normal = Some(v(0.0, 0.0, 1.0));
        let r = t.adjust_offset(v(1.0, 2.0, -1.0));
        assert!(approx(r, Vector3::zero()));
    }

    #[test]
    fn adjust_offset_pushes_check_pos_out_of_penetrated_plane() {
        let mut t = CTransition::default();
        t.sphere_path.num_sphere = 1;
        t.sphere_path.global_sphere[0] = Sphere { center: v(0.0, 0.0, 0.05), radius: 0.2 };
        t.collision_info.contact_plane = Some(plane(v(0.0, 0.0, 1.0), 0.0));
        t.collision_info.contact_plane_is_water = false;
        t.collision_info.contact_plane_cell_id = 5;
        t.sphere_path.check_pos.objcell_id = 5;
        let r = t.adjust_offset(v(1.0, 1.0, -0.5));
        assert!(approx(r, v(1.0, 1.0, 0.0)));
        // v13 = 0.05 < 0.2-EPS → v14 = 0.15 → lift +z.
        assert!(approx(t.sphere_path.check_pos.frame.origin, v(0.0, 0.0, 0.15)));
        assert!(approx(t.sphere_path.global_sphere[0].center, v(0.0, 0.0, 0.20)));
    }

    #[test]
    fn adjust_offset_pushout_skipped_when_water() {
        let mut t = CTransition::default();
        t.sphere_path.num_sphere = 1;
        t.sphere_path.global_sphere[0] = Sphere { center: v(0.0, 0.0, 0.05), radius: 0.2 };
        t.collision_info.contact_plane = Some(plane(v(0.0, 0.0, 1.0), 0.0));
        t.collision_info.contact_plane_is_water = true;
        t.collision_info.contact_plane_cell_id = 5;
        let _ = t.adjust_offset(v(1.0, 1.0, -0.5));
        assert!(approx(t.sphere_path.check_pos.frame.origin, Vector3::zero()));
    }

    // ── cliff_slide (312005) ──
    #[test]
    fn cliff_slide_degenerate_edge_returns_ok() {
        let mut t = CTransition::default();
        t.collision_info.last_known_contact_plane = Some(plane(v(0.0, 0.0, 1.0), 0.0));
        let r = t.cliff_slide(&plane(v(0.0, 0.0, 1.0), 0.0));
        assert_eq!(r, 1);
        assert!(t.collision_info.collision_normal.is_none());
        assert!(approx(t.sphere_path.check_pos.frame.origin, Vector3::zero()));
    }

    #[test]
    fn cliff_slide_v13_le_zero_stores_positive_normal() {
        let mut t = CTransition::default();
        t.sphere_path.num_sphere = 1;
        t.collision_info.last_known_contact_plane = Some(plane(v(1.0, 0.0, 0.0), 0.0));
        t.sphere_path.global_sphere[0] = Sphere { center: v(2.0, 0.0, 0.0), radius: 1.0 };
        t.sphere_path.global_curr_center = v(0.0, 0.0, 0.0);
        let r = t.cliff_slide(&plane(v(0.0, 0.0, 1.0), 0.0));
        assert_eq!(r, 3);
        assert!(approx(t.sphere_path.check_pos.frame.origin, v(2.0, 0.0, 0.0)));
        assert!(approx(t.collision_info.collision_normal.unwrap(), v(-1.0, 0.0, 0.0)));
    }

    #[test]
    fn cliff_slide_v13_gt_zero_stores_negated_normal() {
        let mut t = CTransition::default();
        t.sphere_path.num_sphere = 1;
        t.collision_info.last_known_contact_plane = Some(plane(v(0.0, 1.0, 0.0), 0.0));
        t.sphere_path.global_sphere[0] = Sphere { center: v(0.0, -2.0, 0.0), radius: 1.0 };
        t.sphere_path.global_curr_center = v(0.0, 0.0, 0.0);
        let r = t.cliff_slide(&plane(v(0.0, 0.0, 1.0), 0.0));
        assert_eq!(r, 3);
        assert!(approx(t.sphere_path.check_pos.frame.origin, v(0.0, 2.0, 0.0)));
        assert!(approx(t.collision_info.collision_normal.unwrap(), v(0.0, 1.0, 0.0)));
    }

    // sanity: CollisionInfo default is what the tests above lean on.
    #[test]
    fn collisioninfo_default_is_empty() {
        let ci = CollisionInfo::default();
        assert!(ci.contact_plane.is_none());
        assert!(ci.sliding_normal.is_none());
    }
}
