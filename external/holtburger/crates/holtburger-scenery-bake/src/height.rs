//! Per-LB height sample. Two implementations, selected at bake time
//! via [`crate::BakeMode`]:
//!
//! - **Triangle-plane** ([`triangle_plane_height_from_grid`]) — verbatim
//!   port of ACE's `LandblockMesh.GetZ`. Each 8×8 cell is split into two
//!   triangles by a diagonal from [`get_split_dir`] (a deterministic hash
//!   of the global cell coord); Z is the plane equation of whichever
//!   triangle contains the query point. Used by [`crate::BakeMode::AceCompat`]
//!   — the **default**, and the mode that lands scenery on the Z the player
//!   actually stands on: the render meshes (`build_mesh`, `subdivide_landblock`)
//!   and physics (`holtburger_world::state::types::terrain_height_at`) all
//!   interpolate within the per-cell TRIANGLE. Also used by
//!   [`crate::BakeMode::Retail`] (retail `Plane::set_height` on the walkable
//!   terrain triangle), through [`triangle_plane_from_grid`], which also
//!   returns that triangle's normal for retail's slope gate.
//! - **Bilinear** ([`bilinear_height_from_grid`]) — interpolates across the
//!   whole cell quad. Used by [`crate::BakeMode::Strict`]. NOTE (2026-06-26):
//!   this NO LONGER matches the player/render surface — physics + render moved
//!   to the per-cell triangle on 2026-06-19/20, so bilinear now diverges from
//!   the drawn ground by up to `twist/4` (~1.15 m) on saddle cells. Retained
//!   only as an explicit alternative.
//!
//! ## Why the two modes
//!
//! At the 4 corners of each cell both methods evaluate to the vertex
//! height — they agree exactly there. Along the diagonal they disagree:
//! bilinear interpolates across the whole quad, triangle-plane snaps to
//! whichever triangle contains the point. Since the renderer and
//! `holtburger-world` physics now both interpolate the per-cell TRIANGLE,
//! **AceCompat is the mode that matches where the player walks**; Strict
//! (bilinear) is the divergent option.
//!
//! The two split hashes are equivalent: [`get_split_dir`] (ACE convention,
//! `true` = NW-SE) and `holtburger_dat::terrain_subdiv::cell_swto_ne_cut`
//! (retail convention, `true` = SW↔NE) select the SAME diagonal with inverse
//! boolean sense — locked by the `split_conformance` test below.
//!
//! Determinism is preserved either way — the bake's output is
//! byte-identical given identical inputs.
//!
//! ## ACE source map for the triangle-plane path
//!
//! - `LandblockMesh.GetZ(Vector2)`             → [`triangle_plane_height_from_grid`]
//! - `LandblockMesh.GetSplitDir(id, cellX, cellY)` → [`get_split_dir`]
//! - `LandblockMesh.GetCell(point)` / `GetCellTriangles(cell)` / `BuildTriangles` → fused into `triangle_plane_height_from_grid`
//! - `Triangle.Contains(point, vertices)`      → [`triangle_contains_xy`]
//! - `Triangle.GetZ(vertices, point)`          → plane equation inline in `triangle_plane_height_from_grid`
//!
//! ## A note on the per-cell diagonal split
//!
//! `GetSplitDir` returns true iff the cell uses the NW-SE diagonal,
//! false iff NE-SW. The discriminator is the hash
//! `dw = x*y*0x0CCAC033 - x*0x421BE3BD + y*0x6C1AC587 - 0x519B8F25`
//! evaluated in **signed 32-bit** arithmetic — i.e. C# `int` semantics,
//! which means the multiplications are signed wrapping. We mirror with
//! `i32::wrapping_*`. Then split direction is `(dw & 0x80000000) == 0`
//! — equivalently `dw >= 0` after the signed cast. (`x, y` are u32
//! global cell coords but their products fit into i32 modulo 2^32.)
//!
//! ## Inputs
//!
//! - `CellLandblock.height` — 81-byte index array, row-major in the
//!   form `idx = vx * 9 + vy`.
//! - `Region.land_defs.land_height_table` — 256-entry f32 lookup.

use holtburger_dat::file_type::Region;
use holtburger_dat::landblock::{decode_land_height, CellLandblock};

/// A landblock has 9 vertices per side (`CellDim + 1`).
pub const VERTEX_DIM: usize = 9;
/// A landblock cell spans `LANDBLOCK_SIZE / CellDim = 24` units.
pub const CELL_SIZE: f32 = 24.0;
/// A landblock is `192 × 192` units.
pub const LANDBLOCK_SIZE: f32 = 192.0;

/// Read the 9×9 vertex heights for the landblock, mapping each height
/// byte through `region.land_defs.land_height_table`. Returns a
/// row-major `[f32; 81]` indexed `vx * 9 + vy`.
///
/// F12-4: routes through the shared [`decode_land_height`] so this bake
/// path and the render + walk paths (`CellLandblock::get_height_with_table`)
/// share one decoder instead of two. For the full 256-entry retail/region
/// table every `u8` height byte is in range, so the result is unchanged.
pub fn vertex_heights(region: &Region, lb: &CellLandblock) -> [f32; 81] {
    let table = &region.land_defs.land_height_table;
    let mut out = [0.0f32; 81];
    for (i, &h) in lb.height.iter().enumerate() {
        out[i] = decode_land_height(h, Some(table));
    }
    out
}

/// Bilinear-interpolated terrain Z at `(lx, ly)` in LB-local coords
/// `[0, 192]`.
///
/// Out-of-range inputs are clamped to the LB. Mirrors the layout used
/// by `holtburger_world::state::types::terrain_height_at`:
///
/// - `cell_x = clamp(lx / 24, 0, 8)`
/// - `idx = vx * 9 + vy`
/// - 4-corner bilinear blend.
pub fn bilinear_height(region: &Region, lb: &CellLandblock, lx: f32, ly: f32) -> f32 {
    let heights = vertex_heights(region, lb);
    bilinear_height_from_grid(&heights, lx, ly)
}

/// Same as `bilinear_height` but takes the pre-resolved 9×9 height
/// grid directly. Use this in the hot bake loop to avoid re-looking-up
/// the height table for every candidate placement.
pub fn bilinear_height_from_grid(heights: &[f32; 81], lx: f32, ly: f32) -> f32 {
    // Clamp to `[0, 8]` — `cx0` can be up to 8, then `cx1` collapses to
    // 8 too. Matches `holtburger_world::state::types::terrain_height_at`.
    let cell_x = (lx / CELL_SIZE).clamp(0.0, (VERTEX_DIM - 1) as f32);
    let cell_y = (ly / CELL_SIZE).clamp(0.0, (VERTEX_DIM - 1) as f32);
    let cx0 = (cell_x.floor() as usize).min(VERTEX_DIM - 1);
    let cy0 = (cell_y.floor() as usize).min(VERTEX_DIM - 1);
    let cx1 = (cx0 + 1).min(VERTEX_DIM - 1);
    let cy1 = (cy0 + 1).min(VERTEX_DIM - 1);
    let fx = cell_x - cx0 as f32;
    let fy = cell_y - cy0 as f32;
    let z00 = heights[cx0 * VERTEX_DIM + cy0];
    let z10 = heights[cx1 * VERTEX_DIM + cy0];
    let z01 = heights[cx0 * VERTEX_DIM + cy1];
    let z11 = heights[cx1 * VERTEX_DIM + cy1];
    z00 * (1.0 - fx) * (1.0 - fy)
        + z10 * fx * (1.0 - fy)
        + z01 * (1.0 - fx) * fy
        + z11 * fx * fy
}

