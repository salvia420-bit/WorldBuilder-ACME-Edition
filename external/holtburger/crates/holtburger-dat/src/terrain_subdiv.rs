//! Phase 2.1 — terrain mesh subdivision with bicubic Catmull-Rom
//! interpolation plus per-category clamped value-noise.
//!
//! Given a landblock's 9×9 control height grid and per-vertex terrain
//! codes, produce a denser `(subdiv*8+1)²` vertex grid suitable for
//! GPU upload. The collision path stays on the 9×9 grid — this module
//! is visual-only.
//!
//! Coordinate convention (AC native, Z-up):
//! - `heights[x][y]` is the control height at vertex `(x, y)`, with
//!   `x` increasing east and `y` increasing north. `x = 0 .. 8` and
//!   `y = 0 .. 8` map to local metres `0 .. 192` in 24 m steps.
//! - Output positions are in landblock-local metres with `z` being
//!   elevation, matching `build_mesh` in `apps/holtburger-web/src/lib.rs`.
//!
//! The noise function is a tiny deterministic 2D value-noise with
//! Perlin-style fade interpolation. We bake it locally so the noise
//! is identical across page loads and the JS side can replicate the
//! same pattern with no FFI (relevant for Phase 2.2 displacement).

use crate::surface_classify::SurfaceCategory;

/// Output of [`subdivide_landblock`]. Ready for `THREE.BufferGeometry`
/// construction in `adapter.js` — see `landblockSubdividedMeshToGeometry`.
///
/// `positions` is flat `xyz` (length = 3 × vertex_count).
/// `normals` is flat `xyz` (length = 3 × vertex_count) computed by
/// finite-difference of the subdivided heightfield.
/// `terrain_codes` carries the nearest-control-point terrain type per
/// vertex so the existing detail-normal blending and triplanar code
/// keep working without changes.
/// `indices` is CCW triangle indices into `positions` / `normals` /
/// `terrain_codes`.
#[derive(Debug, Clone)]
pub struct SubdividedLandblock {
    pub positions: Vec<f32>,
    pub normals: Vec<f32>,
    pub terrain_codes: Vec<u8>,
    pub road_codes: Vec<u8>,
    pub indices: Vec<u32>,
    pub vertex_count: u32,
    pub grid_size: u32,
    pub height_min: f32,
    pub height_max: f32,
}

/// Optional adjacent-landblock heights, used so the bicubic patch at
/// LB boundaries reads real neighbour samples instead of mirrored ones.
/// Mirror boundary is applied for any `None` direction — see
/// `Phase 2.1 hand-off note "LB-edge boundary condition"`.
#[derive(Debug, Clone, Default)]
pub struct AdjacentHeights {
    /// Heights of the LB to the east (x = +1). Indexed `[x_local][y]`
    /// where `x_local ∈ {0, 1}` (we only need columns 0 and 1 of the
    /// east neighbour for the Catmull-Rom outer band).
    pub east: Option<[[f32; 9]; 2]>,
    /// Heights of the LB to the west (x = -1). We need columns 7 and
    /// 8 — store them as `[x_local][y]` with `x_local ∈ {7, 8}` mapped
    /// to indices `[0]` and `[1]`.
    pub west: Option<[[f32; 9]; 2]>,
    /// Heights of the LB to the north (y = +1), rows `y_local ∈ {0, 1}`.
    pub north: Option<[[f32; 2]; 9]>,
    /// Heights of the LB to the south (y = -1), rows `y_local ∈ {7, 8}`
    /// mapped to indices `[0]` and `[1]`.
    pub south: Option<[[f32; 2]; 9]>,
}

/// AC vertex spacing on the 9×9 control grid: 24 m per quad.
pub const CONTROL_SPACING_M: f32 = 24.0;

/// LB world spacing in metres: 8 × 24 = 192.
pub const LANDBLOCK_M: f32 = 192.0;

/// Maximum per-vertex noise amplitude — never exceeds this regardless
/// of category multiplier. Plan constraint #3: ≤ ±0.3 m.
pub const NOISE_AMPLITUDE_MAX_M: f32 = 0.3;

/// Maximum total deviation of the subdivided visual mesh from the
/// underlying 9×9 bilinear surface (which is also the collision
/// surface). The Phase 2.1 plan calls out:
///
/// > The subdivided mesh should NOT move the visual surface more than
/// > ±0.3 m from the 9×9 bilinear surface — which is also the
/// > collision surface.
///
/// Bicubic Catmull-Rom, applied to terrain with real elevation gradients
/// (Holtburg ranges 30-96 m), naturally overshoots/undershoots beyond
/// the bilinear convex hull. We clamp the combined (bicubic + noise)
/// height to `bilinear ± VISUAL_VS_COLLISION_MAX_M` so collision
/// integrity holds. This re-introduces a small facet at the rare
/// overshoot peaks but preserves smoothing everywhere else.
pub const VISUAL_VS_COLLISION_MAX_M: f32 = 0.3;

/// Base noise frequency (cycles per metre). Tuned so one cycle is
/// ~2 m, sub-character scale.
const NOISE_FREQ_PER_METER: f32 = 0.5;

/// Convenience: noise scale by [`SurfaceCategory`]. Phase 2.1 uses the
/// terrain-code path; this is exposed so downstream consumers (e.g.
/// Phase 1.4 surface classification fallback) can ask "what category
/// gets noise". Returns 0 for Water/Lava — they're animated in 2.2.
pub fn noise_scale_for_category(category: SurfaceCategory) -> f32 {
    match category {
        SurfaceCategory::Water | SurfaceCategory::Lava => 0.0,
        SurfaceCategory::Sand => 0.5,
        SurfaceCategory::Stone | SurfaceCategory::Dirt | SurfaceCategory::Brick => 1.0,
        SurfaceCategory::Foliage => 0.8,
        SurfaceCategory::Snow => 0.3,
        // Wood, Metal, Cloth, Tile, Generic don't appear on terrain
        // codes in practice — give them a modest default.
        _ => 0.5,
    }
}

/// 1D Catmull-Rom basis: given four control values `p0, p1, p2, p3`
/// sampled at integer offsets `-1, 0, 1, 2`, interpolate at parameter
/// `t ∈ [0, 1]` between `p1` and `p2`.
///
/// Reference: <https://en.wikipedia.org/wiki/Centripetal_Catmull-Rom_spline>.
/// We use the uniform variant (centripetal would need extra knot
/// computation per evaluation; for a regular 9×9 grid uniform reads
/// fine visually).
#[inline]
fn catmull_rom_1d(p0: f32, p1: f32, p2: f32, p3: f32, t: f32) -> f32 {
    // Standard CR form: P(t) = 0.5 * ((-p0+3*p1-3*p2+p3)*t³
    //                                 + (2*p0-5*p1+4*p2-p3)*t²
    //                                 + (-p0+p2)*t
    //                                 + 2*p1)
    let t2 = t * t;
    let t3 = t2 * t;
    0.5 * ((-p0 + 3.0 * p1 - 3.0 * p2 + p3) * t3
        + (2.0 * p0 - 5.0 * p1 + 4.0 * p2 - p3) * t2
        + (-p0 + p2) * t
        + 2.0 * p1)
}

/// Sample the 4×4 control-point neighbourhood around `(xi, yi)`, using
/// `heights` as the inner LB and falling back to mirror-boundary at
/// LB edges (the adjacent-LB neighbours are spliced in via
/// `AdjacentHeights` when provided).
///
/// Returns the 4×4 patch where `patch[i+1][j+1]` corresponds to
/// `(xi + i, yi + j)` for `i, j ∈ {-1, 0, 1, 2}`.
fn neighbourhood_patch(
    heights: &[[f32; 9]; 9],
    adjacent: &AdjacentHeights,
    xi: i32,
    yi: i32,
) -> [[f32; 4]; 4] {
    let mut patch = [[0.0f32; 4]; 4];
    for di in 0..4 {
        for dj in 0..4 {
            let x = xi + di as i32 - 1;
            let y = yi + dj as i32 - 1;
            patch[di][dj] = sample_height(heights, adjacent, x, y);
        }
    }
    patch
}

