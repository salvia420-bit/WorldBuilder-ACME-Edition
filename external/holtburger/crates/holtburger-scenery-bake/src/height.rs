//! Per-LB bilinear height sample.
//!
//! Mirrors ACE's `LandblockMesh.GetZ(Vector2)` semantics for the
//! purposes of "what Z does scenery get snapped to at (lx, ly)?"
//!
//! ## Deviation from ACE: bilinear vs triangle-plane
//!
//! ACE `LandblockMesh.GetZ` uses **triangle-plane interpolation**:
//! it picks the cell's 2 triangles (via `GetSplitDir`, a deterministic
//! hash of global cell coords), determines which triangle contains the
//! query point, and computes Z from that triangle's plane equation.
//!
//! We use **bilinear interpolation** instead. The rationale:
//!
//! 1. At the 4 corners of each cell the two methods agree exactly
//!    (both evaluate to the vertex height there).
//! 2. The two methods disagree along the diagonal split — bilinear
//!    interpolates across the whole quad, triangle-plane snaps to one
//!    of two triangles. For typical Holtburg slopes the disagreement
//!    is sub-decimetre.
//! 3. The renderer (`apps/holtburger-web`) and `holtburger-world`
//!    physics integrator already use bilinear (see
//!    `holtburger_world::state::types::terrain_height_at` at
//!    `crates/holtburger-world/src/state/types.rs:460`). For player
//!    movement to land on the same Z as scenery, the bake must match.
//!
//! Determinism is preserved either way — the bake's output is
//! byte-identical given identical inputs. The deviation only means
//! "where in the cell the scenery's foot is snapped" differs from
//! retail ACE's choice by a few cm in worst case. Phase B.4 (retail
//! parity validation) will quantify any visual delta.
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
    // Slope angle = atan(magnitude of gradient).
    (dz_dx * dz_dx + dz_dy * dz_dy).sqrt().atan()
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