/// Determine the diagonal-split direction for landblock cell `(cellX,
/// cellY)`. Verbatim port of `LandblockMesh.GetSplitDir`.
///
/// Returns `true` for an NW-SE split (`/`), `false` for NE-SW (`\`).
/// Source-of-truth comment in ACE attributes the magic constants to
/// <https://github.com/deregtd/AC2D> — we mirror them byte-exact.
///
/// `landblock_id_top_16` is the high 16 bits of the LB id, i.e.
/// `(lb_x << 8) | lb_y` (ACE's `LandblockId.LandblockX/Y` getters).
/// We accept it as a single 16-bit value rather than two u8s to keep
/// the call site short.
#[inline]
pub fn get_split_dir(landblock_id_top_16: u16, cell_x: i32, cell_y: i32) -> bool {
    let lb_x = ((landblock_id_top_16 >> 8) & 0xFF) as i32;
    let lb_y = (landblock_id_top_16 & 0xFF) as i32;
    // ACE: `var x = (id.LandblockX * 8) + cellX;`
    //      `var y = (id.LandblockY * 8) + cellY;`
    // Both `LandblockX` and `cellX` are ints in C#; signed-wrapping mul.
    let x = lb_x.wrapping_mul(8).wrapping_add(cell_x);
    let y = lb_y.wrapping_mul(8).wrapping_add(cell_y);
    // ACE: `var dw = x*y*0x0CCAC033 - x*0x421BE3BD + y*0x6C1AC587 - 0x519B8F25;`
    // All signed-wrapping i32 arithmetic. The constants are bare hex,
    // so they're positive i32 literals (all < 2^31).
    let xy = x.wrapping_mul(y);
    let term0 = xy.wrapping_mul(0x0CCA_C033);
    let term1 = x.wrapping_mul(0x421B_E3BD);
    let term2 = y.wrapping_mul(0x6C1A_C587);
    let dw = term0.wrapping_sub(term1).wrapping_add(term2).wrapping_sub(0x519B_8F25);
    // `(dw & 0x80000000) == 0` — i.e. the sign bit is 0, i.e. dw >= 0.
    dw >= 0
}

#[cfg(test)]
mod split_conformance {
    use super::get_split_dir;
    use holtburger_dat::terrain_subdiv::cell_swto_ne_cut;

    /// ACE's `get_split_dir` (`true` = NW-SE) and the retail
    /// `cell_swto_ne_cut` (`true` = SW↔NE) are the SAME geometric diagonal
    /// with INVERSE boolean sense (the hash constants are bit-identical:
    /// 0x0CCAC033 == 214614067, etc.). Lock that across a spread of
    /// landblocks + cells so the bake's diagonal can never silently drift
    /// from the surface the player stands on.
    #[test]
    fn split_dir_matches_retail_cell_swto_ne_cut() {
        for lb_x in [0u16, 1, 42, 0xA9, 0xFE, 0xFF] {
            for lb_y in [0u16, 7, 0xB4, 0xC0, 0xFF] {
                let top16 = (lb_x << 8) | lb_y;
                for cx in 0..8i32 {
                    for cy in 0..8i32 {
                        let gx = (lb_x as u32) * 8 + cx as u32;
                        let gy = (lb_y as u32) * 8 + cy as u32;
                        let ace = get_split_dir(top16, cx, cy);
                        let retail = cell_swto_ne_cut(gx, gy);
                        assert_eq!(
                            ace, !retail,
                            "split mismatch at lb=({lb_x:#x},{lb_y:#x}) cell=({cx},{cy}): \
                             ace(NW-SE)={ace} retail(SW-NE)={retail}"
                        );
                    }
                }
            }
        }
    }
}

/// 2D triangle containment test. Mirrors `Triangle.Contains` from
/// `~/ace-server/Source/ACE.Server/Entity/Triangle.cs`. Edge cases on
/// the boundary count as "contained" (the `< 0` rejects in ACE skip
/// strict negativity, so 0 is contained — we match).
///
/// `p1/p2/p3` are `(x, y, z)` triples but only `xy` is consulted.
#[inline]
fn triangle_contains_xy(
    p1: (f32, f32, f32),
    p2: (f32, f32, f32),
    p3: (f32, f32, f32),
    px: f32,
    py: f32,
) -> bool {
    // ACE: `area = 0.5f * (-p2.Y*p3.X + p1.Y*(-p2.X+p3.X) + p1.X*(p2.Y-p3.Y) + p2.X*p3.Y);`
    let area = 0.5
        * (-p2.1 * p3.0
            + p1.1 * (-p2.0 + p3.0)
            + p1.0 * (p2.1 - p3.1)
            + p2.0 * p3.1);
    if area == 0.0 {
        return false;
    }
    // ACE: `s = 1/(2*area) * (p1.Y*p3.X - p1.X*p3.Y + (p3.Y-p1.Y)*px + (p1.X-p3.X)*py);`
    let s = (1.0 / (2.0 * area))
        * (p1.1 * p3.0 - p1.0 * p3.1 + (p3.1 - p1.1) * px + (p1.0 - p3.0) * py);
    if s < 0.0 {
        return false;
    }
    // ACE: `t = 1/(2*area) * (p1.X*p2.Y - p1.Y*p2.X + (p1.Y-p2.Y)*px + (p2.X-p1.X)*py);`
    let t = (1.0 / (2.0 * area))
        * (p1.0 * p2.1 - p1.1 * p2.0 + (p1.1 - p2.1) * px + (p2.0 - p1.0) * py);
    if t < 0.0 || 1.0 - s - t < 0.0 {
        return false;
    }
    true
}

/// Compute Z from a 3-vertex plane equation. Mirrors `Triangle.GetZ`
/// from ACE.
#[inline]
fn triangle_plane_z(
    p1: (f32, f32, f32),
    p2: (f32, f32, f32),
    p3: (f32, f32, f32),
    px: f32,
    py: f32,
) -> f32 {
    let v1 = (p1.0 - p3.0, p1.1 - p3.1, p1.2 - p3.2);
    let v2 = (p2.0 - p3.0, p2.1 - p3.1, p2.2 - p3.2);
    let abc_x = v1.1 * v2.2 - v1.2 * v2.1;
    let abc_y = v1.2 * v2.0 - v1.0 * v2.2;
    let abc_z = v1.0 * v2.1 - v1.1 * v2.0;
    let d = abc_x * p3.0 + abc_y * p3.1 + abc_z * p3.2;
    (d - abc_x * px - abc_y * py) / abc_z
}

/// One cell triangle as three `(x, y, z)` corners, in ACE `BuildTriangles`
/// order.
type CellTriangle = ((f32, f32, f32), (f32, f32, f32), (f32, f32, f32));

/// **ACE-parity triangle-plane Z at `(lx, ly)`**. Verbatim port of
/// `LandblockMesh.GetZ`.
///
/// `landblock_id_top_16` is the high 16 bits of the LB id
/// (`(lb_x << 8) | lb_y`) — needed by [`get_split_dir`] for the
/// per-cell diagonal direction.
///
/// Out-of-range inputs are clamped to the LB rectangle, matching
/// `LandblockMesh.GetCell`'s `cellX < 0 → 0`, `cellX >= 8 → 7` clamps.
pub fn triangle_plane_height_from_grid(
    heights: &[f32; 81],
    landblock_id_top_16: u16,
    lx: f32,
    ly: f32,
) -> f32 {
    let (p1, p2, p3) = cell_triangle_at(heights, landblock_id_top_16, lx, ly);
    triangle_plane_z(p1, p2, p3, lx, ly)
}

/// The walkable terrain triangle under a point: its plane Z there and its
/// upward unit normal. Returned by [`triangle_plane_from_grid`].
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TrianglePlane {
    /// Triangle-plane Z, bit-identical to [`triangle_plane_height_from_grid`].
    pub z: f32,
    /// Upward (`z >= 0`) unit normal `(x, y, z)` of the triangle.
    pub normal: (f32, f32, f32),
}

impl TrianglePlane {
    /// `N.z`, the cosine of the triangle's slope: what retail
    /// `ObjectDesc::CheckSlope` tests (`acclient.c:351355`, called with
    /// `walkable->plane.N.z` at :352699).
    #[inline]
    pub fn normal_z(&self) -> f32 {
        self.normal.2
    }
}

