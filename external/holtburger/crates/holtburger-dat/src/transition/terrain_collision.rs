//! Outdoor terrain collision geometry (Phase D / WS2).
//!
//! Turns a land cell's four corner heights into the **two collision
//! triangles** the swept-sphere resolver already knows how to test
//! (`ResolvedPolygon` → `polygon_hits_sphere` / `walkable_hits_sphere`),
//! and selects which triangle a query point sits over
//! (`find_terrain_poly`).
//!
//! ## Sources (precedence: acclient.c > ACE > DRW)
//! - **acclient.c** `CLandBlockStruct::ConstructPolygons` (@531D10,
//!   lines ~354001–354100); split magic `1813693831` @354046;
//!   `CLandCell::find_terrain_poly` @354859; `CPolygon::point_in_poly2D`
//!   @359420.
//! - **ACE** (REFERENCE) `Physics/Common/LandblockStruct.cs`
//!   `ConstructPolygons` (lines 182–266), with the two-triangle winding at
//!   `:220-244`; `LandCell.cs:258` `find_terrain_poly`.
//! - **Chorizite** offsets: `ConstructPolygons 0x00532A50`,
//!   `find_terrain_poly 0x00533A30`.
//!
//! The per-cell diagonal hash is the EXISTING [`cell_swto_ne_cut`]
//! (`terrain_subdiv.rs`), shared with the visual mesh and the height
//! sampler — so the collision floor IS the drawn surface. The only freedom
//! left is the per-triangle **vertex winding**, ported verbatim from ACE
//! `LandblockStruct.cs:220-244`; the `triangle_planes_match_height_sampler`
//! invariant test below proves the resulting planes agree with
//! [`triangle_height_in_cell`] (and therefore `terrain_height_at`) to f32
//! epsilon.
//!
//! ## Coordinate frame
//! Triangle vertices are in **landblock-local** metres: the SW corner of
//! cell `(cell_x, cell_y)` is at `(cell_x*24, cell_y*24, z)`, with `x`
//! increasing east and `y` north — exactly ACE's `LandCell.Polygons`
//! frame (`vertex.Origin = (vx*24, vy*24, h)`). [`find_terrain_poly`]
//! therefore takes a landblock-local point, matching `FindEnvCollisions`'
//! `localPoint = GlobalLowPoint − blockOffset` (ACE `LandCell.cs:46-50`).

use crate::physics::{ResolvedPolygon, Sidedness};
use crate::terrain_subdiv::cell_swto_ne_cut;
use holtburger_common::Vector3;

/// `LandDefs::CellLength` — one land cell is 24×24 metres.
pub const CELL_SIZE_M: f32 = 24.0;