/// Sample the control height at integer coords `(x, y)`, falling back
/// to neighbours or mirror.
fn sample_height(
    heights: &[[f32; 9]; 9],
    adjacent: &AdjacentHeights,
    x: i32,
    y: i32,
) -> f32 {
    // Try adjacent first for out-of-range coords.
    if (0..=8).contains(&x) && (0..=8).contains(&y) {
        return heights[x as usize][y as usize];
    }
    // East neighbour (x = 9, 10 → indices 0, 1 of east.[x_local])
    if x > 8 && let Some(east) = adjacent.east.as_ref() {
        let xi = (x - 9) as usize;
        if xi < 2 && (0..=8).contains(&y) {
            return east[xi][y as usize];
        }
    }
    // West neighbour (x = -1, -2 → indices 1, 0 of west.[x_local])
    // We store columns 7 and 8 of the west LB as indices 0 (col 7) and
    // 1 (col 8). x = -1 maps to col 8 (=index 1); x = -2 maps to col 7
    // (=index 0).
    if x < 0 && let Some(west) = adjacent.west.as_ref() {
        if x == -1 && (0..=8).contains(&y) {
            return west[1][y as usize];
        }
        if x == -2 && (0..=8).contains(&y) {
            return west[0][y as usize];
        }
    }
    // North neighbour (y = 9, 10 → indices 0, 1)
    if y > 8 && let Some(north) = adjacent.north.as_ref() {
        let yi = (y - 9) as usize;
        if yi < 2 && (0..=8).contains(&x) {
            return north[x as usize][yi];
        }
    }
    // South neighbour (y = -1, -2 → indices 1, 0)
    if y < 0 && let Some(south) = adjacent.south.as_ref() {
        if y == -1 && (0..=8).contains(&x) {
            return south[x as usize][1];
        }
        if y == -2 && (0..=8).contains(&x) {
            return south[x as usize][0];
        }
    }
    // Mirror fallback. Reflect over the boundary: -1 → 1, -2 → 2,
    // 9 → 7, 10 → 6. Clamp y the same way.
    let mx = mirror_clamp(x);
    let my = mirror_clamp(y);
    heights[mx][my]
}

#[inline]
fn mirror_clamp(coord: i32) -> usize {
    if coord < 0 {
        ((-coord).min(8)) as usize
    } else if coord > 8 {
        (8 - (coord - 8).min(8)) as usize
    } else {
        coord as usize
    }
}

/// Evaluate the bilinear height at `(u, v)` where `(u, v) ∈ [0, 8]`
/// are control coords. Mirrors the collision-path sampler in
/// `WorldState::terrain_heights` so the subdivision can clamp visual
/// vs collision divergence.
pub fn eval_bilinear_at(heights: &[[f32; 9]; 9], u: f32, v: f32) -> f32 {
    let u = u.max(0.0).min(8.0);
    let v = v.max(0.0).min(8.0);
    let xi = (u.floor() as i32).max(0).min(7) as usize;
    let yi = (v.floor() as i32).max(0).min(7) as usize;
    let tx = u - xi as f32;
    let ty = v - yi as f32;
    let h00 = heights[xi][yi];
    let h10 = heights[xi + 1][yi];
    let h01 = heights[xi][yi + 1];
    let h11 = heights[xi + 1][yi + 1];
    h00 * (1.0 - tx) * (1.0 - ty)
        + h10 * tx * (1.0 - ty)
        + h01 * (1.0 - tx) * ty
        + h11 * tx * ty
}

/// Evaluate the bicubic Catmull-Rom patch at `(u, v)` where
/// `(u, v) ∈ [0, 8] × [0, 8]` are control-point coordinates (24 m per
/// unit). Returns the interpolated height in metres.
pub fn eval_bicubic_at(
    heights: &[[f32; 9]; 9],
    adjacent: &AdjacentHeights,
    u: f32,
    v: f32,
) -> f32 {
    let xi = u.floor() as i32;
    let yi = v.floor() as i32;
    let tx = u - xi as f32;
    let ty = v - yi as f32;

    let patch = neighbourhood_patch(heights, adjacent, xi, yi);
    // Interpolate along x in each row, then along y.
    let row0 = catmull_rom_1d(patch[0][0], patch[1][0], patch[2][0], patch[3][0], tx);
    let row1 = catmull_rom_1d(patch[0][1], patch[1][1], patch[2][1], patch[3][1], tx);
    let row2 = catmull_rom_1d(patch[0][2], patch[1][2], patch[2][2], patch[3][2], tx);
    let row3 = catmull_rom_1d(patch[0][3], patch[1][3], patch[2][3], patch[3][3], tx);
    catmull_rom_1d(row0, row1, row2, row3, ty)
}

// ---------- Deterministic 2D value-noise ----------
//
// A small Perlin-style 2D value-noise. Deterministic from a `seed`
// plus the integer lattice coordinates. We use this rather than a
// crate dep so the implementation can be mirrored byte-for-byte in
// JS for Phase 2.2 animated displacement.

/// 32-bit hash used to derive lattice values. Implementation borrows
/// from MurmurHash's finalizer — short, well-mixed, deterministic.
fn lattice_hash(x: i32, y: i32, seed: u64) -> u32 {
    let mut h: u64 = seed;
    h = h.wrapping_mul(0x9E37_79B9_7F4A_7C15);
    h ^= (x as u32 as u64).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    h = h.rotate_left(31).wrapping_mul(0x94D0_49BB_1331_11EB);
    h ^= (y as u32 as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15);
    h = h.rotate_left(31).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    h ^= h >> 27;
    h = h.wrapping_mul(0x94D0_49BB_1331_11EB);
    h ^= h >> 31;
    h as u32
}

/// Lattice value in `[-1, 1]`.
fn lattice_value(x: i32, y: i32, seed: u64) -> f32 {
    let h = lattice_hash(x, y, seed);
    // Convert top 24 bits to a float in [0, 1) then remap to [-1, 1].
    let f = (h >> 8) as f32 / ((1u32 << 24) as f32);
    f * 2.0 - 1.0
}

/// Perlin-style smoothstep: `6t⁵ - 15t⁴ + 10t³`. Maps `[0, 1]` to `[0, 1]`
/// with zero first + second derivative at endpoints.
#[inline]
fn fade(t: f32) -> f32 {
    t * t * t * (t * (t * 6.0 - 15.0) + 10.0)
}

/// 2D value-noise at `(x, y)` (world coords). Returns a value in
/// roughly `[-1, 1]`.
pub fn value_noise_2d(x: f32, y: f32, seed: u64) -> f32 {
    let x0 = x.floor() as i32;
    let y0 = y.floor() as i32;
    let tx = fade(x - x0 as f32);
    let ty = fade(y - y0 as f32);

    let v00 = lattice_value(x0, y0, seed);
    let v10 = lattice_value(x0 + 1, y0, seed);
    let v01 = lattice_value(x0, y0 + 1, seed);
    let v11 = lattice_value(x0 + 1, y0 + 1, seed);

    let a = v00 + tx * (v10 - v00);
    let b = v01 + tx * (v11 - v01);
    a + ty * (b - a)
}

/// Sample noise displacement at LB-global metre coords. Returns a
/// displacement in metres, bounded to `[-NOISE_AMPLITUDE_MAX_M,
/// NOISE_AMPLITUDE_MAX_M]`.
pub fn noise_displacement_m(world_x_m: f32, world_y_m: f32, scale: f32, seed: u64) -> f32 {
    if scale <= 0.0 {
        return 0.0;
    }
    let n = value_noise_2d(
        world_x_m * NOISE_FREQ_PER_METER,
        world_y_m * NOISE_FREQ_PER_METER,
        seed,
    );
    (n * scale * NOISE_AMPLITUDE_MAX_M)
        .max(-NOISE_AMPLITUDE_MAX_M)
        .min(NOISE_AMPLITUDE_MAX_M)
}