/// [`triangle_plane_height_from_grid`] plus the triangle's upward unit
/// normal, for `BakeMode::Retail`'s slope gate (terrain-scenery-3).
///
/// Same cell clamp, same diagonal ([`get_split_dir`]) and same T0-then-T1
/// choice, so `z` is bit-identical to [`triangle_plane_height_from_grid`]
/// and the normal belongs to the triangle that `z` came from. Retail's
/// gate reads `walkable->plane.N.z` of the terrain polygon
/// `CLandCell::find_terrain_poly` returns (`acclient.c:352698-352699`):
/// the one cell triangle under the point, not the 4-corner average
/// [`normal_z_at`] fits (those differ on a saddle cell, where the average
/// gradient is zero but both triangles slope).
///
/// The normal follows `CPolygon::make_plane` (`acclient.c:359628`): the
/// edge cross product, scaled by `1 / sqrt(|n|^2)` narrowed to float.
pub fn triangle_plane_from_grid(
    heights: &[f32; 81],
    landblock_id_top_16: u16,
    lx: f32,
    ly: f32,
) -> TrianglePlane {
    let (p1, p2, p3) = cell_triangle_at(heights, landblock_id_top_16, lx, ly);
    TrianglePlane {
        z: triangle_plane_z(p1, p2, p3, lx, ly),
        normal: triangle_up_normal(p1, p2, p3),
    }
}

/// Upward unit normal of a triangle (see [`triangle_plane_from_grid`]).
/// Terrain triangles always have a non-zero XY area (`|n.z| = 576`), so
/// the degenerate fallback (straight up) is unreachable for them.
fn triangle_up_normal(
    p1: (f32, f32, f32),
    p2: (f32, f32, f32),
    p3: (f32, f32, f32),
) -> (f32, f32, f32) {
    let v1 = (
        p1.0 as f64 - p3.0 as f64,
        p1.1 as f64 - p3.1 as f64,
        p1.2 as f64 - p3.2 as f64,
    );
    let v2 = (
        p2.0 as f64 - p3.0 as f64,
        p2.1 as f64 - p3.1 as f64,
        p2.2 as f64 - p3.2 as f64,
    );
    let nx = v1.1 * v2.2 - v1.2 * v2.1;
    let ny = v1.2 * v2.0 - v1.0 * v2.2;
    let nz = v1.0 * v2.1 - v1.1 * v2.0;
    let len = (nx * nx + ny * ny + nz * nz).sqrt();
    if !(len > 0.0 && len.is_finite()) {
        return (0.0, 0.0, 1.0);
    }
    // make_plane: `v19 = (float)(1.0 / sqrt(...))`, then N = v19 * n.
    let inv = (1.0 / len) as f32 as f64;
    let inv = if nz < 0.0 { -inv } else { inv };
    ((nx * inv) as f32, (ny * inv) as f32, (nz * inv) as f32)
}

/// The cell triangle holding `(lx, ly)` — the selection half of ACE
/// `LandblockMesh.GetZ`, shared by [`triangle_plane_height_from_grid`] and
/// [`triangle_plane_from_grid`].
fn cell_triangle_at(
    heights: &[f32; 81],
    landblock_id_top_16: u16,
    lx: f32,
    ly: f32,
) -> CellTriangle {
    // ACE LandblockMesh.GetCell: clamp to [0, CellDim-1] = [0, 7].
    let cell_x = (lx / CELL_SIZE).floor() as i32;
    let cell_y = (ly / CELL_SIZE).floor() as i32;
    let cell_x = cell_x.clamp(0, 7);
    let cell_y = cell_y.clamp(0, 7);

    // Cell corner vertex indices. ACE LandblockMesh.LoadVertices stores
    // vertices in `vx * 9 + vy` order — `idx = x*VertexDim + y`. The
    // four corners are:
    //   ll = (x  , y  ) → x*9 + y
    //   lr = (x+1, y  ) → (x+1)*9 + y
    //   tl = (x  , y+1) → x*9 + (y+1)
    //   tr = (x+1, y+1) → (x+1)*9 + (y+1)
    let x = cell_x as usize;
    let y = cell_y as usize;
    let ll_idx = x * VERTEX_DIM + y;
    let lr_idx = (x + 1) * VERTEX_DIM + y;
    let tl_idx = x * VERTEX_DIM + (y + 1);
    let tr_idx = (x + 1) * VERTEX_DIM + (y + 1);

    let lower_left = (cell_x as f32 * CELL_SIZE, cell_y as f32 * CELL_SIZE, heights[ll_idx]);
    let lower_right = ((cell_x + 1) as f32 * CELL_SIZE, cell_y as f32 * CELL_SIZE, heights[lr_idx]);
    let top_left = (cell_x as f32 * CELL_SIZE, (cell_y + 1) as f32 * CELL_SIZE, heights[tl_idx]);
    let top_right = ((cell_x + 1) as f32 * CELL_SIZE, (cell_y + 1) as f32 * CELL_SIZE, heights[tr_idx]);

    // ACE BuildTriangles, per cell:
    //   if GetSplitDir(id, x, y):  // NW-SE split — 'true' branch
    //     T0 = (topLeft, lowerRight, lowerLeft)   // CW winding
    //     T1 = (topLeft, topRight, lowerRight)
    //   else:                       // NE-SW split — 'false' branch
    //     T0 = (topRight, lowerRight, lowerLeft)
    //     T1 = (topRight, lowerLeft, topLeft)
    let split = get_split_dir(landblock_id_top_16, cell_x, cell_y);
    let (t0, t1) = if split {
        ((top_left, lower_right, lower_left), (top_left, top_right, lower_right))
    } else {
        ((top_right, lower_right, lower_left), (top_right, lower_left, top_left))
    };

    // ACE GetTriangle: try T0 first, fall through to T1 (no third path
    // — Contains failures on T0 always route to T1). We mirror that
    // exactly, including the "always-T1 if T0 fails" behaviour for
    // points outside the cell (a clamped-OOB query, e.g.).
    if triangle_contains_xy(t0.0, t0.1, t0.2, lx, ly) {
        t0
    } else {
        t1
    }
}

/// Estimate the local terrain slope (radians) at `(lx, ly)` for the
/// `min_slope`/`max_slope` rejection check.
///
/// Method: sample heights at the 4 surrounding cell corners, fit a
/// plane, compute the angle between the plane normal and +Z. Mirrors
/// the spirit of ACE's `TODO: ensure walkable slope` — we implement
/// the check rather than skip it because ACE will close that TODO at
/// some point and our bake should not produce placements ACE will
/// later correct away.
///
/// Returns slope in radians (0 = flat, π/2 = vertical).
pub fn slope_at(heights: &[f32; 81], lx: f32, ly: f32) -> f32 {
    let (dz_dx, dz_dy) = gradient_at(heights, lx, ly);
    // Slope angle = atan(magnitude of gradient).
    (dz_dx * dz_dx + dz_dy * dz_dy).sqrt().atan()
}

/// Z component of the unit terrain-plane normal at `(lx, ly)` — i.e.
/// `cos(slope_angle)`. **This is the value retail's
/// `ObjectDesc::CheckSlope` tests** (`acclient.c:351355` takes
/// `walkable->plane.N.z`): `1.0` on flat ground, `0.0` on a vertical
/// face. The `min_slope`/`max_slope` fields on `ObjectDesc` are NOT
/// radians despite their historic doc-comments — they are cosines
/// (real DAT values cluster in 0.86–0.98, unmistakably cos θ), so the
/// slope-rejection comparison must run against this normal-Z, not the
/// `slope_at` angle.
///
/// This is `BakeMode::Strict`'s gate and only approximates retail's: it
/// fits ONE plane to the cell's four corners, whereas retail reads the
/// normal of the cell TRIANGLE under the point. `BakeMode::Retail` uses
/// [`triangle_plane_from_grid`] instead (the two differ most on a saddle
/// cell, where this returns `1.0` but both triangles slope).
///
/// For a plane with gradient `(g_x, g_y)` the unit normal is
/// `(-g_x, -g_y, 1) / sqrt(g_x² + g_y² + 1)`, so
/// `N.z = 1 / sqrt(g_x² + g_y² + 1)` = `cos(atan(|grad|))`.
pub fn normal_z_at(heights: &[f32; 81], lx: f32, ly: f32) -> f32 {
    let (dz_dx, dz_dy) = gradient_at(heights, lx, ly);
    1.0 / (dz_dx * dz_dx + dz_dy * dz_dy + 1.0).sqrt()
}

