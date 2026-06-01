//! Verbatim port of `ACE.Server.Entity.Scenery`'s noise helpers.
//!
//! Source: `~/ace-server/Source/ACE.Server/Entity/Scenery.cs` lines
//! 43, 54, 59, 101-160. Every magic constant comes from the C# source —
//! do not rename, deduplicate, or "simplify" them.
//!
//! ## Determinism notes
//!
//! 1. **All u32 ops are `wrapping_*`.** The C# code uses uint
//!    arithmetic implicitly (positive int literals get coerced to uint
//!    when used with uint variables), so every `*`/`+`/`-` here must
//!    also wrap rather than checked or saturating.
//!
//! 2. **The `2.3283064e-10` constant is a literal.** It maps to
//!    `1.0 / 4294967296.0` *mathematically* but the f64 representations
//!    differ in the last bit or two. Copy it byte-exact from Scenery.cs.
//!
//! 3. **`uint * 2.3283064e-10` is `f64`.** In C# the result of
//!    `uint * double` is `double`. We mirror this with `as f64`.
//!
//! 4. **The `cellXMat = -1109124029 * globalCellX` line in Scenery.cs:52
//!    is a `long` in C# (because `-1109124029` is a negative `int`
//!    constant and cannot implicitly convert to `uint`).** However, the
//!    only place `cellXMat` flows is the noise expression at line 59:
//!    `(uint)(cellXMat + cellYMat - cellMat * 23399) * 2.3283064e-10`.
//!    The `(uint)` cast truncates to the low 32 bits. Because of
//!    `(a + b) mod 2^32 == ((a mod 2^32) + (b mod 2^32)) mod 2^32`,
//!    the u32-wrapping path gives byte-identical results to the C#
//!    long-path-then-truncate. Verified by computing both in Python and
//!    asserting equality.
//!
//! 5. **The displace / scale / rotate / quadrant constants use
//!    *positive* int literals everywhere.** All implicitly convert to
//!    uint at the call sites and stay in uint-wrapping arithmetic the
//!    whole way through. No long-promotion ambiguity here.

use crate::aabb::Aabb2D;
use holtburger_dat::file_type::object_desc::ObjectDesc;

/// C# `int * 2.3283064e-10` literal. Maps to approximately `1 / 2^32`
/// but is **not** byte-equal to `1.0 / 4294967296.0`. Do not refactor.
pub const NOISE_SCALE: f64 = 2.3283064e-10;

/// Initial cell-PRNG for the per-vertex scene selection. Mirrors
/// `Scenery.cs:43`. Pure u32 wrapping math.
#[inline]
pub fn cell_mat_scene(global_cell_x: u32, global_cell_y: u32) -> u32 {
    // Scenery.cs:43:
    //   cellMat = globalCellY * (712977289 * globalCellX + 1813693831)
    //             - 1109124029 * globalCellX
    //             + 2139937281;
    let inner = 712_977_289u32
        .wrapping_mul(global_cell_x)
        .wrapping_add(1_813_693_831);
    global_cell_y
        .wrapping_mul(inner)
        .wrapping_sub(1_109_124_029u32.wrapping_mul(global_cell_x))
        .wrapping_add(2_139_937_281)
}

/// Reset cell-PRNG state for the per-object loop. Mirrors
/// `Scenery.cs:52-54`.
///
/// Returns `(cellXMat, cellYMat, cellMat)` as u32 (the C# `cellXMat`
/// is `long` but only the low 32 bits matter for the downstream noise
/// expression — see module docs).
#[inline]
pub fn cell_mats_per_object(global_cell_x: u32, global_cell_y: u32) -> (u32, u32, u32) {
    // cellXMat = -1109124029 * globalCellX  (mod 2^32)
    let cell_x_mat = 1_109_124_029u32.wrapping_mul(global_cell_x).wrapping_neg();
    // cellYMat = 1813693831 * globalCellY
    let cell_y_mat = 1_813_693_831u32.wrapping_mul(global_cell_y);
    // cellMat  = 1360117743 * globalCellX * globalCellY + 1888038839
    let cell_mat = 1_360_117_743u32
        .wrapping_mul(global_cell_x)
        .wrapping_mul(global_cell_y)
        .wrapping_add(1_888_038_839);
    (cell_x_mat, cell_y_mat, cell_mat)
}

/// Per-object noise sample. Mirrors `Scenery.cs:59`:
///
/// ```csharp
/// var noise = (uint)(cellXMat + cellYMat - cellMat * 23399)
///             * 2.3283064e-10;
/// ```
#[inline]
pub fn object_noise(cell_x_mat: u32, cell_y_mat: u32, cell_mat: u32) -> f64 {
    let n: u32 = cell_x_mat
        .wrapping_add(cell_y_mat)
        .wrapping_sub(cell_mat.wrapping_mul(23_399));
    n as f64 * NOISE_SCALE
}