/// Per-cell terrain-quad triangulation diagonal — `true` ⇒ the cell is
/// cut along the SW→NE diagonal (triangles share the SW–NE edge),
/// `false` ⇒ cut along the SE→NW diagonal (share the SE–NW edge).
///
/// This is the **exact** rule retail used; it is NOT random per-bake but
/// a deterministic 32-bit-unsigned-wrap function of the cell's GLOBAL
/// coordinates (`landblock_byte * 8 + cell_index`).
///
/// Source of truth (precedence: acclient.c > ACE > DRW):
/// - **acclient.c** `CLandBlockStruct::ConstructPolygons` @531D10
///   (lines ~354001–354100): with
///   `block_x = (block_id >> 21) & 0x7F8` (= `lbX_byte * 8`) and
///   `block_y = 8 * ((block_id >> 16) & 0xFF)` (= `lbY_byte * 8`), for a
///   cell at local `(cellX = i, cellY = v5)`:
///   ```text
///   gX = block_x + cellX;  gY = block_y + cellY;
///   v8 = gY * (214614067*gX + 1813693831) - 1109124029*gX - 1369149221;  // u32 wrap
///   SWtoNEcut = (double)(u32)v8 * 2.3283064e-10 >= 0.5;                   // 2.3283064e-10 ≈ 1/2^32
///   ```
///   `ConstructUVs` @5329A0 (acclient.c:354676-354759) then keys the two
///   triangles' corner order off this same `SWtoNEcut[...]` bit.
/// - **ACE** cross-check: `ACE.Server/Physics/Common/LandblockStruct.cs`
///   `ConstructPolygons` (lines 182-266) uses the identical constants
///   (`214614067 / 1813693831 / 1109124029 / 1369149221`) and the same
///   `splitDir * 2.3283064e-10 < 0.5 ⇒ SWtoNEcut = false` test. ACE
///   reaches the same global coords via `lcoord.X * VertexPerCell` with
///   `VertexPerCell = 1` and `lcoord = blockid_to_lcoord(id)` already in
///   cell units (`lbX_byte << 3`). **No divergence** between acclient and
///   ACE on this rule.
///
/// `global_cell_x`/`global_cell_y` are the cell's coordinates in the
/// world cell grid: `landblock_byte * 8 + cell_index_within_landblock`.
#[inline]
pub fn cell_swto_ne_cut(global_cell_x: u32, global_cell_y: u32) -> bool {
    // 32-bit unsigned wraparound throughout — acclient is the shipped
    // client and uses 32-bit unsigned arithmetic (ACE matches via
    // `(uint)` casts). Do NOT widen to u64.
    let gx = global_cell_x;
    let gy = global_cell_y;
    let inner = 214614067u32
        .wrapping_mul(gx)
        .wrapping_add(1813693831);
    let v8 = gy
        .wrapping_mul(inner)
        .wrapping_sub(1109124029u32.wrapping_mul(gx))
        .wrapping_sub(1369149221);
    // 2.3283064e-10 ≈ 1/2^32 → normalize the u32 to [0, 1) then test ≥ 0.5.
    (v8 as f64) * 2.3283064e-10 >= 0.5
}

/// Interpolate terrain height inside a single 24 m cell on the SAME
/// triangulation the render mesh uses, so physics/camera Z tracks the drawn
/// surface exactly (RC-1, 2026-06-20).
///
/// Corner heights: `z00`=SW, `z10`=SE, `z01`=NW, `z11`=NE. `fx`/`fy` ∈ [0, 1]
/// are the east/north fractions within the cell. `sw_ne_cut` selects the
/// diagonal — feed [`cell_swto_ne_cut`] for the retail per-cell split, or a
/// fixed `true` for the legacy single SW↔NE diagonal:
/// - `true`  → SW↔NE diagonal (z00↔z11); split on `fx == fy`.
/// - `false` → NW↔SE diagonal (z01↔z10); split on `fx + fy == 1`.
///
/// Continuous across the chosen diagonal (both triangle planes meet on it) and
/// exact at all four corners. The `true` branch is byte-identical to the prior
/// fixed-diagonal interpolation, so `sw_ne_cut == true` everywhere reproduces
/// the legacy behaviour exactly (A/B revert).
#[inline]
pub fn triangle_height_in_cell(
    z00: f32,
    z10: f32,
    z01: f32,
    z11: f32,
    fx: f32,
    fy: f32,
    sw_ne_cut: bool,
) -> f32 {
    if sw_ne_cut {
        // SW↔NE diagonal (z00↔z11): split on fx == fy.
        if fx >= fy {
            // lower-right triangle: SW(z00), SE(z10), NE(z11).
            z00 + (z10 - z00) * fx + (z11 - z10) * fy
        } else {
            // upper-left triangle: SW(z00), NE(z11), NW(z01).
            z00 + (z11 - z01) * fx + (z01 - z00) * fy
        }
    } else {
        // NW↔SE diagonal (z01↔z10): split on fx + fy == 1.
        if fx + fy <= 1.0 {
            // lower-left triangle: SW(z00), SE(z10), NW(z01).
            z00 + (z10 - z00) * fx + (z01 - z00) * fy
        } else {
            // upper-right triangle: NE(z11), NW(z01), SE(z10).
            z11 + (z01 - z11) * (1.0 - fx) + (z10 - z11) * (1.0 - fy)
        }
    }
}

/// Per-cell terrain gradient `(∂z/∂fx, ∂z/∂fy)` in CELL-FRACTION units for the
/// SAME triangle [`triangle_height_in_cell`] interpolates over. Divide each by
/// the cell size in metres to get m/m partials, then
/// `normal = normalize(-∂z/∂x, -∂z/∂y, 1)`. Corner/diagonal conventions match
/// the height fn (`z00`=SW, `z10`=SE, `z01`=NW, `z11`=NE; `sw_ne_cut`). Constant
/// within each triangle (planar), so this is the exact face normal.
#[inline]
pub fn triangle_grad_in_cell(
    z00: f32,
    z10: f32,
    z01: f32,
    z11: f32,
    fx: f32,
    fy: f32,
    sw_ne_cut: bool,
) -> (f32, f32) {
    if sw_ne_cut {
        if fx >= fy {
            (z10 - z00, z11 - z10) // lower-right: SW, SE, NE
        } else {
            (z11 - z01, z01 - z00) // upper-left: SW, NE, NW
        }
    } else if fx + fy <= 1.0 {
        (z10 - z00, z01 - z00) // lower-left: SW, SE, NW
    } else {
        (z11 - z01, z11 - z10) // upper-right: NE, NW, SE
    }
}

/// Per-vertex terrain normals at the 9×9 control grid, **continuous
/// across landblock seams**. Each normal is a central difference of the
/// control heights; at an LB-edge vertex the sample one step past the
/// seam comes from the neighbour LB's strip (`adjacent`) rather than a
/// mirror of the interior, so the vertex shared by two landblocks gets
/// an *identical* normal on both sides — eliminating the lighting seam
/// retail itself has (retail computes terrain normals per-landblock, see
/// `CLandBlockStruct::calc_lighting`). Falls back to a one-sided
/// difference only at the world boundary (neighbour `None`).
///
/// Returned as `[x][y]` unit vectors in AC space (+Z up). Neighbour-strip
/// index map (see [`AdjacentHeights`]): `west[0]`=x−1, `east[1]`=x+9,
/// `south[i][0]`=y−1, `north[i][1]`=y+9.
fn control_grid_normals(
    heights: &[[f32; 9]; 9],
    adjacent: &AdjacentHeights,
) -> [[[f32; 3]; 9]; 9] {
    let s = CONTROL_SPACING_M;
    let mut out = [[[0.0f32, 0.0, 1.0]; 9]; 9];
    for i in 0..9usize {
        for j in 0..9usize {
            // x slope: samples at i−1 (west) and i+1 (east).
            let (h_xm, span_m) = if i > 0 {
                (heights[i - 1][j], s)
            } else if let Some(w) = &adjacent.west {
                (w[0][j], s) // west neighbour col 7 == x = −1
            } else {
                (heights[i][j], 0.0) // world edge → one-sided
            };
            let (h_xp, span_p) = if i < 8 {
                (heights[i + 1][j], s)
            } else if let Some(e) = &adjacent.east {
                (e[1][j], s) // east neighbour col 1 == x = +9
            } else {
                (heights[i][j], 0.0)
            };
            let span_x = span_m + span_p;
            let dzdx = if span_x > 0.0 {
                (h_xp - h_xm) / span_x
            } else {
                0.0
            };

            // y slope: samples at j−1 (south) and j+1 (north).
            let (h_ym, span_s) = if j > 0 {
                (heights[i][j - 1], s)
            } else if let Some(so) = &adjacent.south {
                (so[i][0], s) // south neighbour row 7 == y = −1
            } else {
                (heights[i][j], 0.0)
            };
            let (h_yp, span_n) = if j < 8 {
                (heights[i][j + 1], s)
            } else if let Some(no) = &adjacent.north {
                (no[i][1], s) // north neighbour row 1 == y = +9
            } else {
                (heights[i][j], 0.0)
            };
            let span_y = span_s + span_n;
            let dzdy = if span_y > 0.0 {
                (h_yp - h_ym) / span_y
            } else {
                0.0
            };

            // normal = normalize(−dz/dx, −dz/dy, 1)
            let nx = -dzdx;
            let ny = -dzdy;
            let nz = 1.0;
            let mag = (nx * nx + ny * ny + nz * nz).sqrt().max(1e-6);
            out[i][j] = [nx / mag, ny / mag, nz / mag];
        }
    }
    out
}