/// Shared 4-corner plane-fit used by [`slope_at`] and [`normal_z_at`].
/// Returns `(dz/dx, dz/dy)` — the average height gradient within the
/// cell containing `(lx, ly)`.
fn gradient_at(heights: &[f32; 81], lx: f32, ly: f32) -> (f32, f32) {
    let cell_x = (lx / CELL_SIZE).clamp(0.0, (VERTEX_DIM - 1) as f32);
    let cell_y = (ly / CELL_SIZE).clamp(0.0, (VERTEX_DIM - 1) as f32);
    let cx0 = (cell_x.floor() as usize).min(VERTEX_DIM - 1);
    let cy0 = (cell_y.floor() as usize).min(VERTEX_DIM - 1);
    let cx1 = (cx0 + 1).min(VERTEX_DIM - 1);
    let cy1 = (cy0 + 1).min(VERTEX_DIM - 1);
    let z00 = heights[cx0 * VERTEX_DIM + cy0];
    let z10 = heights[cx1 * VERTEX_DIM + cy0];
    let z01 = heights[cx0 * VERTEX_DIM + cy1];
    let z11 = heights[cx1 * VERTEX_DIM + cy1];
    // Average slope along X and Y axes within the cell.
    let dz_dx = ((z10 - z00) + (z11 - z01)) * 0.5 / CELL_SIZE;
    let dz_dy = ((z01 - z00) + (z11 - z10)) * 0.5 / CELL_SIZE;
    (dz_dx, dz_dy)
}

/// `OnRoad` check from `Scenery.cs:166-172`. Returns true if the
/// nearest landblock cell has a non-zero road bit (`terrain & 0x3`).
///
/// Note: ACE's index expression is `cellX * CellDim + cellY` — that's
/// `cellX * 8 + cellY`, which **does not match** the 9×9 terrain
/// grid layout (which uses `idx = vx * 9 + vy`). Looking at the
/// ACE source it's clearly an off-by-one bug in their code — but
/// since the bake's contract is to produce IDENTICAL output to ACE
/// (warts and all), we mirror the exact expression including the
/// indexing mistake.
///
/// This is the `AceCompat` / `Strict` road test only. It is not retail:
/// `BakeMode::Retail` uses [`on_road_retail`] (the 4-corner road band).
pub fn on_road(lb: &CellLandblock, lx: f32, ly: f32) -> bool {
    let cell_x = (lx / CELL_SIZE).floor() as i32;
    let cell_y = (ly / CELL_SIZE).floor() as i32;
    // Bounds-guard — ACE's "TODO: ensure within bounds" comment.
    if cell_x < 0 || cell_y < 0 {
        return false;
    }
    // Mirror ACE's `cellX * CellDim + cellY` indexing exactly. CellDim
    // is 8 (LandblockMesh.cs:25).
    let idx = (cell_x as usize) * 8 + (cell_y as usize);
    if idx >= lb.terrain.len() {
        return false;
    }
    (lb.terrain[idx] & 0x3) != 0
}

/// Retail's scenery road-band width in metres. `CLandBlock::on_road`
/// (`acclient.c:352238`) hard-codes it (`rmax = 24.0 - 5.0`), and
/// `LandDefs::get_vars` (`acclient.c:467318`) packs the same `5.0` into the
/// Region's `LandDefs.road_width`.
pub const RETAIL_ROAD_WIDTH: f32 = 5.0;

/// The road-band width [`on_road_retail`] uses for `region`:
/// `region.land_defs.road_width` when it is usable (`0 < w < CELL_SIZE`),
/// else [`RETAIL_ROAD_WIDTH`]. Retail Regions carry `5.0`, so on real DATs
/// this is exactly retail's literal; the fallback covers synthetic Regions
/// that leave the field zeroed (or NaN).
pub fn retail_road_width(region: &Region) -> f32 {
    let w = region.land_defs.road_width;
    if w > 0.0 && w < CELL_SIZE {
        w
    } else {
        RETAIL_ROAD_WIDTH
    }
}

/// Retail road test for a scenery candidate at LB-local `(lx, ly)` —
/// `CLandBlock::on_road` (`acclient.c:352238`, called from
/// `CLandBlock::get_land_scenes` :352679). Used by
/// [`crate::BakeMode::Retail`] only; `AceCompat` / `Strict` keep
/// [`on_road`].
///
/// Retail reads all four corners of the cell holding the point on the 9×9
/// vertex grid — `t[9*ix + iy]`, `+1`, `+9`, `+10` (decomp
/// `v8 = v5 + v6 + 8 * v5`) — and answers false at once when none carries
/// road bits (`& 3`). Otherwise it tests the cell-local offset `(dx, dy)`
/// against a band `road_width` (5 m) wide along each road edge, an L1 patch
/// around a lone road corner, and a diagonal band when only opposite corners
/// are road. With `w = road_width` and corners r0 `(ix, iy)`, r1
/// `(ix, iy+1)`, r2 `(ix+1, iy)`, r3 `(ix+1, iy+1)`:
///
/// | road corners | on road iff |
/// |---|---|
/// | all four | always |
/// | r0 r1 r2 | `dx < w \|\| dy < w` |
/// | r0 r1 r3 | `dx < w \|\| dy > 24-w` |
/// | r0 r2 r3 | `dx > 24-w \|\| dy < w` |
/// | r1 r2 r3 | `dx > 24-w \|\| dy > 24-w` |
/// | r0 r1 / r2 r3 | `dx < w` / `dx > 24-w` |
/// | r0 r2 / r1 r3 | `dy < w` / `dy > 24-w` |
/// | r0 r3 | `\|dx - dy\| < w` |
/// | r1 r2 | `\|dx + dy - 24\| < w` |
/// | r0 / r1 / r2 / r3 | `dx + dy` / `24 + dx - dy` / `24 - dx + dy` / `48 - dx - dy` `< w` |
///
/// Every comparison is strict. The acclient.c listing hides the diagonal
/// and lone-corner arithmetic behind x87 flag tests; the 2013 listing of
/// the same function (`acclient_2013.bndb_pseudo_c.txt`, `0x52fff0`) shows
/// it, and ACE's live `Physics/Common/Landblock.OnRoad` is the same table.
///
/// The floor and the band arithmetic run in f64, as retail's
/// `_floor(x / 24.0)` and x87 compares do. Retail's caller only asks for
/// points inside `[0, 192)`, and so does the bake's `Retail` path (its
/// bounds gate is strict, terrain-scenery-3); a point outside (e.g.
/// `lx == 192` from another caller) clamps onto the edge cell, which keeps
/// the corner reads inside the grid and measures the band from that cell's
/// far edge. Missing terrain words (a short synthetic `terrain`) read as
/// no road.
pub fn on_road_retail(lb: &CellLandblock, lx: f32, ly: f32, road_width: f32) -> bool {
    let tile = CELL_SIZE as f64;
    let ix = ((lx as f64 / tile).floor() as i32).clamp(0, 7);
    let iy = ((ly as f64 / tile).floor() as i32).clamp(0, 7);
    // acclient.c: `v8 = v5 + v6 + 8 * v5` = 9*ix + iy.
    let base = (ix as usize) * VERTEX_DIM + (iy as usize);
    let road = |idx: usize| lb.terrain.get(idx).is_some_and(|&t| (t & 0x3) != 0);
    let r0 = road(base); // (ix,   iy)
    let r1 = road(base + 1); // (ix,   iy+1)
    let r2 = road(base + VERTEX_DIM); // (ix+1, iy)
    let r3 = road(base + VERTEX_DIM + 1); // (ix+1, iy+1)
    if !(r0 || r1 || r2 || r3) {
        return false;
    }

    let dx = lx as f64 - ix as f64 * tile;
    let dy = ly as f64 - iy as f64 * tile;
    let r_min = road_width as f64;
    // acclient.c: `rmax = 24.0 - 5.0` (a float).
    let r_max = (CELL_SIZE - road_width) as f64;
    match (r0, r1, r2, r3) {
        (true, true, true, true) => true,
        (true, true, true, false) => dx < r_min || dy < r_min,
        (true, true, false, true) => dx < r_min || dy > r_max,
        (true, true, false, false) => dx < r_min,
        (true, false, true, true) => dx > r_max || dy < r_min,
        (true, false, true, false) => dy < r_min,
        (true, false, false, true) => (dx - dy).abs() < r_min,
        (true, false, false, false) => dx + dy < r_min,
        (false, true, true, true) => dx > r_max || dy > r_max,
        (false, true, true, false) => (dx + dy - tile).abs() < r_min,
        (false, true, false, true) => dy > r_max,
        (false, true, false, false) => tile + dx - dy < r_min,
        (false, false, true, true) => dx > r_max,
        (false, false, true, false) => tile - dx + dy < r_min,
        (false, false, false, true) => tile * 2.0 - dx - dy < r_min,
        (false, false, false, false) => false,
    }
}

