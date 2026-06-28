//! `BSPTREE::step_sphere_down` — the gravity / step-down resolver branch of
//! `BSPTREE::find_collisions`. Ported decomp-faithfully from `acclient.c`.
//!
//! Owns:
//! - [`step_sphere_down`] — `BSPTREE::step_sphere_down` (`acclient.c:361177`)
//!
//! When the dispatcher (`BSPTREE::find_collisions`, agent 05) sees
//! `SPHEREPATH::step_down` set, it forwards here: the swept sphere is nudged
//! DOWN its local "up" axis by `step_down_amt * walk_interp` and
//! [`super::bspnode_walkable::find_walkable`] is asked whether that descent
//! lands the sphere on a walkable polygon. If it does, the candidate position
//! (`check_pos`) is slid onto the surface, the resting contact plane is carried
//! into global space, and the walkable record is latched — returning `3`
//! (`ADJUSTED`). Otherwise nothing moved and it returns `1` (`OK`).
//!
//! Decomp shape mirrored faithfully:
//! - `amt = -(step_down_amt * walk_interp)`; the descent direction is
//!   `amt * localspace_z`, and the movement handed to `find_walkable` is that
//!   direction divided by `scale` (the BSP is walked in unscaled local space).
//! - The decomp passes the real `SPHEREPATH*` to `find_walkable`, which mutates
//!   `path->WalkInterp` as it slides; the Phase-1 `find_walkable` collects that
//!   in a [`FindWalkable`] state, so we seed it from `path.walk_interp` and
//!   write the result back (the observable side-effect is preserved).
//! - On a hit the decomp inlines `SPHEREPATH::add_offset_to_check_pos`
//!   (`acclient.c:311557`): `cell_array_valid = 0`, translate `check_pos`'s
//!   origin by the global offset, then `cache_global_sphere(offset)`. We inline
//!   the same three statements to match this function's literal body.
//! - The resting contact plane is the walkable polygon's plane carried out of
//!   `localspace_pos` into `check_pos`-relative global space via
//!   `Plane::localtoglobal` (`acclient.c:467672`), with `d` scaled.

use super::bspnode_walkable::{FindWalkable, find_walkable};
use super::types::{CollisionInfo, LandDefs, SpherePath, TransitionState};
use crate::physics::{BspNode, ResolvedPolygon};
use holtburger_common::{Sphere, Vector3};
use std::collections::HashMap;

