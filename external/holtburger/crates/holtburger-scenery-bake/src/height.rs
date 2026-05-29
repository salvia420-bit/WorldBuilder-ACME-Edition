//! Per-LB height sample. Two implementations, selected at bake time
//! via [`crate::BakeMode`]:
//!
//! - **Bilinear** ([`bilinear_height_from_grid`]) — renderer-friendly,
//!   matches `holtburger_world::state::types::terrain_height_at`. Used
//!   by [`crate::BakeMode::Strict`].
//! - **Triangle-plane** ([`triangle_plane_height_from_grid`]) — verbatim
//!   port of ACE's `LandblockMesh.GetZ`. Each 8×8 cell is split into
//!   two triangles by a diagonal whose direction comes from
//!   [`get_split_dir`] (a deterministic hash of the global cell coord).
//!   Z at `(lx, ly)` is the plane equation of whichever triangle
//!   contains the query point. Used by [`crate::BakeMode::AceCompat`].
//!
//! ## Why the two modes
//!
//! At the 4 corners of each cell, both methods evaluate to the vertex
//! height — they agree exactly there. Along the diagonal split they
//! disagree: bilinear interpolates across the whole quad, triangle-plane
//! snaps to whichever of the two triangles contains the point. For
//! typical Holtburg slopes the disagreement is sub-decimetre, but for
//! 1:1 Coldeve parity we must match ACE bit-exactly. The renderer
//! (`apps/holtburger-web`) and `holtburger-world` physics integrator
//! use bilinear (see `holtburger_world::state::types::terrain_height_at`
//! at `crates/holtburger-world/src/state/types.rs:460`), so Strict mode
//! makes scenery snap to the same Z the player walks on, while
//! AceCompat snaps to whatever Z ACE itself would emit today.
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
use holtburger_dat::landblock::CellLandblock;

/// A landblock has 9 vertices per side (`CellDim + 1`).
pub const VERTEX_DIM: usize = 9;
/// A landblock cell spans `LANDBLOCK_SIZE / CellDim = 24` units.
pub const CELL_SIZE: f32 = 24.0;
/// A landblock is `192 × 192` units.
pub const LANDBLOCK_SIZE: f32 = 192.0;

/// Read the 9×9 vertex heights for the landblock, mapping each height
/// byte through `region.land_defs.land_height_table`. Returns a
/// row-major `[f32; 81]` indexed `vx * 9 + vy`.
pub fn vertex_heights(region: &Region, lb: &CellLandblock) -> [f32; 81] {
    let table = &region.land_defs.land_height_table;
    let mut out = [0.0f32; 81];
    for (i, &h) in lb.height.iter().enumerate() {
        // Defensive: clamp to table length to avoid panics on
        // hand-built test fixtures. Real heights are u8 so they fit.
        let idx = (h as usize).min(table.len().saturating_sub(1));
        out[i] = table[idx];
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
        triangle_plane_z(t0.0, t0.1, t0.2, lx, ly)
    } else {
        triangle_plane_z(t1.0, t1.1, t1.2, lx, ly)
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