#[cfg(test)]
mod on_road_retail_tests {
    //! terrain-scenery-2: retail `CLandBlock::on_road` on synthetic terrain.

    use super::*;

    fn lb_with_terrain(terrain: Vec<u16>) -> CellLandblock {
        CellLandblock {
            id: 0xA9B4_FFFF,
            has_objects: 0,
            terrain,
            height: vec![0u8; 81],
            _align: (),
        }
    }

    /// Terrain where every word has all its NON-road bits set (so only
    /// `& 3` can decide) and the corners of cell `(ix, iy)` named by
    /// `mask` carry road bits: bit 0 = r0 `(ix, iy)`, bit 1 = r1
    /// `(ix, iy+1)`, bit 2 = r2 `(ix+1, iy)`, bit 3 = r3 `(ix+1, iy+1)`.
    /// The road type varies per corner (1, 2, 3, 1): any non-zero type is
    /// a road.
    fn cell_with_road_corners(ix: usize, iy: usize, mask: u32) -> CellLandblock {
        let mut terrain = vec![0xFFFCu16; 81];
        let base = ix * VERTEX_DIM + iy;
        let corners = [
            (base, 0x1u16),
            (base + 1, 0x2),
            (base + VERTEX_DIM, 0x3),
            (base + VERTEX_DIM + 1, 0x1),
        ];
        for (bit, &(idx, road_type)) in corners.iter().enumerate() {
            if mask & (1 << bit) != 0 {
                terrain[idx] |= road_type;
            }
        }
        lb_with_terrain(terrain)
    }

    /// Cell-local `(dx, dy)` probe points. Bit `k` of an [`EXPECTED`] row is
    /// the answer at `PROBES[k]`.
    const PROBES: [(f32, f32); 23] = [
        (12.0, 12.0), // 0  centre
        (4.9, 12.0),  // 1  west band, in
        (5.1, 12.0),  // 2  west band, out
        (19.1, 12.0), // 3  east band, in
        (18.9, 12.0), // 4  east band, out
        (12.0, 4.9),  // 5  south band, in
        (12.0, 5.1),  // 6  south band, out
        (12.0, 19.1), // 7  north band, in
        (12.0, 18.9), // 8  north band, out
        (2.4, 2.4),   // 9  r0 corner, L1 4.8
        (2.6, 2.6),   // 10 r0 corner, L1 5.2
        (2.4, 21.6),  // 11 r1 corner, L1 4.8
        (2.6, 21.4),  // 12 r1 corner, L1 5.2
        (21.6, 2.4),  // 13 r2 corner, L1 4.8
        (21.4, 2.6),  // 14 r2 corner, L1 5.2
        (21.6, 21.6), // 15 r3 corner, L1 4.8
        (21.4, 21.4), // 16 r3 corner, L1 5.2
        (12.0, 7.1),  // 17 |dx - dy| = 4.9
        (12.0, 6.9),  // 18 |dx - dy| = 5.1
        (12.0, 16.9), // 19 |dx + dy - 24| = 4.9
        (12.0, 17.1), // 20 |dx + dy - 24| = 5.1
        (0.0, 0.0),   // 21 on the r0 vertex
        (23.5, 0.5),  // 22 next to the r2 vertex
    ];

    /// Expected on-road bits per corner mask (index = `mask`, bits as in
    /// [`cell_with_road_corners`]). Generated outside this crate by a
    /// Python transcription of the decomp (acclient.c:352238 branch
    /// structure, with the 2013 listing's arithmetic for the x87-hidden
    /// branches), which was asserted equal to ACE's live
    /// `Landblock.OnRoad` at every probe in every cell.
    const EXPECTED: [u32; 16] = [
        0b00000000000000000000000, // none
        0b01000000000001000000000, // r0
        0b00000000000100000000000, // r1
        0b01000000001111000000010, // r0 r1
        0b10000000010000000000000, // r2
        0b11000000110011000100000, // r0 r2
        0b10010100111100000000001, // r1 r2
        0b11000000111111000100010, // r0 r1 r2
        0b00000001000000000000000, // r3
        0b01010111000011000000001, // r0 r3
        0b00000011001100010000000, // r1 r3
        0b01000011001111010000010, // r0 r1 r3
        0b10000011110000000001000, // r2 r3
        0b11000011110011000101000, // r0 r2 r3
        0b10000011111100010001000, // r1 r2 r3
        0b11111111111111111111111, // all four
    ];

    /// All 16 corner masks, at every probe, in every one of the 64 cells
    /// (the 9-stride corner read must hold everywhere, not just in cell 0).
    #[test]
    fn every_corner_mask_matches_the_retail_table_in_every_cell() {
        for ix in 0..8usize {
            for iy in 0..8usize {
                for mask in 0..16u32 {
                    let lb = cell_with_road_corners(ix, iy, mask);
                    for (k, &(dx, dy)) in PROBES.iter().enumerate() {
                        let lx = ix as f32 * CELL_SIZE + dx;
                        let ly = iy as f32 * CELL_SIZE + dy;
                        let want = (EXPECTED[mask as usize] >> k) & 1 == 1;
                        let got = on_road_retail(&lb, lx, ly, RETAIL_ROAD_WIDTH);
                        assert_eq!(
                            got, want,
                            "cell ({ix},{iy}) mask {mask:04b} probe {k} ({dx}, {dy}) at ({lx}, {ly})"
                        );
                    }
                }
            }
        }
    }

    /// The four edge bands are 5 m wide (19 m on the far side), and the
    /// comparisons are strict: exactly 5 m / 19 m is off the road.
    #[test]
    fn edge_bands_are_5m_and_strict() {
        let (x0, y0) = (72.0f32, 48.0f32); // cell (3, 2)
        let w = RETAIL_ROAD_WIDTH;
        let west = cell_with_road_corners(3, 2, 0b0011);
        assert!(on_road_retail(&west, x0 + 4.9, y0 + 12.0, w));
        assert!(!on_road_retail(&west, x0 + 5.0, y0 + 12.0, w));
        assert!(!on_road_retail(&west, x0 + 5.1, y0 + 12.0, w));
        let east = cell_with_road_corners(3, 2, 0b1100);
        assert!(on_road_retail(&east, x0 + 19.1, y0 + 12.0, w));
        assert!(!on_road_retail(&east, x0 + 19.0, y0 + 12.0, w));
        assert!(!on_road_retail(&east, x0 + 18.9, y0 + 12.0, w));
        let south = cell_with_road_corners(3, 2, 0b0101);
        assert!(on_road_retail(&south, x0 + 12.0, y0 + 4.9, w));
        assert!(!on_road_retail(&south, x0 + 12.0, y0 + 5.0, w));
        let north = cell_with_road_corners(3, 2, 0b1010);
        assert!(on_road_retail(&north, x0 + 12.0, y0 + 19.1, w));
        assert!(!on_road_retail(&north, x0 + 12.0, y0 + 19.0, w));
    }