/// `BSPTREE::step_sphere_down` (`acclient.c:361177`). Tries to settle the swept
/// sphere down onto a walkable surface beneath it.
///
/// Returns the decomp's `signed int` result: `3`
/// ([`TransitionState::Adjusted`]) when the sphere was slid onto a walkable
/// polygon (and `check_pos` / `collisions` were updated), or `1`
/// ([`TransitionState::Ok`]) when the descent found nothing walkable.
///
/// Arguments mirror the decomp `(this, path, collisions, check_pos, scale)`:
/// - `root` — `BSPTREE *this` reduced to its root [`BspNode`] (Phase-1 style).
/// - `localspace_sphere` — the decomp names this `CSphere *check_pos`, but per
///   the `find_collisions` dispatch map it is the swept `localspace_sphere`
///   (the moving sphere in the BSP cell's local space), NOT `path.check_pos`.
/// - `polys` — the cell's polygon table. The retail BSP stores `CPolygon*`s
///   inline in each leaf; Phase-1 split them into an id→polygon map, so the
///   table the Phase-1 `find_walkable` reads must be threaded in here.
//   RECONCILE: the `find_collisions` dispatch map (spec step 3) lists
//   `step_sphere_down(root, path, collisions, localspace_sphere, scale)` with
//   no `polys` arg — that reflects the inline-CPolygon decomp; the Phase-1
//   `find_walkable`/`set_walkable` need the id→polygon table, so agent 05 must
//   thread `polys` through when it calls this.
// acclient.c:361177
#[allow(clippy::too_many_arguments)]
pub fn step_sphere_down(
    root: &BspNode,
    path: &mut SpherePath,
    collisions: &mut CollisionInfo,
    localspace_sphere: &Sphere,
    scale: f32,
    polys: &HashMap<u16, ResolvedPolygon>,
) -> i32 {
    // v8 = -(path->step_down_amt * path->walk_interp).
    let amt = -(path.step_down_amt * path.walk_interp);

    // valid_pos = *check_pos (center + radius copied); find_walkable slides
    // only its center.
    let mut valid_pos = *localspace_sphere;

    // Descent direction `dir = amt * localspace_z` (result.N in the decomp),
    // then `trans = dir / scale` — the movement walked through the unscaled
    // local BSP.
    let lz = path.localspace_z;
    let dir = Vector3::new(amt * lz.x, amt * lz.y, amt * lz.z);
    let inv_scale = 1.0 / scale;
    let trans = Vector3::new(dir.x * inv_scale, dir.y * inv_scale, dir.z * inv_scale);

    // ((BSPNODE*)root)->find_walkable(path, &valid_pos, &polygon, &trans,
    //                                 &localspace_z, &changed)
    // The decomp hands the real path in (mutating path->WalkInterp); the
    // Phase-1 port collects the moved center / WalkInterp / changed / polygon
    // in `fw`. `walkable_allowance` is read off the path inside the decomp's
    // walkable_hits_sphere — passed explicitly by the Phase-1 signature.
    let mut fw = FindWalkable::new(valid_pos.center, valid_pos.radius, path.walk_interp);
    find_walkable(root, &mut fw, trans, lz, path.walkable_allowance, polys);
    // Preserve the decomp's path->WalkInterp side-effect.
    path.walk_interp = fw.walk_interp;
    valid_pos.center = fw.center;

    // `if ( changed )` — the sphere settled onto a walkable polygon.
    if fw.changed {
        // `changed` implies find_walkable wrote a polygon it pulled from
        // `polys`, so both lookups below are guaranteed to resolve.
        let hit_id = fw
            .hit_poly
            .expect("find_walkable set changed without a hit polygon");
        let poly = polys
            .get(&hit_id)
            .expect("find_walkable's hit polygon must exist in the table");

        // offset = valid_pos.center - check_pos->center (local), rotated into
        // global space by localspace_pos's basis, then * scale.
        let lpos = path.localspace_pos;
        let offset_local = Vector3::new(
            valid_pos.center.x - localspace_sphere.center.x,
            valid_pos.center.y - localspace_sphere.center.y,
            valid_pos.center.z - localspace_sphere.center.z,
        );
        let rot = lpos.frame.localtoglobalvec(offset_local);
        let offset = Vector3::new(rot.x * scale, rot.y * scale, rot.z * scale);

        // Inlined SPHEREPATH::add_offset_to_check_pos (acclient.c:311557):
        // invalidate the cell array, slide check_pos's origin, then slide the
        // cached global sphere(s) by the same offset.
        path.cell_array_valid = false;
        path.check_pos.frame.origin.x += offset.x;
        path.check_pos.frame.origin.y += offset.y;
        path.check_pos.frame.origin.z += offset.z;
        // SPHEREPATH::cache_global_sphere (acclient.c:313748), owned by agent 06
        // (spherepath_methods); called with a non-null offset it shifts every
        // cached global_sphere center + global_low_point by it. The decomp's
        // `offset` is nullable (null ⇒ recompute from check_pos), modeled as
        // `Option<&Vector3>` — the non-null path here is `Some(&offset)`.
        path.cache_global_sphere(Some(&offset));

        // Plane::localtoglobal(&result, to=check_pos, from=localspace_pos,
        //                      &poly->plane), then result.d *= scale.
        // The Phase-1 reduction uses `from` (localspace_pos) for the rotation
        // and a zero cross-cell block offset.
        // PHASE3: the full Position::localtoglobal(check_pos, localspace_pos, pt)
        //   adds LandDefs::get_block_offset(check_pos.objcell_id,
        //   localspace_pos.objcell_id) — non-zero only across landblocks.
        let mut global_plane = lpos.frame.plane_localtoglobal(&poly.plane);
        // Cross-landblock carry (zero within one LB); see A08.
        // acclient.c:467672→147154 (B3 cross-LB test verifies sign).
        global_plane.d -= global_plane.normal.dot(&LandDefs::get_block_offset(
            path.check_pos.objcell_id,
            lpos.objcell_id,
        ));
        global_plane.d *= scale;

        // collisions->contact_plane = result; is_water = 0;
        // contact_plane_cell_id = check_pos.objcell_id.
        collisions.set_contact_plane(global_plane, false);
        collisions.contact_plane_cell_id = path.check_pos.objcell_id;

        // SPHEREPATH::set_walkable(path, &valid_pos, poly, &localspace_z,
        //                          &localspace_pos, scale).
        // RECONCILE: set_walkable is agent 06's full port (writes walkable_*);
        //   the Phase-1 collisioninfo stub takes `&CellPos` and is inert — the
        //   decomp passes `&v5->localspace_pos` (a Position), matched here.
        path.set_walkable(&valid_pos, poly, &lz, &lpos, scale);

        // v31 = 3 (ADJUSTED).
        TransitionState::Adjusted as i32
    } else {
        // v31 = 1 (OK) — nothing walkable beneath the sphere.
        TransitionState::Ok as i32
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::physics::BspLeaf;
    use crate::transition::types::Z_FOR_LANDING;
    use holtburger_common::Plane;

    fn v(x: f32, y: f32, z: f32) -> Vector3 {
        Vector3::new(x, y, z)
    }

    // A 2×2 floor at z = `z0`, normal +Z (walkable from above): N·P + d = 0
    // ⇒ d = -z0.
    fn floor_at(z0: f32) -> ResolvedPolygon {
        ResolvedPolygon {
            num_points: 4,
            vertices: vec![
                v(0.0, 0.0, z0),
                v(2.0, 0.0, z0),
                v(2.0, 2.0, z0),
                v(0.0, 2.0, z0),
            ],
            plane: Plane {
                normal: v(0.0, 0.0, 1.0),
                d: -z0,
            },
        }
    }

    // A vertical wall in the x=0 plane, normal +X (never walkable from +Z).
    fn wall_poly() -> ResolvedPolygon {
        ResolvedPolygon {
            num_points: 4,
            vertices: vec![
                v(0.0, 0.0, 0.0),
                v(0.0, 2.0, 0.0),
                v(0.0, 2.0, 2.0),
                v(0.0, 0.0, 2.0),
            ],
            plane: Plane {
                normal: v(1.0, 0.0, 0.0),
                d: 0.0,
            },
        }
    }

    // A single-polygon leaf whose bounding sphere (centre (1,1,0), r=10) covers
    // every test sphere below.
    fn leaf_node(poly_ids: Vec<u16>) -> BspNode {
        BspNode::Leaf(BspLeaf {
            index: 0,
            solid: 0,
            sphere: Some(Sphere {
                center: v(1.0, 1.0, 0.0),
                radius: 10.0,
            }),
            poly_ids,
        })
    }

    fn single(poly: ResolvedPolygon) -> HashMap<u16, ResolvedPolygon> {
        let mut m = HashMap::new();
        m.insert(0u16, poly);
        m
    }

    // A default path with the fields step_sphere_down reads pre-set.
    fn base_path() -> SpherePath {
        SpherePath {
            step_down_amt: 1.0,
            walk_interp: 1.0,
            localspace_z: v(0.0, 0.0, 1.0),
            walkable_allowance: Z_FOR_LANDING,
            ..Default::default()
        }
    }

    /// Hand-derived NO-LANDING case → returns 1 (OK). The only polygon is a
    /// vertical wall: `walkable_hits_sphere` rejects it (up·N = 0 ≤ allowance),
    /// so `find_walkable` never adjusts. Nothing moves: `check_pos` origin and
    /// `walk_interp` are untouched, no contact plane is recorded.
    #[test]
    fn step_down_no_walkable_returns_ok() {
        let mut path = base_path();
        let mut collisions = CollisionInfo::default();
        let sphere = Sphere {
            center: v(0.3, 1.0, 1.0),
            radius: 0.5,
        };

        let r = step_sphere_down(
            &leaf_node(vec![0]),
            &mut path,
            &mut collisions,
            &sphere,
            1.0,
            &single(wall_poly()),
        );

        assert_eq!(r, 1, "no walkable surface ⇒ OK");
        assert_eq!(r, TransitionState::Ok as i32);
        assert_eq!(path.check_pos.frame.origin, Vector3::zero());
        assert!((path.walk_interp - 1.0).abs() < 1e-4);
        assert!(collisions.contact_plane.is_none());
        // find_walkable never ran an adjust, so the cell array stays valid-as-is.
        assert!(!path.cell_array_valid);
    }

    /// Hand-derived LANDING case (identity frame, scale 1) → returns 3.
    ///
    /// `amt = -(1·1) = -1`, descent dir `(0,0,-1)`, `trans = dir/1 = (0,0,-1)`.
    /// Sphere (1,1,0.3) r=0.5 over the z=0 floor: `find_walkable` slides it to
    /// z=0.5 (one radius above the plane), `walk_interp` → (1-0.2)·1 = 0.8.
    ///   offset_local = (0,0,0.2); identity basis ⇒ offset = (0,0,0.2)·1.
    ///   check_pos.origin += (0,0,0.2). Walkable plane (z=0) carried through the
    ///   identity frame stays N=(0,0,1), d=0; ·scale ⇒ d=0.
    /// `contact_plane_cell_id` copies `check_pos.objcell_id` (set to 0x1234).
    #[test]
    fn step_down_lands_on_floor_returns_adjusted() {
        let mut path = base_path();
        path.check_pos.objcell_id = 0x1234;
        let mut collisions = CollisionInfo::default();
        let sphere = Sphere {
            center: v(1.0, 1.0, 0.3),
            radius: 0.5,
        };

        let r = step_sphere_down(
            &leaf_node(vec![0]),
            &mut path,
            &mut collisions,
            &sphere,
            1.0,
            &single(floor_at(0.0)),
        );

        assert_eq!(r, 3, "landed ⇒ ADJUSTED");
        assert_eq!(r, TransitionState::Adjusted as i32);
        // check_pos origin slid up by the global offset (0,0,0.2).
        assert!((path.check_pos.frame.origin.x).abs() < 1e-4);
        assert!((path.check_pos.frame.origin.y).abs() < 1e-4);
        assert!(
            (path.check_pos.frame.origin.z - 0.2).abs() < 1e-4,
            "z={}",
            path.check_pos.frame.origin.z
        );
        // WalkInterp side-effect from find_walkable.
        assert!((path.walk_interp - 0.8).abs() < 1e-4, "wi={}", path.walk_interp);
        // Cached cell ring invalidated by the move.
        assert!(!path.cell_array_valid);
        // Global contact plane: floor normal, d=0, cell id copied.
        let cp = collisions.contact_plane.expect("contact plane set");
        assert!((cp.normal.x).abs() < 1e-4);
        assert!((cp.normal.y).abs() < 1e-4);
        assert!((cp.normal.z - 1.0).abs() < 1e-4);
        assert!((cp.d).abs() < 1e-4, "d={}", cp.d);
        assert!(!collisions.contact_plane_is_water);
        assert_eq!(collisions.contact_plane_cell_id, 0x1234);
    }

    /// Hand-derived LANDING with scale ≠ 1 and a non-zero plane distance,
    /// exercising the `* scale` on BOTH the global offset and the plane `d`.
    ///
    /// Floor at local z=1 (N=(0,0,1), d=-1). `step_down_amt=2`, `walk_interp=1`
    /// ⇒ `amt=-2`, dir `(0,0,-2)`, `scale=2` ⇒ `trans = dir/2 = (0,0,-1)`.
    /// Sphere (1,1,1.3) r=0.5 slides to z=1.5; `walk_interp` → 0.8.
    ///   offset_local = (0,0,0.2); identity basis, ·scale=2 ⇒ offset=(0,0,0.4).
    ///   check_pos.origin.z += 0.4.
    ///   walkable plane local d=-1 → global d=-1, ·scale=2 ⇒ d=-2.
    #[test]
    fn step_down_scaled_landing_scales_offset_and_plane_d() {
        let mut path = base_path();
        path.step_down_amt = 2.0;
        let mut collisions = CollisionInfo::default();
        let sphere = Sphere {
            center: v(1.0, 1.0, 1.3),
            radius: 0.5,
        };

        let r = step_sphere_down(
            &leaf_node(vec![0]),
            &mut path,
            &mut collisions,
            &sphere,
            2.0,
            &single(floor_at(1.0)),
        );

        assert_eq!(r, 3);
        assert!(
            (path.check_pos.frame.origin.z - 0.4).abs() < 1e-4,
            "z={}",
            path.check_pos.frame.origin.z
        );
        assert!((path.walk_interp - 0.8).abs() < 1e-4, "wi={}", path.walk_interp);
        let cp = collisions.contact_plane.expect("contact plane set");
        assert!((cp.normal.z - 1.0).abs() < 1e-4);
        assert!((cp.d + 2.0).abs() < 1e-4, "d={}", cp.d);
    }
}