/// Build the two collision triangles for one outdoor land cell, in
/// landblock-local coordinates.
///
/// `heights` is the landblock's 9×9 control-height grid flattened as
/// `idx = vx*9 + vy` (x east, y north) — the same layout as
/// `WorldState::terrain_heights`. `cell_x`/`cell_y` are the IN-BLOCK cell
/// indices `[0, 8)`. `landblock_id` provides the GLOBAL cell coordinates
/// (`(landblock>>24 & 0xff)*8 + cell_x`, `(landblock>>16 & 0xff)*8 +
/// cell_y`) that key the deterministic split hash.
///
/// Returns `[triangle0, triangle1]` with retail winding (ACE
/// `LandblockStruct.cs:220-244`):
/// - `cell_swto_ne_cut == true`  (SW↔NE diagonal): `[SW, SE, NE]`, `[SW, NE, NW]`.
/// - `cell_swto_ne_cut == false` (NW↔SE diagonal): `[SW, SE, NW]`, `[NE, NW, SE]`.
///
/// Both triangles' planes are computed with [`ResolvedPolygon::make_plane`]
/// and always face +Z (terrain is never overhanging here, so the XY area is
/// the non-degenerate 24×24 right triangle and `make_plane` always succeeds).
pub fn cell_terrain_polys(
    heights: &[f32; 81],
    landblock_id: u32,
    cell_x: u32,
    cell_y: u32,
) -> [ResolvedPolygon; 2] {
    let cx = cell_x as usize;
    let cy = cell_y as usize;

    // Corner heights (idx = vx*9 + vy): SW=(cx,cy), SE=(cx+1,cy),
    // NW=(cx,cy+1), NE=(cx+1,cy+1) — the `z00/z10/z01/z11` convention shared
    // with `triangle_height_in_cell`.
    let z00 = heights[cx * 9 + cy]; // SW
    let z10 = heights[(cx + 1) * 9 + cy]; // SE (east)
    let z01 = heights[cx * 9 + cy + 1]; // NW (north)
    let z11 = heights[(cx + 1) * 9 + cy + 1]; // NE

    // Landblock-local corner positions.
    let x0 = cell_x as f32 * CELL_SIZE_M;
    let y0 = cell_y as f32 * CELL_SIZE_M;
    let x1 = x0 + CELL_SIZE_M;
    let y1 = y0 + CELL_SIZE_M;
    let sw = Vector3::new(x0, y0, z00);
    let se = Vector3::new(x1, y0, z10);
    let nw = Vector3::new(x0, y1, z01);
    let ne = Vector3::new(x1, y1, z11);

    // Global cell coords for the deterministic per-cell split (same hash the
    // render mesh + height sampler consume).
    let gx = ((landblock_id >> 24) & 0xff) * 8 + cell_x;
    let gy = ((landblock_id >> 16) & 0xff) * 8 + cell_y;
    let sw_ne_cut = cell_swto_ne_cut(gx, gy);

    let (tri0, tri1) = if sw_ne_cut {
        // SW↔NE diagonal (share the SW–NE edge). ACE `:240-243`:
        //   poly0 = AddPolygon(SW, SE, NE)
        //   poly1 = AddPolygon(SW, NE, NW)
        ([sw, se, ne], [sw, ne, nw])
    } else {
        // NW↔SE diagonal (share the NW–SE edge). ACE `:228-231`:
        //   poly0 = AddPolygon(SW, SE, NW)
        //   poly1 = AddPolygon(NE, NW, SE)
        ([sw, se, nw], [ne, nw, se])
    };

    [resolved_tri(tri0), resolved_tri(tri1)]
}

/// Assemble a [`ResolvedPolygon`] from 3 ordered vertices, computing its
/// plane via [`ResolvedPolygon::make_plane`]. The XY projection of a land
/// triangle is always the non-degenerate 24×24 right triangle, so
/// `make_plane` cannot fail here; the fallback flat +Z plane through the
/// first vertex only guards against a future caller passing collinear
/// points.
fn resolved_tri(verts: [Vector3; 3]) -> ResolvedPolygon {
    let v = vec![verts[0], verts[1], verts[2]];
    let plane = ResolvedPolygon::make_plane(&v).unwrap_or(holtburger_common::Plane {
        normal: Vector3::new(0.0, 0.0, 1.0),
        d: -verts[0].z,
    });
    ResolvedPolygon {
        num_points: 3,
        vertices: v,
        plane,
    }
}