    /// Opposite corners only: a diagonal band. r0 + r3 runs SW-NE
    /// (`|dx - dy| < 5`); r1 + r2 runs NW-SE (`|dx + dy - 24| < 5`).
    #[test]
    fn diagonal_bands_for_opposite_corners() {
        let (x0, y0) = (72.0f32, 48.0f32); // cell (3, 2)
        let w = RETAIL_ROAD_WIDTH;
        let sw_ne = cell_with_road_corners(3, 2, 0b1001);
        assert!(on_road_retail(&sw_ne, x0 + 12.0, y0 + 7.1, w)); // 4.9
        assert!(!on_road_retail(&sw_ne, x0 + 12.0, y0 + 6.9, w)); // 5.1
        assert!(on_road_retail(&sw_ne, x0 + 20.0, y0 + 20.0, w)); // on the diagonal
        assert!(!on_road_retail(&sw_ne, x0 + 2.0, y0 + 22.0, w)); // far corner
        let nw_se = cell_with_road_corners(3, 2, 0b0110);
        assert!(on_road_retail(&nw_se, x0 + 12.0, y0 + 16.9, w)); // 4.9
        assert!(!on_road_retail(&nw_se, x0 + 12.0, y0 + 17.1, w)); // 5.1
        assert!(on_road_retail(&nw_se, x0 + 2.0, y0 + 22.0, w)); // on the diagonal
        assert!(!on_road_retail(&nw_se, x0 + 2.0, y0 + 2.0, w)); // far corner
    }

    /// Retail reads vertex `9*ix + iy`. A road bit only at idx `9*3+2 = 29`
    /// (vertex (3, 2), LB-local (72, 48)) puts (74, 50) on the road. ACE's
    /// dead-code [`on_road`] reads idx `3*8+2 = 26` there and misses it, and
    /// instead flags cell (3, 5) (`3*8+5 = 29`), which retail leaves clear.
    #[test]
    fn reads_the_nine_stride_vertex_not_aces_eight_stride() {
        let mut terrain = vec![0u16; 81];
        terrain[9 * 3 + 2] = 0x0001;
        let lb = lb_with_terrain(terrain);
        let w = RETAIL_ROAD_WIDTH;
        assert!(on_road_retail(&lb, 74.0, 50.0, w));
        assert!(!on_road(&lb, 74.0, 50.0));
        assert!(!on_road_retail(&lb, 80.0, 130.0, w));
        assert!(on_road(&lb, 80.0, 130.0));
        // The vertex is a corner of four cells; its L1 patch reaches into
        // each of them.
        assert!(on_road_retail(&lb, 70.0, 46.0, w)); // cell (2,1), r3: 48-22-22 = 4
        assert!(on_road_retail(&lb, 70.0, 50.0, w)); // cell (2,2), r2: 24-22+2 = 4
        assert!(on_road_retail(&lb, 74.0, 46.0, w)); // cell (3,1), r1: 24+2-22 = 4
        // Outside the 5 m patch.
        assert!(!on_road_retail(&lb, 80.0, 50.0, w)); // L1 = 10
    }

    /// The band width is the parameter: a 3 m road leaves 4 m off it.
    #[test]
    fn band_width_follows_road_width() {
        let west = cell_with_road_corners(3, 2, 0b0011);
        assert!(on_road_retail(&west, 76.0, 60.0, 5.0));
        assert!(!on_road_retail(&west, 76.0, 60.0, 3.0));
        let east = cell_with_road_corners(3, 2, 0b1100);
        assert!(on_road_retail(&east, 92.0, 60.0, 5.0)); // dx 20 > 19
        assert!(!on_road_retail(&east, 92.0, 60.0, 3.0)); // dx 20 < 21
    }