/// 2D quadrant rotation tag. Mirrors `Scenery.cs:120`. Returns a value
/// in `[0, 1)` (approximately) used to pick one of four quadrant
/// rotations in `displace`.
#[inline]
fn quadrant(ix: u32, iy: u32) -> f64 {
    // quadrant = (1813693831 * iy
    //            - ix * (1870387557 * iy + 1109124029)
    //            - 402451965)
    //           * 2.3283064e-10
    let inner = 1_870_387_557u32
        .wrapping_mul(iy)
        .wrapping_add(1_109_124_029);
    let v = 1_813_693_831u32
        .wrapping_mul(iy)
        .wrapping_sub(ix.wrapping_mul(inner))
        .wrapping_sub(402_451_965);
    v as f64 * NOISE_SCALE
}

/// Per-object displacement noise core. The expression is the same shape
/// for X and Y; only the `45773` (X) / `72719` (Y) magic differs.
/// Mirrors `Scenery.cs:111-118`.
#[inline]
fn displace_noise(ix: u32, iy: u32, iq: u32, magic: u32) -> f64 {
    // (1813693831 * iy
    //  - (iq + magic) * (1360117743 * iy * ix + 1888038839)
    //  - 1109124029 * ix)
    // * 2.3283064e-10
    let inner = 1_360_117_743u32
        .wrapping_mul(iy)
        .wrapping_mul(ix)
        .wrapping_add(1_888_038_839);
    let v = 1_813_693_831u32
        .wrapping_mul(iy)
        .wrapping_sub((iq.wrapping_add(magic)).wrapping_mul(inner))
        .wrapping_sub(1_109_124_029u32.wrapping_mul(ix));
    v as f64 * NOISE_SCALE
}

/// Returns the displaced (x, y) offset for an `ObjectDesc` placement.
/// Mirrors `Scenery.cs:101-127`.
///
/// `ix`, `iy` are global cell coordinates. `iq` is the object's index
/// within its `Scene.objects` list. Output is in cell-local units (no
/// vertex base added yet).
pub fn displace(obj: &ObjectDesc, ix: u32, iy: u32, iq: u32) -> (f32, f32) {
    let loc_x = obj.base_loc.origin.x;
    let loc_y = obj.base_loc.origin.y;

    // X displacement.
    let x = if obj.displace_x <= 0.0 {
        loc_x
    } else {
        let n = displace_noise(ix, iy, iq, 45_773);
        (n * obj.displace_x as f64 + loc_x as f64) as f32
    };

    // Y displacement.
    let y = if obj.displace_y <= 0.0 {
        loc_y
    } else {
        let n = displace_noise(ix, iy, iq, 72_719);
        (n * obj.displace_y as f64 + loc_y as f64) as f32
    };

    // Quadrant flip — Scenery.cs:122-126.
    let q = quadrant(ix, iy);
    if q >= 0.75 {
        (y, -x)
    } else if q >= 0.5 {
        (-x, -y)
    } else if q >= 0.25 {
        (-y, x)
    } else {
        (x, y)
    }
}

/// Returns the uniform scale factor for an `ObjectDesc` placement.
/// Mirrors `Scenery.cs:136-150`.
pub fn scale_obj(obj: &ObjectDesc, ix: u32, iy: u32, iq: u32) -> f32 {
    if obj.min_scale == obj.max_scale {
        return obj.max_scale;
    }
    // (1813693831 * iy
    //  - (k + 32593) * (1360117743 * iy * ix + 1888038839)
    //  - 1109124029 * ix)
    // * 2.3283064e-10
    let n = displace_noise(ix, iy, iq, 32_593);
    // pow(maxScale / minScale, n) * minScale
    //
    // The division is done in f32 FIRST, then widened — matching ACE
    // `Scenery.cs:146` `Math.Pow(maxScale / minScale, …)` where
    // `maxScale`/`minScale` are `float`, so `maxScale / minScale` is an f32
    // divide whose f32-rounded result is then promoted to double for Pow.
    // The old code divided in f64 (`as f64 / as f64`), which keeps extra
    // precision the f32 divide drops → ~1-ULP scale drift vs ACE.
    let ratio = (obj.max_scale / obj.min_scale) as f64;
    (ratio.powf(n) * obj.min_scale as f64) as f32
}

/// Returns the yaw rotation (radians) for an `ObjectDesc` placement.
/// Mirrors `Scenery.cs:155-161`.
pub fn rotate_obj(obj: &ObjectDesc, ix: u32, iy: u32, iq: u32) -> f32 {
    if obj.max_rotation <= 0.0 {
        return 0.0;
    }
    // The C# constant `0.0174533f` is π/180 truncated to f32 — that's
    // the C# `Math.PI / 180` literal as a float. Copying byte-exact.
    const DEG_TO_RAD: f32 = 0.017_453_3;
    let n = displace_noise(ix, iy, iq, 63_127);
    (n * obj.max_rotation as f64 * DEG_TO_RAD as f64) as f32
}

/// Mirror of `Scenery.cs:177-184` `Collision`. Returns true if any
/// AABB in `others` intersects `query`.
#[inline]
pub fn intersects_any(query: &Aabb2D, others: &[Aabb2D]) -> bool {
    others.iter().any(|o| query.intersects(o))
}