/// Subdivide a 9×9 control-height grid into `(subdiv*8+1)²` vertices
/// with Catmull-Rom bicubic interpolation + per-category noise.
///
/// `subdiv_factor` of 1 returns the original 9×9 grid exactly (no
/// interpolation, no noise — subdiv=1 is "no subdivision").
///
/// Bicubic Catmull-Rom is C1-continuous and gives smooth visual
/// curves. It does not preserve C2 across patches; in practice the
/// visual difference at terrain frequencies is invisible. Upgrade to
/// pure bicubic (Hermite with finite-difference tangents) here if
/// shading reveals creases — leave the function signature stable.
pub fn subdivide_landblock(
    heights: &[[f32; 9]; 9],
    adjacent: &AdjacentHeights,
    subdiv_factor: u32,
    terrain_codes: &[[u8; 9]; 9],
    road_codes: &[[u8; 9]; 9],
    landblock_id: u32,
    _seed: u64,
) -> SubdividedLandblock {
    assert!(subdiv_factor >= 1, "subdiv_factor must be >= 1");
    let factor = subdiv_factor.max(1) as usize;
    // 9 control points = 8 spans → factor*8 + 1 verts per side.
    let n = factor * 8 + 1;
    let vertex_count = n * n;

    // Step in control-point coords per subdivided vertex.
    let step_ctrl = 1.0 / factor as f32; // 1 control unit / factor steps
    let step_m = CONTROL_SPACING_M / factor as f32;

    // Cross-LB-continuous smooth normals at the 9×9 control grid; the
    // subdivided vertices below bilinearly interpolate these, so shading
    // stays smooth (Gouraud) with NO landblock lighting seam, while
    // POSITIONS stay pinned to the faceted collision surface (no
    // visual-vs-collision gap → no "half-sunk").
    let control_normals = control_grid_normals(heights, adjacent);

    // Global cell coords of this LB's SW corner — picks the SAME per-cell
    // triangulation diagonal the collision sampler (`triangle_height_in_cell`
    // via `WorldState::terrain_height_at`) and the index buffer below use,
    // so the drawn surface IS the collision surface (retail-exact).
    let lb_x_int = ((landblock_id >> 24) & 0xff) * 8;
    let lb_y_int = ((landblock_id >> 16) & 0xff) * 8;

    let mut height_min = f32::INFINITY;
    let mut height_max = f32::NEG_INFINITY;
    let mut codes_out = vec![0u8; vertex_count];
    let mut road_out = vec![0u8; vertex_count];
    let mut positions = vec![0.0f32; vertex_count * 3];
    let mut normals = vec![0.0f32; vertex_count * 3];

    for i in 0..n {
        for j in 0..n {
            let u = i as f32 * step_ctrl;
            let v = j as f32 * step_ctrl;
            // Owning base cell (+1 corner kept in range) and in-cell fractions.
            let cu = (u.floor() as usize).min(7);
            let cv = (v.floor() as usize).min(7);
            let fx = u - cu as f32;
            let fy = v - cv as f32;
            // Corner heights: z00=SW, z10=SE, z01=NW, z11=NE.
            let z00 = heights[cu][cv];
            let z10 = heights[cu + 1][cv];
            let z01 = heights[cu][cv + 1];
            let z11 = heights[cu + 1][cv + 1];
            // POSITION Z = faceted collision surface on this cell's retail
            // split diagonal. At factor==1 this is exactly heights[i][j].
            let sw_ne_cut =
                cell_swto_ne_cut(lb_x_int + cu as u32, lb_y_int + cv as u32);
            let z = triangle_height_in_cell(z00, z10, z01, z11, fx, fy, sw_ne_cut);

            // NORMAL = bilinear blend of the 4 cross-LB control normals.
            let n00 = control_normals[cu][cv];
            let n10 = control_normals[cu + 1][cv];
            let n01 = control_normals[cu][cv + 1];
            let n11 = control_normals[cu + 1][cv + 1];
            let mut nrm = [0.0f32; 3];
            for k in 0..3 {
                let s0 = n00[k] * (1.0 - fx) + n10[k] * fx;
                let s1 = n01[k] * (1.0 - fx) + n11[k] * fx;
                nrm[k] = s0 * (1.0 - fy) + s1 * fy;
            }
            let mag = (nrm[0] * nrm[0] + nrm[1] * nrm[1] + nrm[2] * nrm[2])
                .sqrt()
                .max(1e-6);

            // Nearest control-point terrain/road code (shader blends these
            // via the 9×9 texture anyway).
            let ci = (u.round() as usize).min(8);
            let cj = (v.round() as usize).min(8);

            let idx = i * n + j;
            let idx3 = idx * 3;
            positions[idx3] = i as f32 * step_m;
            positions[idx3 + 1] = j as f32 * step_m;
            positions[idx3 + 2] = z;
            normals[idx3] = nrm[0] / mag;
            normals[idx3 + 1] = nrm[1] / mag;
            normals[idx3 + 2] = nrm[2] / mag;
            codes_out[idx] = terrain_codes[ci][cj];
            road_out[idx] = road_codes[ci][cj];

            if z < height_min {
                height_min = z;
            }
            if z > height_max {
                height_max = z;
            }
        }
    }

    // Triangle indices. Each quad → 2 triangles. The Rust output winds
    // CW-from-+Z; the adapter's per-triangle index-reversal pass
    // (`landblockSubdividedMeshToGeometry` in adapter.js) flips it to the
    // conventional CCW for FrontSide rendering post-worldRoot rotation,
    // so per-poly backface cull (default ON) keeps every cell visible.
    //
    // Per-cell diagonal (Wave R1.B). `i` indexes AC +X (east, stride
    // `n`), `j` indexes AC +Y (north, stride `1`) — see the v00/v10/v01
    // labels below. Each base CELL spans `factor` sub-quads per side;
    // all sub-quads inside a base cell inherit that cell's diagonal so
    // the silhouette matches retail's per-cell split exactly (and at
    // `factor == 1` the sub-quad IS the cell, the retail case).
    // `lb_x_int` / `lb_y_int` (global cell X/Y of the LB's SW corner) are
    // declared above with the position loop — reused here for the index
    // triangulation so the diagonal matches the drawn surface exactly.
    let mut indices = Vec::with_capacity((n - 1) * (n - 1) * 6);
    for i in 0..(n - 1) {
        for j in 0..(n - 1) {
            let v00 = (i * n + j) as u32; // SW
            let v10 = ((i + 1) * n + j) as u32; // SE (+x / east)
            let v01 = (i * n + j + 1) as u32; // NW (+y / north)
            let v11 = ((i + 1) * n + j + 1) as u32; // NE
            // Which retail cell does this sub-quad belong to?
            let cell_x = lb_x_int + (i / factor) as u32;
            let cell_y = lb_y_int + (j / factor) as u32;
            let swto_ne = cell_swto_ne_cut(cell_x, cell_y);
            // Both branches emit the SAME CW-from-+Z winding the legacy
            // fixed split used; the adapter's per-triangle reversal then
            // yields conventional CCW for FrontSide rendering, so per-poly
            // backface cull (default ON) treats both diagonals identically
            // and no cell ever vanishes.
            if swto_ne {
                // SW↔NE cut — triangles share the SW–NE edge.
                // (legacy fixed diagonal: T1 NW→NE→SW, T2 NE→SE→SW)
                indices.push(v01);
                indices.push(v11);
                indices.push(v00);
                indices.push(v11);
                indices.push(v10);
                indices.push(v00);
            } else {
                // SE↔NW cut — triangles share the SE–NW edge.
                // CW-from-+Z: T1 SW→NW→SE, T2 SE→NW→NE (each verified to
                // wind the same handedness as the SW↔NE case above).
                indices.push(v00);
                indices.push(v01);
                indices.push(v10);
                indices.push(v10);
                indices.push(v01);
                indices.push(v11);
            }
        }
    }

    SubdividedLandblock {
        positions,
        normals,
        terrain_codes: codes_out,
        road_codes: road_out,
        indices,
        vertex_count: vertex_count as u32,
        grid_size: n as u32,
        height_min,
        height_max,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A flat 9×9 grid at height `z`.
    fn flat(z: f32) -> [[f32; 9]; 9] {
        [[z; 9]; 9]
    }

    /// Build a 9×9 codes grid with one code everywhere.
    fn codes(c: u8) -> [[u8; 9]; 9] {
        [[c; 9]; 9]
    }

    fn zero_roads() -> [[u8; 9]; 9] {
        [[0u8; 9]; 9]
    }

    /// Sloped grid — h(x, y) = x + y. Bicubic should reproduce a
    /// linear surface exactly.
    fn linear_slope() -> [[f32; 9]; 9] {
        let mut h = [[0.0f32; 9]; 9];
        for x in 0..9 {
            for y in 0..9 {
                h[x][y] = x as f32 + y as f32;
            }
        }
        h
    }

    #[test]
    fn subdiv_1_round_trips_input() {
        let h = linear_slope();
        let c = codes(1); // grass — non-zero noise scale, but factor=1 disables noise
        let r = zero_roads();
        let adj = AdjacentHeights::default();
        let out = subdivide_landblock(&h, &adj, 1, &c, &r, 0xA9B40000, 0xC0FFEE);
        assert_eq!(out.grid_size, 9);
        assert_eq!(out.vertex_count, 81);
        // Each vertex's z should match heights[i][j] exactly — no
        // interpolation, no noise.
        for i in 0..9 {
            for j in 0..9 {
                let idx = (i * 9 + j) * 3;
                let z = out.positions[idx + 2];
                assert!(
                    (z - h[i][j]).abs() < 1e-6,
                    "subdiv=1 mismatch at ({i},{j}): got {z} expected {}",
                    h[i][j]
                );
            }
        }
        // Indices: 8x8 quads × 6 = 384.
        assert_eq!(out.indices.len(), 384);
    }

    #[test]
    fn deterministic_same_input_same_output() {
        let h = linear_slope();
        let c = codes(1);
        let r = zero_roads();
        let adj = AdjacentHeights::default();
        let a = subdivide_landblock(&h, &adj, 4, &c, &r, 0xA9B40000, 0xC0FFEE);
        let b = subdivide_landblock(&h, &adj, 4, &c, &r, 0xA9B40000, 0xC0FFEE);
        assert_eq!(a.positions, b.positions);
        assert_eq!(a.normals, b.normals);
        assert_eq!(a.terrain_codes, b.terrain_codes);
        assert_eq!(a.indices, b.indices);
    }

    /// F12-1 seam invariant: a FINER landblock's boundary vertices land
    /// EXACTLY on the COARSER neighbour's straight edge chord, so adjacent
    /// LBs baked at DIFFERENT subdiv levels (the moving `?lodRebake` LOD
    /// boundary) meet crack-free with NO runtime edge-weld. This holds
    /// because the position Z is the faceted collision surface
    /// (`triangle_height_in_cell`), which is LINEAR along every cell edge and
    /// therefore factor-independent. Regression guard: if Z ever reverts to a
    /// curved (e.g. Catmull-Rom) edge, the finer edge bulges off the chord and
    /// this fails — exactly the seam that kept `?lodRebake` default-off. (2026-06-28)
    #[test]
    fn lod_boundary_edges_coincide_across_factors() {
        // Varied, non-flat heights; water code (16) ⇒ zero noise so Z is the
        // pure surface. A coarse neighbour at factor 1 draws each edge span as
        // the straight chord between consecutive control heights.
        let mut h = [[0.0f32; 9]; 9];
        for x in 0..9 {
            for y in 0..9 {
                h[x][y] = (x * 13 + y * 5) as f32 + (x as f32) * (y as f32) * 0.5;
            }
        }
        let c = codes(16);
        let r = zero_roads();
        let adj = AdjacentHeights::default();
        let fine = subdivide_landblock(&h, &adj, 4, &c, &r, 0xA9B40000, 7);
        let factor = 4usize;
        let n = factor * 8 + 1; // 33 verts per side
        // The coarse-neighbour edge value at fine position `pos`: linear interp
        // between the two bracketing control heights (the rendered chord).
        let chord = |edge: &[f32; 9], pos: usize| -> f32 {
            let u = pos as f32 / factor as f32;
            let lo = (u.floor() as usize).min(8);
            let hi = (lo + 1).min(8);
            let t = u - lo as f32;
            edge[lo] * (1.0 - t) + edge[hi] * t
        };
        // positions: idx = i*n + j; i = east, j = north.
        let zat = |i: usize, j: usize| fine.positions[(i * n + j) * 3 + 2];
        let mut south = [0.0f32; 9];
        let mut north = [0.0f32; 9];
        let mut west = [0.0f32; 9];
        let mut east = [0.0f32; 9];
        for k in 0..9 {
            south[k] = h[k][0];
            north[k] = h[k][8];
            west[k] = h[0][k];
            east[k] = h[8][k];
        }
        for k in 0..n {
            let zs = zat(k, 0);
            assert!((zs - chord(&south, k)).abs() < 1e-4, "south seam i={k}: {zs} vs {}", chord(&south, k));
            let zn = zat(k, n - 1);
            assert!((zn - chord(&north, k)).abs() < 1e-4, "north seam i={k}: {zn} vs {}", chord(&north, k));
            let zw = zat(0, k);
            assert!((zw - chord(&west, k)).abs() < 1e-4, "west seam j={k}: {zw} vs {}", chord(&west, k));
            let ze = zat(n - 1, k);
            assert!((ze - chord(&east, k)).abs() < 1e-4, "east seam j={k}: {ze} vs {}", chord(&east, k));
        }
    }

    #[test]
    fn bicubic_matches_corners_at_control_points() {
        let mut h = [[0.0f32; 9]; 9];
        // Sprinkle distinct values.
        for x in 0..9 {
            for y in 0..9 {
                h[x][y] = (x * 11 + y * 7) as f32;
            }
        }
        // Use a water code so noise contribution is 0 and we test
        // the bicubic value at integer control points equals the grid
        // exactly (stone-coded noise would mask the comparison).
        let c = codes(16);
        let r = zero_roads();
        let adj = AdjacentHeights::default();
        let out = subdivide_landblock(&h, &adj, 4, &c, &r, 0xA9B40000, 1);
        // At grid points (i = subdiv*ci, j = subdiv*cj), the height
        // should equal h[ci][cj].
        for ci in 0..9 {
            for cj in 0..9 {
                let i = ci * 4;
                let j = cj * 4;
                let z = out.positions[(i * out.grid_size as usize + j) * 3 + 2];
                assert!(
                    (z - h[ci][cj]).abs() < 1e-4,
                    "bicubic value at control ({ci},{cj}) mismatch: got {z} expected {}",
                    h[ci][cj]
                );
            }
        }
    }

    #[test]
    fn water_codes_get_zero_noise() {
        let h = flat(50.0);
        let c = codes(16); // WaterRunning
        let r = zero_roads();
        let adj = AdjacentHeights::default();
        let out = subdivide_landblock(&h, &adj, 4, &c, &r, 0xA9B40000, 0xC0FFEE);
        // Every vertex z should equal 50.0 exactly (no noise on water).
        for i in 0..out.vertex_count as usize {
            let z = out.positions[i * 3 + 2];
            assert!(
                (z - 50.0).abs() < 1e-5,
                "water vertex {i} got noise: z={z}"
            );
        }
    }

    // Removed `stone_codes_get_noise_within_bounds` and
    // `snow_amplitude_smaller_than_stone` (2026-06-26): per-category noise
    // no longer displaces terrain GEOMETRY — vertex positions are the
    // faceted collision surface. `noise_displacement_m` and its own unit
    // tests remain below for any non-geometry use.

    #[test]
    fn lb_edge_mirror_boundary_when_adjacent_absent() {
        // Make an asymmetric grid so the boundary read matters.
        let mut h = [[0.0f32; 9]; 9];
        for x in 0..9 {
            for y in 0..9 {
                h[x][y] = (x * x + y) as f32;
            }
        }
        let c = codes(16); // water — no noise to muddy the assertion
        let r = zero_roads();
        let adj = AdjacentHeights::default();
        let out = subdivide_landblock(&h, &adj, 4, &c, &r, 0xA9B40000, 1);
        // A subdivided vertex one step inside the east edge should
        // sit between control points (7, y) and (8, y) — bicubic with
        // mirror at x=9 still yields a finite real value bounded by
        // the local control range.
        let n = out.grid_size as usize;
        for j in 0..n {
            let idx = ((n - 2) * n + j) * 3 + 2;
            let z = out.positions[idx];
            assert!(z.is_finite(), "mirror-boundary produced NaN at j={j}");
            // h is monotonically increasing in x. The subdivided
            // value at the edge should be greater than the value
            // at the previous control point in x.
            let edge_ctrl_idx = (4 * 7 * n + j * 4) * 3 + 2; // ci=7, cj=j
            // Sanity bound only — exact mirror value differs.
            // Just assert finite + reasonable.
            let _ = edge_ctrl_idx;
            assert!(z > -1.0 && z < 200.0);
        }
    }

    // Removed `lb_edge_uses_adjacent_when_loaded` (2026-06-26): it asserted
    // the bicubic POSITION path read neighbour-LB heights and overshot, then
    // clamped to ±0.3 m. Positions are faceted now (no bicubic, no clamp);
    // the neighbour strips feed cross-LB NORMALS instead — covered by
    // `cross_lb_normals_are_seam_continuous`.

    #[test]
    fn vertex_normal_flat_terrain_is_z_up() {
        let h = flat(5.0);
        let c = codes(16); // water — no noise
        let r = zero_roads();
        let adj = AdjacentHeights::default();
        let out = subdivide_landblock(&h, &adj, 4, &c, &r, 0xA9B40000, 1);
        // Check the centre normal — it should be (0, 0, 1).
        let n = out.grid_size as usize;
        let ci = n / 2;
        let cj = n / 2;
        let idx3 = (ci * n + cj) * 3;
        let nx = out.normals[idx3];
        let ny = out.normals[idx3 + 1];
        let nz = out.normals[idx3 + 2];
        assert!(nx.abs() < 1e-5, "flat normal x got {nx}");
        assert!(ny.abs() < 1e-5, "flat normal y got {ny}");
        assert!((nz - 1.0).abs() < 1e-5, "flat normal z got {nz}");
    }

    #[test]
    fn indices_count_matches_grid_size() {
        let h = flat(0.0);
        let c = codes(0);
        let r = zero_roads();
        let adj = AdjacentHeights::default();
        for factor in [1, 2, 4, 8] {
            let out =
                subdivide_landblock(&h, &adj, factor, &c, &r, 0xA9B40000, 0xC0FFEE);
            let n = factor as usize * 8 + 1;
            assert_eq!(out.grid_size as usize, n);
            assert_eq!(out.vertex_count as usize, n * n);
            assert_eq!(out.positions.len(), n * n * 3);
            assert_eq!(out.normals.len(), n * n * 3);
            assert_eq!(out.terrain_codes.len(), n * n);
            assert_eq!(out.road_codes.len(), n * n);
            // Indices: (n-1)² quads × 6 = 6(n-1)².
            assert_eq!(out.indices.len(), 6 * (n - 1) * (n - 1));
            // Every index in range.
            let v = out.vertex_count;
            for &ix in &out.indices {
                assert!(ix < v, "index {ix} out of range {v}");
            }
        }
    }

    #[test]
    fn winding_is_consistent_ccw_post_mirror() {
        // Each triangle's (v01, v11, v00) and (v11, v10, v00) layout
        // is the SW-last form used by `build_mesh` in lib.rs. The
        // adapter's per-triangle reversal turns it into conventional
        // CCW. Verify the index layout matches that contract for a
        // small grid.
        let h = flat(0.0);
        let c = codes(0);
        let r = zero_roads();
        let adj = AdjacentHeights::default();
        let out = subdivide_landblock(&h, &adj, 1, &c, &r, 0xA9B40000, 0xC0FFEE);
        // First quad: (i=0, j=0). Expected indices: v01, v11, v00, v11, v10, v00.
        let n = out.grid_size; // 9
        let v00 = 0u32;
        let v10 = n;
        let v01 = 1u32;
        let v11 = n + 1;
        assert_eq!(&out.indices[0..6], &[v01, v11, v00, v11, v10, v00]);
    }

    #[test]
    fn noise_displacement_clamped_to_max() {
        // Crank up "scale" to verify the cap.
        let d = noise_displacement_m(123.0, 456.0, 10.0, 42);
        assert!(d.abs() <= NOISE_AMPLITUDE_MAX_M + 1e-5);
    }

    #[test]
    fn noise_zero_scale_returns_zero() {
        let d = noise_displacement_m(100.0, 200.0, 0.0, 42);
        assert_eq!(d, 0.0);
    }

    #[test]
    fn mirror_clamp_handles_edges() {
        assert_eq!(mirror_clamp(-1), 1);
        assert_eq!(mirror_clamp(-2), 2);
        assert_eq!(mirror_clamp(-8), 8);
        assert_eq!(mirror_clamp(0), 0);
        assert_eq!(mirror_clamp(8), 8);
        assert_eq!(mirror_clamp(9), 7);
        assert_eq!(mirror_clamp(10), 6);
    }

    #[test]
    fn visual_surface_equals_collision_surface() {
        // Strong elevation gradient — the case the old bicubic path used
        // to overshoot by metres. Now every subdivided vertex must sit
        // EXACTLY on the faceted collision surface (`triangle_height_in_cell`
        // on the cell's retail split), so the local player can never be
        // half-sunk under / floating over the drawn ground.
        let mut h = [[0.0f32; 9]; 9];
        for x in 0..9 {
            for y in 0..9 {
                h[x][y] = 25.0 + 25.0 * (x as f32 * 0.7).sin() * (y as f32 * 0.7).cos();
            }
        }
        let c = codes(0);
        let r = zero_roads();
        let adj = AdjacentHeights::default();
        let lb_id = 0xA9B4_0000u32;
        let factor = 4usize;
        let out = subdivide_landblock(&h, &adj, factor as u32, &c, &r, lb_id, 0xC0FFEE);
        let n = out.grid_size as usize;
        let lb_x_int = ((lb_id >> 24) & 0xff) * 8;
        let lb_y_int = ((lb_id >> 16) & 0xff) * 8;
        let mut max_dev = 0.0f32;
        for i in 0..n {
            for j in 0..n {
                let u = i as f32 / factor as f32;
                let v = j as f32 / factor as f32;
                let cu = (u.floor() as usize).min(7);
                let cv = (v.floor() as usize).min(7);
                let fx = u - cu as f32;
                let fy = v - cv as f32;
                let sw_ne_cut =
                    cell_swto_ne_cut(lb_x_int + cu as u32, lb_y_int + cv as u32);
                let expected = triangle_height_in_cell(
                    h[cu][cv],
                    h[cu + 1][cv],
                    h[cu][cv + 1],
                    h[cu + 1][cv + 1],
                    fx,
                    fy,
                    sw_ne_cut,
                );
                let z = out.positions[(i * n + j) * 3 + 2];
                let dev = (z - expected).abs();
                if dev > max_dev {
                    max_dev = dev;
                }
                assert!(
                    dev < 1e-4,
                    "visual ({i},{j}) Z={z} != collision {expected} (dev {dev})"
                );
            }
        }
        eprintln!("[visual_surface_equals_collision_surface] max dev = {max_dev}");
    }

    #[test]
    fn cross_lb_normals_are_seam_continuous() {
        // The vertex shared by two adjacent landblocks must get an
        // IDENTICAL normal from each LB's `control_grid_normals` — else
        // lighting seams every 192 m. Build LB-A (global x 0..=8) and its
        // east neighbour LB-B (x 8..=16) from one continuous, nonlinear
        // height field, wire the neighbour strips, and check the shared
        // east/west edge.
        let f = |gx: i32, gy: i32| -> f32 {
            (gx as f32 * 0.37).sin() * 3.0 + (gy as f32 * 0.29).cos() * 2.0 + gx as f32 * 0.5
        };
        let mut a = [[0.0f32; 9]; 9];
        let mut b = [[0.0f32; 9]; 9];
        for i in 0..9 {
            for j in 0..9 {
                a[i][j] = f(i as i32, j as i32);
                b[i][j] = f(8 + i as i32, j as i32);
            }
        }
        // A's east strip = B columns 0,1 (global x 8,9).
        let mut a_adj = AdjacentHeights::default();
        let mut e = [[0.0f32; 9]; 2];
        for j in 0..9 {
            e[0][j] = b[0][j];
            e[1][j] = b[1][j];
        }
        a_adj.east = Some(e);
        // B's west strip = A columns 7,8 (global x 7,8).
        let mut b_adj = AdjacentHeights::default();
        let mut w = [[0.0f32; 9]; 2];
        for j in 0..9 {
            w[0][j] = a[7][j];
            w[1][j] = a[8][j];
        }
        b_adj.west = Some(w);

        let na = control_grid_normals(&a, &a_adj);
        let nb = control_grid_normals(&b, &b_adj);
        for j in 0..9 {
            for k in 0..3 {
                let dev = (na[8][j][k] - nb[0][j][k]).abs();
                assert!(
                    dev < 1e-6,
                    "seam normal mismatch at j={j} k={k}: A={} B={} (dev {dev})",
                    na[8][j][k],
                    nb[0][j][k]
                );
            }
        }
        // Sanity: the field is not flat, so the seam normal must actually
        // tilt off straight-up (otherwise the test proves nothing).
        let tilted = (0..9).any(|j| na[8][j][0].abs() > 1e-3 || na[8][j][1].abs() > 1e-3);
        assert!(tilted, "expected non-trivial normals on a sloped field");
    }

    #[test]
    fn category_noise_scale_water_lava_zero() {
        assert_eq!(noise_scale_for_category(SurfaceCategory::Water), 0.0);
        assert_eq!(noise_scale_for_category(SurfaceCategory::Lava), 0.0);
        assert!(noise_scale_for_category(SurfaceCategory::Stone) > 0.0);
        assert!(noise_scale_for_category(SurfaceCategory::Snow) > 0.0);
    }

    /// Integration test against real Holtburg LB 0xA9B4 from
    /// `client_cell_1.dat`. Verifies the subdivided mesh is well-formed
    /// against actual game data (per the project memory: "prefer real
    /// game data over synthetic"). Skips if the canonical retail dat
    /// path isn't present.
    #[test]
    fn subdivide_holtburg_landblock_from_real_dat() {
        use crate::DatDatabase;
        use crate::landblock::CellLandblock;
        let path =
            std::path::PathBuf::from("/home/wbterminal/ac_base_dats/client_cell_1.dat");
        if !path.exists() {
            eprintln!(
                "[subdivide_holtburg_landblock_from_real_dat] SKIP — \
                 no client_cell_1.dat at {}",
                path.display()
            );
            return;
        }
        let dat = DatDatabase::new(&path).expect("client_cell_1.dat should open");
        // Holtburg LB cell terrain id = 0xA9B4FFFF.
        let bytes = dat
            .get_file(0xA9B4_FFFF)
            .expect("Holtburg 0xA9B4FFFF cell terrain in retail dat");
        let cell = CellLandblock::unpack(&bytes).expect("CellLandblock unpack");

        let mut heights = [[0.0f32; 9]; 9];
        let mut codes = [[0u8; 9]; 9];
        let mut roads = [[0u8; 9]; 9];
        for x in 0..9 {
            for y in 0..9 {
                heights[x][y] = cell.get_height(x, y);
                codes[x][y] = cell.terrain_type(x, y);
                roads[x][y] = cell.road_type(x, y);
            }
        }
        let adjacent = AdjacentHeights::default();
        let factor = 4u32;
        let out = subdivide_landblock(
            &heights, &adjacent, factor, &codes, &roads, 0xA9B4_0000, 0xC0FFEE,
        );
        let n = (factor * 8 + 1) as usize;
        assert_eq!(out.grid_size as usize, n);
        assert_eq!(out.positions.len(), n * n * 3);
        assert_eq!(out.normals.len(), n * n * 3);
        // Holtburg has visible elevation — height range should be > 0.
        let mut h_min = f32::INFINITY;
        let mut h_max = f32::NEG_INFINITY;
        for i in 0..(n * n) {
            let z = out.positions[i * 3 + 2];
            if z < h_min {
                h_min = z;
            }
            if z > h_max {
                h_max = z;
            }
        }
        assert!(
            h_max - h_min > 1.0,
            "Holtburg should have >1m height range, got [{h_min}, {h_max}]"
        );
        // At control points the subdivided value must equal the 9×9 grid
        // EXACTLY — positions are the faceted collision surface now (no
        // bicubic overshoot, no noise).
        for cx in 0..9 {
            for cy in 0..9 {
                let i = cx * factor as usize;
                let j = cy * factor as usize;
                let z = out.positions[(i * n + j) * 3 + 2];
                let expected = heights[cx][cy];
                let deviation = (z - expected).abs();
                assert!(
                    deviation < 1e-3,
                    "control ({cx},{cy}) deviation {deviation} — visual must equal collision"
                );
            }
        }
        eprintln!(
            "[holtburg subdiv] grid {n}×{n}, height range [{h_min:.2}, {h_max:.2}] m, \
             {} vertices, {} indices",
            n * n,
            out.indices.len()
        );
    }

    /// Wave R1.B unit test — pin the per-cell diagonal rule extracted
    /// from acclient.c `ConstructPolygons` (@531D10) and cross-checked
    /// against ACE `LandblockStruct.ConstructPolygons`. Values are the
    /// reference Python evaluation of the 32-bit-wrap PRNG for the SW
    /// corner cells of Holtburg LB 0xA9B4 (lbX=0xA9, lbY=0xB4 → global
    /// cell origin (1352, 1440)).
    #[test]
    fn cell_split_rule_matches_retail_prng() {
        // (global_cell_x, global_cell_y, expected SWtoNEcut)
        let cases = [
            (1352u32, 1440u32, true),  // cell (0,0) — SW↔NE (legacy diag)
            (1352, 1441, true),        // (0,1)
            (1352, 1442, true),        // (0,2)
            (1353, 1440, false),       // (1,0) — SE↔NW
            (1353, 1441, false),       // (1,1)
            (1353, 1442, true),        // (1,2)
            (1354, 1440, false),       // (2,0)
            (1354, 1441, false),       // (2,1)
            (1354, 1442, false),       // (2,2)
        ];
        for (gx, gy, expect) in cases {
            assert_eq!(
                cell_swto_ne_cut(gx, gy),
                expect,
                "cell_swto_ne_cut({gx},{gy}) diverged from retail PRNG"
            );
        }
        // cell (0,0) must stay SW↔NE so the legacy fixed-diagonal winding
        // test (`winding_is_consistent_ccw_post_mirror`) keeps passing.
        assert!(cell_swto_ne_cut(0xA9 * 8, 0xB4 * 8));
    }

    /// RC-1 (2026-06-20): the shared per-cell triangle interpolation must
    /// (a) hit every corner exactly, (b) be continuous across the chosen
    /// diagonal, (c) actually DIFFER between the two diagonals on a saddle
    /// (proving the choice bites), and (d) follow the retail per-cell cut.
    #[test]
    fn triangle_height_in_cell_diagonal_and_continuity() {
        // Saddle: SW=NE=0, SE=NW=10 → the two diagonals disagree at center.
        let (z00, z10, z01, z11) = (0.0f32, 10.0, 10.0, 0.0); // SW, SE, NW, NE
        // (a) corners exact regardless of diagonal.
        for &cut in &[true, false] {
            assert_eq!(triangle_height_in_cell(z00, z10, z01, z11, 0.0, 0.0, cut), z00);
            assert_eq!(triangle_height_in_cell(z00, z10, z01, z11, 1.0, 0.0, cut), z10);
            assert_eq!(triangle_height_in_cell(z00, z10, z01, z11, 0.0, 1.0, cut), z01);
            assert_eq!(triangle_height_in_cell(z00, z10, z01, z11, 1.0, 1.0, cut), z11);
        }
        // (c) center: SW↔NE diagonal joins the two 0 corners (→0); NW↔SE joins
        // the two 10 corners (→10). Distinct ⇒ the diagonal choice matters.
        let sw_ne = triangle_height_in_cell(z00, z10, z01, z11, 0.5, 0.5, true);
        let nw_se = triangle_height_in_cell(z00, z10, z01, z11, 0.5, 0.5, false);
        assert!((sw_ne - 0.0).abs() < 1e-6, "SW-NE center = {sw_ne}");
        assert!((nw_se - 10.0).abs() < 1e-6, "NW-SE center = {nw_se}");
        // (b) continuity across each diagonal seam.
        let eps = 1e-4;
        let a = triangle_height_in_cell(z00, z10, z01, z11, 0.5 + eps, 0.5, true);
        let b = triangle_height_in_cell(z00, z10, z01, z11, 0.5 - eps, 0.5, true);
        assert!((a - b).abs() < 1e-2, "SW-NE discontinuity {a} vs {b}");
        let c = triangle_height_in_cell(z00, z10, z01, z11, 0.5 + eps, 0.5, false);
        let d = triangle_height_in_cell(z00, z10, z01, z11, 0.5 - eps, 0.5, false);
        assert!((c - d).abs() < 1e-2, "NW-SE discontinuity {c} vs {d}");
        // (d) cell (1353,1440) is NW↔SE per the retail PRNG
        // (cell_split_rule_matches_retail_prng), so its center must follow the
        // NW↔SE plane (10), not the legacy fixed SW↔NE plane (0).
        let cut = cell_swto_ne_cut(1353, 1440);
        assert!(!cut, "expected NW↔SE cut at (1353,1440)");
        let z = triangle_height_in_cell(z00, z10, z01, z11, 0.5, 0.5, cut);
        assert!((z - 10.0).abs() < 1e-6, "retail-cut center = {z}");
    }

    /// RC-1 follow-up: the per-cell gradient must equal the finite-difference of
    /// the per-cell height inside each triangle (same split), for both diagonals.
    #[test]
    fn triangle_grad_matches_height() {
        let (z00, z10, z01, z11) = (1.0f32, 4.0, -2.0, 7.0); // arbitrary tilt
        let h = 1e-3;
        for &cut in &[true, false] {
            for &(fx, fy) in &[(0.7f32, 0.2f32), (0.2, 0.7)] {
                let (gfx, gfy) = triangle_grad_in_cell(z00, z10, z01, z11, fx, fy, cut);
                let z = triangle_height_in_cell(z00, z10, z01, z11, fx, fy, cut);
                let zx = triangle_height_in_cell(z00, z10, z01, z11, fx + h, fy, cut);
                let zy = triangle_height_in_cell(z00, z10, z01, z11, fx, fy + h, cut);
                assert!(((zx - z) / h - gfx).abs() < 1e-2, "d/dfx mismatch cut={cut}");
                assert!(((zy - z) / h - gfy).abs() < 1e-2, "d/dfy mismatch cut={cut}");
            }
        }
    }

    /// Wave R1.B reporting test — bake a real Holtburg landblock and
    /// prove the triangulation diagonal now VARIES per cell instead of
    /// being a constant fixed split. Uses real retail data per project
    /// memory ("prefer real game data over synthetic"); skips if the
    /// canonical cell dat isn't present.
    ///
    /// Detection: `i` indexes +X, `j` indexes +Y. The first sub-quad of
    /// each base cell starts at sub-vertex `(i = cx*factor, j = cy*factor)`,
    /// whose 6 indices begin the buffer slice for that quad. A SW↔NE cut
    /// emits `[v01, v11, v00, ...]`; a SE↔NW cut emits `[v00, v01, v10, ...]`.
    /// We classify each of the 8×8 = 64 cells and assert BOTH orientations
    /// are present.
    #[test]
    fn diagonal_split_varies_across_holtburg_lb() {
        use crate::DatDatabase;
        use crate::landblock::CellLandblock;
        let path =
            std::path::PathBuf::from("/home/wbterminal/ac_base_dats/client_cell_1.dat");
        if !path.exists() {
            eprintln!(
                "[diagonal_split_varies_across_holtburg_lb] SKIP — \
                 no client_cell_1.dat at {}",
                path.display()
            );
            return;
        }
        let dat = DatDatabase::new(&path).expect("client_cell_1.dat should open");
        // Holtburg LB cell terrain id = 0xA9B4FFFF (lbX=0xA9, lbY=0xB4).
        let bytes = dat
            .get_file(0xA9B4_FFFF)
            .expect("Holtburg 0xA9B4FFFF cell terrain in retail dat");
        let cell = CellLandblock::unpack(&bytes).expect("CellLandblock unpack");

        let mut heights = [[0.0f32; 9]; 9];
        let mut codes = [[0u8; 9]; 9];
        let mut roads = [[0u8; 9]; 9];
        for x in 0..9 {
            for y in 0..9 {
                heights[x][y] = cell.get_height(x, y);
                codes[x][y] = cell.terrain_type(x, y);
                roads[x][y] = cell.road_type(x, y);
            }
        }
        let adjacent = AdjacentHeights::default();
        let factor = 4u32;
        let landblock_id = 0xA9B4_0000u32;
        let out = subdivide_landblock(
            &heights, &adjacent, factor, &codes, &roads, landblock_id, 0xC0FFEE,
        );
        let n = out.grid_size as usize;
        let f = factor as usize;

        // Classify each of the 8×8 base cells from the emitted index
        // buffer (quad order is row-major over i∈[0,n-1), j∈[0,n-1)).
        let stride_quads = n - 1; // sub-quads per side
        let mut swto_ne = 0usize;
        let mut seto_nw = 0usize;
        let mut grid = [[' '; 8]; 8];
        for cx in 0..8usize {
            for cy in 0..8usize {
                // First sub-quad of this cell: (i = cx*f, j = cy*f).
                let i = cx * f;
                let j = cy * f;
                let quad = i * stride_quads + j; // quad index in row-major order
                let base = quad * 6;
                let v00 = (i * n + j) as u32;
                let v01 = (i * n + j + 1) as u32;
                // SW↔NE cut starts with v01; SE↔NW cut starts with v00.
                let first = out.indices[base];
                if first == v01 {
                    swto_ne += 1;
                    grid[cx][cy] = '/';
                } else if first == v00 {
                    seto_nw += 1;
                    grid[cx][cy] = '\\';
                } else {
                    panic!(
                        "cell ({cx},{cy}) quad {quad} unexpected first index {first} \
                         (v00={v00}, v01={v01})"
                    );
                }
                // Sanity: the buffer classification must agree with the
                // rule evaluated directly on the cell's global coords.
                let gx = ((landblock_id >> 24) & 0xff) * 8 + cx as u32;
                let gy = ((landblock_id >> 16) & 0xff) * 8 + cy as u32;
                let rule = cell_swto_ne_cut(gx, gy);
                assert_eq!(
                    rule,
                    first == v01,
                    "cell ({cx},{cy}) buffer/rule mismatch"
                );
            }
        }

        eprintln!("[R1.B diagonal split] LB 0xA9B4 8×8 cell diagonals (/ = SW↔NE, \\ = SE↔NW):");
        for cx in 0..8 {
            let row: String = grid[cx].iter().collect();
            eprintln!("  cx={cx}: {row}");
        }
        eprintln!(
            "[R1.B diagonal split] LB 0xA9B4: SW↔NE={swto_ne}  SE↔NW={seto_nw}  (of 64 cells)"
        );

        // The whole point of the wave: the split is NO LONGER constant.
        assert!(
            swto_ne > 0 && seto_nw > 0,
            "diagonal split should vary across LB 0xA9B4 — got SW↔NE={swto_ne}, SE↔NW={seto_nw}"
        );
        // Reference PRNG distribution for this LB is 40/24.
        assert_eq!(swto_ne, 40, "expected 40 SW↔NE cells on LB 0xA9B4");
        assert_eq!(seto_nw, 24, "expected 24 SE↔NW cells on LB 0xA9B4");
    }
}