    /// A point on the LB's far edge (x or y == 192) clamps onto cell 7 and
    /// stays inside the 81-word grid. The bake never sends such a point
    /// here. `on_road_retail`'s only bake caller is `BakeMode::Retail`, and
    /// its bounds gate is strict (`lx < LANDBLOCK_SIZE`, as retail's
    /// `< 192` at `acclient.c:352677-352678`), so 192 is rejected before the
    /// road test. Only `AceCompat` / `Strict` accept 192 (ACE's `> 192`
    /// gate), and they use `on_road`, not this function. The clamp guards
    /// other callers.
    #[test]
    fn landblock_far_edge_clamps_onto_cell_seven() {
        let mut terrain = vec![0u16; 81];
        // A road along x = 192: vertices (8, 3) and (8, 4).
        terrain[9 * 8 + 3] = 0x0002;
        terrain[9 * 8 + 4] = 0x0002;
        let lb = lb_with_terrain(terrain);
        let w = RETAIL_ROAD_WIDTH;
        assert!(on_road_retail(&lb, 192.0, 84.0, w));
        assert!(on_road_retail(&lb, 187.5, 84.0, w)); // dx 19.5
        assert!(!on_road_retail(&lb, 186.5, 84.0, w)); // dx 18.5
        assert!(!on_road_retail(&lb, 192.0, 150.0, w));
        // Both axes at 192 read vertex (8, 8), the last word (idx 80).
        let mut corner = vec![0u16; 81];
        corner[80] = 0x0003;
        assert!(on_road_retail(&lb_with_terrain(corner), 192.0, 192.0, w));
        // A short synthetic terrain array reads as no road, never panics.
        let short = lb_with_terrain(vec![0x0001u16; 10]);
        assert!(!on_road_retail(&short, 180.0, 180.0, w));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn synth_region(table: Vec<f32>) -> Region {
        Region {
            id: 0x1300_0000,
            region_number: 1,
            version: 0,
            region_name: "Synthetic".to_string(),
            parts_mask: 0,
            land_defs: holtburger_dat::file_type::region::LandDefs {
                num_block_length: 1,
                num_block_width: 1,
                square_length: 24.0,
                l_block_length: 8,
                vertex_per_cell: 9,
                max_obj_height: 200.0,
                sky_height: 1000.0,
                road_width: 5.0,
                land_height_table: table,
            },
            game_time: holtburger_dat::file_type::GameTime {
                zero_time_of_year: 0.0,
                zero_year: 0,
                day_length: 1.0,
                days_per_year: 1,
                year_spec: String::new(),
                times_of_day: vec![],
                days_of_week: vec![],
                seasons: vec![],
            },
            sky_info: None,
            sound_info: None,
            scene_info: None,
            terrain_info: holtburger_dat::file_type::region::TerrainDesc {
                terrain_types: vec![],
                land_surfaces: holtburger_dat::file_type::region::LandSurf {
                    surf_type: 0,
                    tex_merge: holtburger_dat::file_type::region::TexMerge {
                        base_tex_size: 0,
                        corner_terrain_maps: vec![],
                        side_terrain_maps: vec![],
                        road_maps: vec![],
                        terrain_desc: vec![],
                    },
                },
            },
            region_misc: None,
        }
    }

    fn synth_lb(heights: Vec<u8>, terrain: Vec<u16>) -> CellLandblock {
        CellLandblock {
            id: 0xA9B4_FFFF,
            has_objects: 0,
            terrain,
            height: heights,
            _align: (),
        }
    }

    /// At each vertex (cell corner), bilinear and the raw height should
    /// agree exactly.
    #[test]
    fn bilinear_at_vertex_equals_raw_height() {
        // Build a 256-entry height table where index i → i * 2.0.
        let table: Vec<f32> = (0..256).map(|i| i as f32 * 2.0).collect();
        // Heights: ramp from 0 to 80 in steps of 1 along the 81 vertices.
        let heights: Vec<u8> = (0..81u8).collect();
        let lb = synth_lb(heights, vec![0u16; 81]);
        let region = synth_region(table);

        let grid = vertex_heights(&region, &lb);
        // Vertex (vx=3, vy=4) is index 3*9+4 = 31. height byte = 31. Z = 62.
        let lx = 3.0 * CELL_SIZE;
        let ly = 4.0 * CELL_SIZE;
        let z = bilinear_height_from_grid(&grid, lx, ly);
        assert!(
            (z - 62.0).abs() < 1e-5,
            "expected Z=62 at vertex (3,4); got {}",
            z
        );
        assert!((grid[3 * 9 + 4] - 62.0).abs() < 1e-5);
    }

    /// At the midpoint of a cell, bilinear should be the average of
    /// the 4 corner heights.
    #[test]
    fn bilinear_midpoint_is_corner_average() {
        let table: Vec<f32> = (0..256).map(|i| i as f32).collect();
        // Pick a 9×9 grid where vertex (0,0)=10, (1,0)=20, (0,1)=30, (1,1)=40.
        let mut heights = vec![0u8; 81];
        heights[0 * 9 + 0] = 10;
        heights[1 * 9 + 0] = 20;
        heights[0 * 9 + 1] = 30;
        heights[1 * 9 + 1] = 40;
        let lb = synth_lb(heights, vec![0u16; 81]);
        let region = synth_region(table);
        let grid = vertex_heights(&region, &lb);

        let z = bilinear_height_from_grid(&grid, CELL_SIZE * 0.5, CELL_SIZE * 0.5);
        // Average of 10, 20, 30, 40 = 25.
        assert!((z - 25.0).abs() < 1e-5, "expected 25, got {}", z);
    }

    /// Out-of-range inputs clamp to the LB edge.
    #[test]
    fn bilinear_clamps_oob_inputs() {
        let table: Vec<f32> = (0..256).map(|i| i as f32).collect();
        let mut heights = vec![0u8; 81];
        // Set vertex (8, 8) = 100. All others stay 0.
        heights[8 * 9 + 8] = 100;
        let lb = synth_lb(heights, vec![0u16; 81]);
        let region = synth_region(table);
        let grid = vertex_heights(&region, &lb);

        // Way outside the LB — should clamp to vertex (8,8) corner.
        let z = bilinear_height_from_grid(&grid, 5000.0, 5000.0);
        assert!(
            (z - 100.0).abs() < 1e-5,
            "OOB should clamp to vertex (8,8)=100; got {}",
            z
        );
    }

    /// Slope on a flat heightmap is 0.
    #[test]
    fn slope_flat_terrain_is_zero() {
        let table: Vec<f32> = vec![5.0; 256];
        let lb = synth_lb(vec![0u8; 81], vec![0u16; 81]);
        let region = synth_region(table);
        let grid = vertex_heights(&region, &lb);
        let s = slope_at(&grid, 50.0, 50.0);
        assert!(s.abs() < 1e-5, "flat slope should be ~0, got {}", s);
    }

    /// W1 (2026-05-29) — `normal_z_at` returns the slope COSINE (the
    /// value retail `ObjectDesc::CheckSlope` tests): 1.0 on flat ground,
    /// and `cos(π/4) ≈ 0.7071` on a 45° ramp. This is the inverse-axis
    /// of `slope_at` (which returns the angle) and is what the
    /// slope-rejection comparison must use.
    #[test]
    fn normal_z_flat_is_one_and_ramp_is_cos45() {
        // Flat terrain → N.z == 1.0.
        let flat_table: Vec<f32> = vec![5.0; 256];
        let flat_lb = synth_lb(vec![0u8; 81], vec![0u16; 81]);
        let flat_region = synth_region(flat_table);
        let flat_grid = vertex_heights(&flat_region, &flat_lb);
        let nz_flat = normal_z_at(&flat_grid, 50.0, 50.0);
        assert!(
            (nz_flat - 1.0).abs() < 1e-5,
            "flat N.z should be ~1.0, got {nz_flat}"
        );

        // 45° ramp along X → N.z == cos(π/4) ≈ 0.7071.
        let table: Vec<f32> = (0..256).map(|i| i as f32).collect();
        let mut heights = vec![0u8; 81];
        for vx in 0..9 {
            for vy in 0..9 {
                heights[vx * 9 + vy] = (vx * CELL_SIZE as usize) as u8;
            }
        }
        let lb = synth_lb(heights, vec![0u16; 81]);
        let region = synth_region(table);
        let grid = vertex_heights(&region, &lb);
        let nz = normal_z_at(&grid, 50.0, 50.0);
        let cos45 = std::f32::consts::FRAC_PI_4.cos();
        assert!(
            (nz - cos45).abs() < 1e-4,
            "expected cos(π/4)={cos45}, got {nz}"
        );
        // Consistency: N.z must equal cos(slope_at) for the same point.
        let ang = slope_at(&grid, 50.0, 50.0);
        assert!(
            (nz - ang.cos()).abs() < 1e-5,
            "N.z ({nz}) must equal cos(slope_at) ({})",
            ang.cos()
        );
    }

    /// Slope on a 45° linear ramp along X is ~45° = π/4.
    #[test]
    fn slope_linear_ramp_45deg() {
        // Build heights that ramp linearly along X at 1 unit Z per 1 unit X.
        // So Z = vx * 24 (since CELL_SIZE=24). Height table indexes need
        // to be integers fitting into u8 (max 255). Cap at vx=8 → 192.
        let table: Vec<f32> = (0..256).map(|i| i as f32).collect();
        let mut heights = vec![0u8; 81];
        for vx in 0..9 {
            for vy in 0..9 {
                heights[vx * 9 + vy] = (vx * CELL_SIZE as usize) as u8;
            }
        }
        let lb = synth_lb(heights, vec![0u16; 81]);
        let region = synth_region(table);
        let grid = vertex_heights(&region, &lb);
        let s = slope_at(&grid, 50.0, 50.0);
        // 45° rise: atan(24 / 24) = π/4.
        assert!(
            (s - std::f32::consts::FRAC_PI_4).abs() < 1e-4,
            "expected π/4, got {}",
            s
        );
    }

    /// At a cell corner, triangle-plane Z equals the raw vertex height
    /// regardless of split direction.
    #[test]
    fn triangle_plane_z_at_vertex_equals_raw_height() {
        let table: Vec<f32> = (0..256).map(|i| i as f32 * 2.0).collect();
        let heights: Vec<u8> = (0..81u8).collect();
        let lb = synth_lb(heights, vec![0u16; 81]);
        let region = synth_region(table);
        let grid = vertex_heights(&region, &lb);
        // Vertex (3, 4) — exact corner.
        let z = triangle_plane_height_from_grid(&grid, 0xA9B4, 3.0 * CELL_SIZE, 4.0 * CELL_SIZE);
        assert!((z - 62.0).abs() < 1e-4, "expected 62, got {}", z);
    }

    /// On a planar tilt (Z = vx*CELL_SIZE), triangle-plane Z at any
    /// interior point matches the bilinear sample. This is the
    /// "agreement on planar surfaces" property — triangulation only
    /// matters when corners disagree.
    #[test]
    fn triangle_plane_z_matches_bilinear_on_planar_ramp() {
        let table: Vec<f32> = (0..256).map(|i| i as f32).collect();
        let mut heights = vec![0u8; 81];
        for vx in 0..9 {
            for vy in 0..9 {
                heights[vx * 9 + vy] = (vx * CELL_SIZE as usize) as u8;
            }
        }
        let lb = synth_lb(heights, vec![0u16; 81]);
        let region = synth_region(table);
        let grid = vertex_heights(&region, &lb);
        for &(lx, ly) in &[
            (12.0, 12.0),
            (40.0, 80.0),
            (96.0, 96.0),
            (50.0, 100.0),
            (180.0, 30.0),
        ] {
            let zb = bilinear_height_from_grid(&grid, lx, ly);
            let zt = triangle_plane_height_from_grid(&grid, 0xA9B4, lx, ly);
            assert!(
                (zb - zt).abs() < 1e-3,
                "planar ramp at ({lx}, {ly}): bilinear={zb} triangle={zt}"
            );
        }
    }

    /// `get_split_dir` is deterministic and produces both true/false
    /// over the 64 cells of a single LB (sanity that the magic constants
    /// aren't all-zero or all-one).
    #[test]
    fn get_split_dir_mixed_output() {
        let mut t = 0usize;
        let mut f = 0usize;
        for x in 0..8i32 {
            for y in 0..8i32 {
                if get_split_dir(0xA9B4, x, y) { t += 1; } else { f += 1; }
            }
        }
        assert!(t > 0 && f > 0, "split_dir produced {t} true / {f} false — expected mix");
        assert_eq!(t + f, 64);
    }

    /// `get_split_dir` is bit-exact between successive calls (no
    /// hidden state).
    #[test]
    fn get_split_dir_deterministic_across_calls() {
        for x in -2..10i32 {
            for y in -2..10i32 {
                let a = get_split_dir(0xA9B4, x, y);
                let b = get_split_dir(0xA9B4, x, y);
                assert_eq!(a, b);
            }
        }
    }

    /// At a known cell midpoint with non-planar corners, triangle-plane
    /// returns a value within the corner-height range and is consistent
    /// across two calls. We pick a 9×9 grid where corners disagree to
    /// force the triangulation to actually matter.
    #[test]
    fn triangle_plane_z_midpoint_is_consistent_and_bounded() {
        let table: Vec<f32> = (0..256).map(|i| i as f32).collect();
        let mut heights = vec![0u8; 81];
        heights[0 * 9 + 0] = 10;
        heights[1 * 9 + 0] = 20;
        heights[0 * 9 + 1] = 30;
        heights[1 * 9 + 1] = 40;
        let lb = synth_lb(heights, vec![0u16; 81]);
        let region = synth_region(table);
        let grid = vertex_heights(&region, &lb);
        let z = triangle_plane_height_from_grid(&grid, 0xA9B4, CELL_SIZE * 0.5, CELL_SIZE * 0.5);
        assert!(z >= 10.0 - 1e-3 && z <= 40.0 + 1e-3, "z={z} out of [10, 40]");
        // Same again — determinism.
        let z2 = triangle_plane_height_from_grid(&grid, 0xA9B4, CELL_SIZE * 0.5, CELL_SIZE * 0.5);
        assert_eq!(z.to_bits(), z2.to_bits());
    }

    /// on_road returns true iff terrain[idx] & 0x3 != 0.
    #[test]
    fn on_road_basic() {
        // Build a terrain grid where cell (3, 4) has road bit set.
        let mut terrain = vec![0u16; 81];
        // ACE's index = cellX * 8 + cellY (note: NOT *9 — see module
        // docstring re: the off-by-one ACE quirk).
        terrain[3 * 8 + 4] = 0x0001;
        let lb = synth_lb(vec![0u8; 81], terrain);

        // Position inside cell (3, 4) → lx in [72, 96), ly in [96, 120).
        assert!(on_road(&lb, 80.0, 100.0));
        // Position in a different cell — no road.
        assert!(!on_road(&lb, 0.0, 0.0));
    }
}

#[cfg(test)]
mod triangle_plane_from_grid_tests {
    //! terrain-scenery-3: the walkable-triangle normal behind
    //! `BakeMode::Retail`'s slope gate.