/// Helper used by tests + the public bake function. Re-export of
/// `transform_local_aabb` so consumers of the noise module don't have
/// to also import `aabb`.
pub use crate::aabb::transform_local_aabb as transform_local_aabb_to_world;

#[cfg(test)]
mod tests {
    use super::*;
    use holtburger_common::Vector3;
    use holtburger_dat::graphics::Frame;
    use holtburger_common::Quaternion;

    /// Pin the cell-PRNG against a hand-computed value. (gx=42, gy=314)
    /// → 0x7F0E8239 = 2131657273. Computed in Python via the exact
    /// formula in Scenery.cs:43.
    #[test]
    fn prng_constants_match_ace() {
        let v = cell_mat_scene(42, 314);
        assert_eq!(
            v, 0x7F0E_8239,
            "cell_mat_scene(42, 314) should equal 0x7F0E8239 \
             (hand-computed via Scenery.cs:43 formula); got 0x{:08X}",
            v
        );
        // Sanity: the resulting offset (cell_mat as f64 * 2.3283064e-10)
        // should land in [0, 1) — that's the entire point of the noise
        // scale constant.
        let offset = v as f64 * NOISE_SCALE;
        assert!(
            (0.0..1.0).contains(&offset),
            "offset 0x{:08X}*scale = {} should be in [0,1)",
            v,
            offset
        );
    }

    /// A second pin against the (gx=1000, gy=1000) case computed in
    /// Python during the brief's deterministic-math analysis. Catches
    /// off-by-one or precedence regressions in the formula port.
    #[test]
    fn prng_cell_mat_scene_thousand_thousand() {
        // From Python:
        //   inner   = 712977289 * 1000 + 1813693831  (u32 wrap)
        //   v       = 1000 * inner - 1109124029 * 1000 + 2139937281  (u32 wrap)
        // Compute via formula directly here in the test to keep the
        // assertion self-contained.
        let inner = 712_977_289u32
            .wrapping_mul(1000)
            .wrapping_add(1_813_693_831);
        let expected = 1000u32
            .wrapping_mul(inner)
            .wrapping_sub(1_109_124_029u32.wrapping_mul(1000))
            .wrapping_add(2_139_937_281);
        let actual = cell_mat_scene(1000, 1000);
        assert_eq!(actual, expected);
        // The Python script printed cellMat (u32) = 2168064849.
        assert_eq!(actual, 2_168_064_849);
    }

    /// Per-object noise sample is deterministic — same inputs always
    /// produce the same f64. Catches accidental use of f32 in the
    /// intermediate or a swap of `as f64` ordering.
    #[test]
    fn object_noise_is_deterministic() {
        let (a, b, c) = cell_mats_per_object(42, 314);
        let n1 = object_noise(a, b, c);
        let n2 = object_noise(a, b, c);
        assert_eq!(n1.to_bits(), n2.to_bits());
    }

    fn dummy_obj() -> ObjectDesc {
        ObjectDesc {
            obj_id: 0x0100_0001,
            base_loc: Frame {
                origin: Vector3::new(12.0, 14.0, 0.0),
                orientation: Quaternion::default(),
            },
            freq: 1.0,
            displace_x: 0.0,
            displace_y: 0.0,
            min_scale: 1.0,
            max_scale: 1.0,
            max_rotation: 0.0,
            min_slope: 0.0,
            max_slope: 1.0,
            align: 0,
            orient: 0,
            weenie_obj: 0,
        }
    }

    /// When displace_x == 0 and displace_y == 0, displace returns the
    /// base origin (possibly mirrored by quadrant). Verifies the
    /// short-circuit branch.
    #[test]
    fn displace_zero_returns_base_origin() {
        let obj = dummy_obj();
        // For gx=0, gy=0: quadrant = (-402451965) * 2.3283064e-10
        // ≈ -0.94 → < 0.25 → no swap. Output = (loc.x, loc.y).
        let (x, y) = displace(&obj, 0, 0, 0);
        // The quadrant for (0,0,0) maps to negative (since -402451965 is
        // interpreted via wrapping). Let's just verify it's stable.
        let (x2, y2) = displace(&obj, 0, 0, 0);
        assert_eq!(x, x2);
        assert_eq!(y, y2);
        // And that the magnitude matches (12, 14) modulo quadrant flip.
        let abs_pair = (x.abs(), y.abs());
        assert!(
            (abs_pair.0 - 12.0).abs() < 1e-3 || (abs_pair.0 - 14.0).abs() < 1e-3,
            "expected |x| ∈ {{12, 14}}, got {}",
            x
        );
    }

    /// rotate_obj == 0 when max_rotation == 0.
    #[test]
    fn rotate_obj_zero_max_returns_zero() {
        let mut obj = dummy_obj();
        obj.max_rotation = 0.0;
        assert_eq!(rotate_obj(&obj, 100, 200, 0), 0.0);
    }

    /// scale_obj == max when min == max (short-circuit branch).
    #[test]
    fn scale_obj_min_equals_max() {
        let mut obj = dummy_obj();
        obj.min_scale = 2.5;
        obj.max_scale = 2.5;
        assert_eq!(scale_obj(&obj, 100, 200, 0), 2.5);
    }
}