/// `CLandCell::find_terrain_poly` (acclient.c:354859 / ACE `LandCell.cs:258`).
/// Return the first of the cell's (≤2) triangles whose XY footprint contains
/// the landblock-local `point`, using the `Positive`-sided
/// [`ResolvedPolygon::point_in_poly2d`] predicate the decomp passes
/// (`point_in_poly2D(poly, origin, 0)`). `None` when the point is in neither
/// triangle (off the cell). Z is ignored (purely a 2D containment test).
pub fn find_terrain_poly(polys: &[ResolvedPolygon], point: Vector3) -> Option<&ResolvedPolygon> {
    polys
        .iter()
        .take(2)
        .find(|p| p.point_in_poly2d(point, Sidedness::Positive))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::terrain_subdiv::triangle_height_in_cell;

    /// Evaluate a polygon's plane height at landblock-local `(x, y)`:
    /// `z = −(N.x·x + N.y·y + d) / N.z`.
    fn plane_height(p: &ResolvedPolygon, x: f32, y: f32) -> f32 {
        let n = p.plane.normal;
        -(n.x * x + n.y * y + p.plane.d) / n.z
    }

    /// A non-flat 9×9 grid so the planes actually tilt.
    fn sloped_grid() -> [f32; 81] {
        let mut h = [0.0f32; 81];
        for vx in 0..9usize {
            for vy in 0..9usize {
                h[vx * 9 + vy] =
                    20.0 + 3.0 * (vx as f32) - 1.5 * (vy as f32) + 0.4 * (vx * vy) as f32;
            }
        }
        h
    }

    /// THE invariant (WS2 acceptance, non-negotiable): the collision triangle
    /// the resolver tests MUST report the same height as the shared sampler
    /// [`triangle_height_in_cell`] (the basis of `terrain_height_at`) at every
    /// interior sample point, for BOTH split directions. If this fails, the
    /// diagonal or the per-triangle winding is wrong.
    #[test]
    fn triangle_planes_match_height_sampler() {
        let h = sloped_grid();
        let mut saw_cut_true = false;
        let mut saw_cut_false = false;
        let mut max_dev = 0.0f32;

        // Scan a spread of real landblock ids so both cut directions occur.
        for &lb in &[0xA9B4_0000u32, 0x00010000, 0x7F7F_0000, 0xFEFE_0000, 0x1234_0000] {
            for cell_x in 0..8u32 {
                for cell_y in 0..8u32 {
                    let polys = cell_terrain_polys(&h, lb, cell_x, cell_y);
                    let gx = ((lb >> 24) & 0xff) * 8 + cell_x;
                    let gy = ((lb >> 16) & 0xff) * 8 + cell_y;
                    let cut = cell_swto_ne_cut(gx, gy);
                    if cut {
                        saw_cut_true = true;
                    } else {
                        saw_cut_false = true;
                    }

                    let cx = cell_x as usize;
                    let cy = cell_y as usize;
                    let z00 = h[cx * 9 + cy];
                    let z10 = h[(cx + 1) * 9 + cy];
                    let z01 = h[cx * 9 + cy + 1];
                    let z11 = h[(cx + 1) * 9 + cy + 1];

                    let x0 = cell_x as f32 * CELL_SIZE_M;
                    let y0 = cell_y as f32 * CELL_SIZE_M;

                    // Sample a 9×9 lattice of interior fractions, nudged off the
                    // diagonal so each point lands unambiguously in one tri.
                    for fi in 0..9 {
                        for fj in 0..9 {
                            let fx = 0.05 + 0.9 * (fi as f32 / 8.0);
                            let fy = 0.05 + 0.9 * (fj as f32 / 8.0);
                            // Skip points sitting right on the diagonal (the
                            // selection there is plane-consistent either way).
                            let on_diag = if cut {
                                (fx - fy).abs() < 1e-3
                            } else {
                                (fx + fy - 1.0).abs() < 1e-3
                            };
                            if on_diag {
                                continue;
                            }
                            let lx = x0 + fx * CELL_SIZE_M;
                            let ly = y0 + fy * CELL_SIZE_M;
                            let point = Vector3::new(lx, ly, 0.0);

                            let poly = find_terrain_poly(&polys, point)
                                .expect("interior point must hit a triangle");
                            let got = plane_height(poly, lx, ly);
                            let want =
                                triangle_height_in_cell(z00, z10, z01, z11, fx, fy, cut);
                            let dev = (got - want).abs();
                            if dev > max_dev {
                                max_dev = dev;
                            }
                            assert!(
                                dev < 1e-3,
                                "lb={lb:#010x} cell=({cell_x},{cell_y}) cut={cut} \
                                 f=({fx:.3},{fy:.3}): plane {got} != sampler {want} (dev {dev})"
                            );
                        }
                    }
                }
            }
        }
        assert!(saw_cut_true, "scan never hit an SW↔NE cell");
        assert!(saw_cut_false, "scan never hit an NW↔SE cell");
        eprintln!("[triangle_planes_match_height_sampler] max dev = {max_dev}");
    }

    /// `find_terrain_poly` selects the correct triangle on each side of the
    /// diagonal, for both cut directions. The corner picked must be the one
    /// whose height the plane reproduces — verified against the sampler.
    #[test]
    fn find_terrain_poly_picks_correct_side() {
        let h = sloped_grid();

        // A cell known to cut SW↔NE and one known to cut NW↔SE.
        let mut cut_true: Option<(u32, u32, u32)> = None;
        let mut cut_false: Option<(u32, u32, u32)> = None;
        'scan: for &lb in &[0xA9B4_0000u32, 0x00010000, 0x7F7F_0000] {
            for cx in 0..8u32 {
                for cy in 0..8u32 {
                    let gx = ((lb >> 24) & 0xff) * 8 + cx;
                    let gy = ((lb >> 16) & 0xff) * 8 + cy;
                    if cell_swto_ne_cut(gx, gy) {
                        cut_true.get_or_insert((lb, cx, cy));
                    } else {
                        cut_false.get_or_insert((lb, cx, cy));
                    }
                    if cut_true.is_some() && cut_false.is_some() {
                        break 'scan;
                    }
                }
            }
        }
        let (lb_t, cx_t, cy_t) = cut_true.expect("found an SW↔NE cell");
        let (lb_f, cx_f, cy_f) = cut_false.expect("found an NW↔SE cell");

        for &(lb, cx, cy, cut) in &[(lb_t, cx_t, cy_t, true), (lb_f, cx_f, cy_f, false)] {
            let polys = cell_terrain_polys(&h, lb, cx, cy);
            let x0 = cx as f32 * CELL_SIZE_M;
            let y0 = cy as f32 * CELL_SIZE_M;

            // Two probes straddling the diagonal.
            let probes: [(f32, f32); 2] = if cut {
                // SW↔NE: fx>fy → tri0 (lower-right), fx<fy → tri1 (upper-left).
                [(0.75, 0.25), (0.25, 0.75)]
            } else {
                // NW↔SE: fx+fy<1 → tri0 (lower-left), fx+fy>1 → tri1 (upper-right).
                [(0.25, 0.25), (0.75, 0.75)]
            };
            let mut picked = [usize::MAX; 2];
            for (k, &(fx, fy)) in probes.iter().enumerate() {
                let lx = x0 + fx * CELL_SIZE_M;
                let ly = y0 + fy * CELL_SIZE_M;
                let point = Vector3::new(lx, ly, 0.0);
                let poly =
                    find_terrain_poly(&polys, point).expect("probe must hit a triangle");
                // Identify which of the two it is by pointer identity.
                picked[k] = if std::ptr::eq(poly, &polys[0]) { 0 } else { 1 };
            }
            assert_eq!(picked[0], 0, "lb={lb:#010x} cut={cut}: first probe should hit tri0");
            assert_eq!(picked[1], 1, "lb={lb:#010x} cut={cut}: second probe should hit tri1");
        }
    }

    /// A point outside the cell footprint hits NEITHER triangle.
    #[test]
    fn find_terrain_poly_none_off_cell() {
        let h = sloped_grid();
        let polys = cell_terrain_polys(&h, 0xA9B4_0000, 3, 4);
        let x0 = 3.0 * CELL_SIZE_M;
        let y0 = 4.0 * CELL_SIZE_M;
        // Well outside the 24×24 footprint.
        let outside = Vector3::new(x0 - 5.0, y0 - 5.0, 0.0);
        assert!(find_terrain_poly(&polys, outside).is_none());
        // Inside is fine (sanity).
        let inside = Vector3::new(x0 + 12.0, y0 + 11.0, 0.0);
        assert!(find_terrain_poly(&polys, inside).is_some());
    }

    /// Flat terrain ⇒ both triangle normals are +Z up (walkability gate, WS3,
    /// reads this orientation).
    #[test]
    fn flat_terrain_normals_point_up() {
        let h = [42.0f32; 81];
        for &lb in &[0xA9B4_0000u32, 0x7F7F_0000] {
            for cx in 0..8u32 {
                for cy in 0..8u32 {
                    let polys = cell_terrain_polys(&h, lb, cx, cy);
                    for p in &polys {
                        assert!(p.plane.normal.z > 0.99, "normal not up: {:?}", p.plane.normal);
                        assert!(p.plane.normal.x.abs() < 1e-5);
                        assert!(p.plane.normal.y.abs() < 1e-5);
                        // Plane height anywhere in the cell == 42.
                        let lx = cx as f32 * CELL_SIZE_M + 10.0;
                        let ly = cy as f32 * CELL_SIZE_M + 10.0;
                        assert!((plane_height(p, lx, ly) - 42.0).abs() < 1e-3);
                    }
                }
            }
        }
    }
}