    use super::*;

    /// Deterministic, non-planar 9×9 grid (a 32-bit LCG, heights 0..200).
    fn rough_grid(seed: u32) -> [f32; 81] {
        let mut s = seed;
        let mut g = [0.0f32; 81];
        for h in g.iter_mut() {
            s = s.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            *h = (s >> 24) as f32 * (200.0 / 255.0);
        }
        g
    }

    /// Planar ramp along X: `z = vx * 24 * gx` at every vertex.
    fn ramp_grid(gx: f32) -> [f32; 81] {
        let mut g = [0.0f32; 81];
        for vx in 0..VERTEX_DIM {
            for vy in 0..VERTEX_DIM {
                g[vx * VERTEX_DIM + vy] = vx as f32 * CELL_SIZE * gx;
            }
        }
        g
    }

    /// Every cell a saddle: vertex height `h` where `vx + vy` is odd, else 0.
    fn saddle_grid(h: f32) -> [f32; 81] {
        let mut g = [0.0f32; 81];
        for vx in 0..VERTEX_DIM {
            for vy in 0..VERTEX_DIM {
                if (vx + vy) % 2 == 1 {
                    g[vx * VERTEX_DIM + vy] = h;
                }
            }
        }
        g
    }

    fn sample_points() -> Vec<(f32, f32)> {
        let mut pts = Vec::new();
        let mut x = -5.0f32;
        while x <= 197.0 {
            let mut y = -5.0f32;
            while y <= 197.0 {
                pts.push((x, y));
                y += 3.7;
            }
            x += 2.9;
        }
        // Vertices and cell edges, where the triangle choice is decided.
        for v in 0..=8 {
            let c = v as f32 * CELL_SIZE;
            pts.push((c, c));
            pts.push((c, 12.0));
            pts.push((12.0, c));
        }
        pts
    }

    /// `z` is `triangle_plane_height_from_grid`, bit for bit, everywhere
    /// (in, on the edges of, and clamped outside the landblock).
    #[test]
    fn z_is_bit_identical_to_triangle_plane_height() {
        for (seed, top16) in [(1u32, 0xA9B4u16), (7, 0x0000), (99, 0x7F7F), (12345, 0xFEFE)] {
            let grid = rough_grid(seed);
            for (lx, ly) in sample_points() {
                let want = triangle_plane_height_from_grid(&grid, top16, lx, ly);
                let got = triangle_plane_from_grid(&grid, top16, lx, ly);
                assert_eq!(
                    got.z.to_bits(),
                    want.to_bits(),
                    "seed {seed} lb {top16:#06x} at ({lx}, {ly}): {} vs {want}",
                    got.z
                );
            }
        }
    }

    /// The normal is a unit vector pointing up, on rough terrain too.
    #[test]
    fn normal_is_unit_and_upward() {
        let grid = rough_grid(42);
        for (lx, ly) in sample_points() {
            let n = triangle_plane_from_grid(&grid, 0xA9B4, lx, ly).normal;
            let len = (n.0 * n.0 + n.1 * n.1 + n.2 * n.2).sqrt();
            assert!((len - 1.0).abs() < 1e-5, "|N| = {len} at ({lx}, {ly})");
            assert!(n.2 > 0.0, "N.z = {} must point up at ({lx}, {ly})", n.2);
        }
        // A descending ramp still reports an upward normal.
        let down = ramp_grid(-0.5);
        let n = triangle_plane_from_grid(&down, 0xA9B4, 50.0, 50.0).normal;
        assert!(n.2 > 0.0 && n.0 > 0.0, "descending ramp normal {n:?}");
    }

    /// On a planar ramp every triangle is the plane: `N.z = 1/sqrt(1+g^2)`
    /// and `N.x = -g/sqrt(1+g^2)`.
    #[test]
    fn planar_ramp_normal_matches_the_analytic_plane() {
        for g in [0.0f32, 0.25, 0.484_322, 1.0] {
            let grid = ramp_grid(g);
            let inv = 1.0 / (1.0 + (g as f64) * (g as f64)).sqrt();
            for (lx, ly) in sample_points() {
                let p = triangle_plane_from_grid(&grid, 0xA9B4, lx, ly);
                assert!(
                    (p.normal_z() as f64 - inv).abs() < 1e-6,
                    "g {g} at ({lx}, {ly}): N.z {} vs {inv}",
                    p.normal_z()
                );
                assert!((p.normal.0 as f64 + g as f64 * inv).abs() < 1e-6);
                assert!(p.normal.1.abs() < 1e-6);
            }
        }
    }

    /// On a saddle cell the 4-corner fit ([`normal_z_at`]) is flat but both
    /// cell triangles slope by `sqrt(2) * h / 24`, whichever diagonal the
    /// cell uses: retail's `walkable->plane.N.z` is the triangle's.
    #[test]
    fn saddle_cell_triangles_slope_where_the_four_corner_fit_is_flat() {
        let h = 12.0f32;
        let grid = saddle_grid(h);
        let g = h as f64 / CELL_SIZE as f64;
        let want = 1.0 / (1.0 + 2.0 * g * g).sqrt();
        for cx in 0..8 {
            for cy in 0..8 {
                let x0 = cx as f32 * CELL_SIZE;
                let y0 = cy as f32 * CELL_SIZE;
                // One point on each side of either diagonal.
                for (dx, dy) in [(6.0f32, 2.0f32), (2.0, 6.0), (18.0, 22.0), (22.0, 18.0)] {
                    let (lx, ly) = (x0 + dx, y0 + dy);
                    let tri = triangle_plane_from_grid(&grid, 0xA9B4, lx, ly).normal_z();
                    let quad = normal_z_at(&grid, lx, ly);
                    assert!(
                        (tri as f64 - want).abs() < 1e-6,
                        "cell ({cx},{cy}) at ({lx}, {ly}): triangle N.z {tri} vs {want}"
                    );
                    assert!((quad - 1.0).abs() < 1e-6, "4-corner N.z {quad} should be flat");
                }
            }
        }
    }
}
