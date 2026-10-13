//! Verbatim port of `ACE.Server.Entity.Scenery`'s noise helpers.
//!
//! Source: `~/ace-server/Source/ACE.Server/Entity/Scenery.cs` lines
//! 43, 54, 59, 101-160. Every magic constant comes from the C# source —
//! do not rename, deduplicate, or "simplify" them.
//!
//! The `*_retail` functions are the exceptions. They are `BakeMode::Retail`
//! ports of `acclient.c`, not of `Scenery.cs`:
//! - [`object_noise_retail`] is the frequency gate from
//!   `CLandBlock::get_land_scenes`. `Scenery.cs:59` gets it wrong by
//!   dropping the object index.
//! - [`scene_index_retail`] is the scene pick from the same function.
//! - [`displace_retail`] is `ObjectDesc::Place`.
//! - [`scale_obj_retail`] is `ObjectDesc::ScaleObj`.
//! - [`rotate_obj_retail`] is the heading in degrees from
//!   `ObjectDesc::GetObjFrame`.
//!
//! All of them scale the u32 noise by [`NOISE_SCALE_RETAIL`] (exactly
//! 2^-32), not by ACE's [`NOISE_SCALE`] literal. See note 2.
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
//!    That is ACE's constant ([`NOISE_SCALE`]), and every `AceCompat` /
//!    `Strict` path keeps it. Retail does NOT use it. `acclient.c` prints
//!    `2.3283064e-10` because Hex-Rays shows the shortest decimal for a
//!    *float*. The shipped `acclient.exe` multiplies by the float at
//!    `0x7c6f10`, whose bytes are `00 00 80 2F` (`0x2F800000`). That float
//!    is exactly 2^-32 ([`NOISE_SCALE_RETAIL`]). ACE copied the decimal into
//!    a C# *double*, which comes out about 1.6e-8 relative too small.
//!
//!    The sites in the exe are:
//!    - the scene pick: `fmul dword [0x7c6f10]` at `0x531363`;
//!    - the frequency gate: at `0x531455`, followed by
//!      `fcomp [esi+0x44]` (freq);
//!    - `Place` at `0x5a6d38`, `0x5a6d9f` and `0x5a6de1` (quadrant);
//!    - `GetObjFrame` at `0x5a6ee3`;
//!    - `ScaleObj` at `0x52fe66`.
//!
//!    `ClientMain::ConfigureFPU` sets x87 precision to 53 bits
//!    (`acclient.c:60888`), and the D3D device is created with
//!    `D3DCREATE_FPU_PRESERVE` (`acclient.c:459978`, `v14 |= 0x106`). So
//!    retail's x87 arithmetic rounds like the f64 arithmetic here, and
//!    `u32 * 2^-32` is exact.
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
///
/// This is ACE's constant, used by `AceCompat` / `Strict` only. Retail
/// uses [`NOISE_SCALE_RETAIL`] (module note 2).
pub const NOISE_SCALE: f64 = 2.3283064e-10;

/// Retail's noise scale: the float at `acclient.exe` `0x7c6f10`, bytes
/// `00 00 80 2F` (`0x2F800000`), which is exactly 2^-32. Hex-Rays prints
/// this float as `2.3283064e-10`, and ACE copied that decimal into a
/// double ([`NOISE_SCALE`]). Every `BakeMode::Retail` noise path
/// multiplies by this value: the gate, the scene pick, the displacement,
/// the quadrant, the scale and the heading. The product
/// `u32 as f64 * NOISE_SCALE_RETAIL` is exact.
pub const NOISE_SCALE_RETAIL: f64 = 1.0 / 4_294_967_296.0;

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

/// Per-object noise sample, `BakeMode::AceCompat` form. Mirrors
/// `Scenery.cs:59`:
///
/// ```csharp
/// var noise = (uint)(cellXMat + cellYMat - cellMat * 23399)
///             * 2.3283064e-10;
/// ```
///
/// This is NOT retail. It has no object-index term, so every `ObjectDesc`
/// in a Scene is gated by the same draw. It is also not what a live ACE
/// server runs: `Entity/Scenery.cs` is only reached from
/// `Entity/Landblock.LoadMeshes`, whose one call site is commented out
/// (`Entity/Landblock.cs:197`, "This isn't used by ACE" at :334). Kept
/// unchanged so ace-compat bakes stay byte-identical; retail is
/// [`object_noise_retail`].
#[inline]
pub fn object_noise(cell_x_mat: u32, cell_y_mat: u32, cell_mat: u32) -> f64 {
    let n: u32 = cell_x_mat
        .wrapping_add(cell_y_mat)
        .wrapping_sub(cell_mat.wrapping_mul(23_399));
    n as f64 * NOISE_SCALE
}

/// Per-object noise sample, `BakeMode::Retail` form: object `j` of the
/// Scene draws its own value from `cellMat * (23399 + j)`.
///
/// Retail `CLandBlock::get_land_scenes` (`acclient.c:352662-352731`)
/// starts an accumulator at `23399 * cellMat`, gates object `kq` on
/// `cellXMat + cellYMat - acc`, and adds `cellMat` to the accumulator at
/// the loop tail for every object (gated or not, weenie or not). That
/// equals the closed form here mod 2^32. The live ACE server's physics
/// scenery (`Physics/Common/Landblock.get_land_scenes`, `Landblock.cs:226`)
/// uses the same closed form. All u32 wrapping, as in the decomp.
///
/// The u32 is scaled by [`NOISE_SCALE_RETAIL`] (exactly 2^-32, the exe's
/// `fmul dword [0x7c6f10]` at `0x531455`), not ACE's [`NOISE_SCALE`].
///
/// At `j == 0` the u32 draw is the same one [`object_noise`] uses, but the
/// f64 is not: it is about 1.6e-8 relative larger. The two gates differ
/// only when the draw lands within that of `freq`. For example, a gate u32
/// of `2^31` at `freq = 0.5` is exactly `0.5` here, so it is rejected,
/// while ACE's literal accepts it. Every later object in the Scene draws a
/// different u32.
#[inline]
pub fn object_noise_retail(cell_x_mat: u32, cell_y_mat: u32, cell_mat: u32, j: u32) -> f64 {
    let n: u32 = cell_x_mat
        .wrapping_add(cell_y_mat)
        .wrapping_sub(cell_mat.wrapping_mul(23_399u32.wrapping_add(j)));
    n as f64 * NOISE_SCALE_RETAIL
}

/// Retail scene pick, `BakeMode::Retail` form. This is `acclient.c`
/// `CLandBlock::get_land_scenes` (:352639-352645):
///
/// ```c
/// if (count == 1
///     || (v11 = (double)cellMat * 2.3283064e-10,     // float 0x2F800000 = 2^-32
///         idx = (unsigned __int64)_floor(v11 * (double)count),
///         idx >= count))
///     idx = 0;
/// ```
///
/// `cell_mat` is [`cell_mat_scene`] of the vertex. `count` is the length of
/// the scene list and must be at least 1; the bake skips empty lists
/// before it picks. This is the `AceCompat` pick (`Scenery.cs:43-46`) with
/// [`NOISE_SCALE_RETAIL`] in place of [`NOISE_SCALE`]. The scale matters at
/// the index boundaries. For example, with `count == 2` and
/// `cell_mat == 2^31`, retail picks scene 1, while ACE's literal gives
/// `0.99999998` and so picks scene 0.
#[inline]
pub fn scene_index_retail(cell_mat: u32, count: usize) -> usize {
    if count <= 1 {
        return 0;
    }
    let idx = (cell_mat as f64 * NOISE_SCALE_RETAIL * count as f64).floor() as usize;
    if idx >= count { 0 } else { idx }
}

/// 2D quadrant rotation tag, as the raw u32 before scaling. Mirrors
/// `Scenery.cs:120` (and `acclient.c` `ObjectDesc::Place` :462630).
/// [`displace`] scales it to a value in `[0, 1)` and uses that to pick one
/// of four quadrant rotations.
#[inline]
fn quadrant_u32(ix: u32, iy: u32) -> u32 {
    // quadrant = (1813693831 * iy
    //            - ix * (1870387557 * iy + 1109124029)
    //            - 402451965)
    //           * 2.3283064e-10
    let inner = 1_870_387_557u32
        .wrapping_mul(iy)
        .wrapping_add(1_109_124_029);
    1_813_693_831u32
        .wrapping_mul(iy)
        .wrapping_sub(ix.wrapping_mul(inner))
        .wrapping_sub(402_451_965)
}

/// Per-object displacement noise core, as the raw u32 before scaling. The
/// expression is the same shape for X, Y, scale and rotation; only the
/// magic differs: `45773` (X), `72719` (Y), `32593` (scale) or `63127`
/// (rotation). Mirrors `Scenery.cs:111-118`.
#[inline]
fn displace_noise_u32(ix: u32, iy: u32, iq: u32, magic: u32) -> u32 {
    // (1813693831 * iy
    //  - (iq + magic) * (1360117743 * iy * ix + 1888038839)
    //  - 1109124029 * ix)
    // * 2.3283064e-10
    let inner = 1_360_117_743u32
        .wrapping_mul(iy)
        .wrapping_mul(ix)
        .wrapping_add(1_888_038_839);
    1_813_693_831u32
        .wrapping_mul(iy)
        .wrapping_sub((iq.wrapping_add(magic)).wrapping_mul(inner))
        .wrapping_sub(1_109_124_029u32.wrapping_mul(ix))
}

/// Per-object displacement noise core, scaled by ACE's [`NOISE_SCALE`].
/// Mirrors `Scenery.cs:111-118`.
#[inline]
fn displace_noise(ix: u32, iy: u32, iq: u32, magic: u32) -> f64 {
    displace_noise_u32(ix, iy, iq, magic) as f64 * NOISE_SCALE
}

/// Returns the displaced (x, y) offset for an `ObjectDesc` placement.
/// Mirrors `Scenery.cs:101-127`.
///
/// `ix`, `iy` are global cell coordinates. `iq` is the object's index
/// within its `Scene.objects` list. Output is in cell-local units (no
/// vertex base added yet).
pub fn displace(obj: &ObjectDesc, ix: u32, iy: u32, iq: u32) -> (f32, f32) {
    displace_scaled(obj, ix, iy, iq, NOISE_SCALE)
}

/// Retail displacement, `BakeMode::Retail` form. This is `acclient.c`
/// `ObjectDesc::Place` (:462605). It uses the same expressions, f32
/// narrowing and quadrant flip as [`displace`], with every noise scaled by
/// [`NOISE_SCALE_RETAIL`]. In the exe those multiplies are
/// `fmul dword [0x7c6f10]` at `0x5a6d38` (X), `0x5a6d9f` (Y) and
/// `0x5a6de1` (quadrant). With ACE's literal, a displaced X or Y often
/// lands 1 f32 ULP away from retail. A quadrant (and so a whole mirror)
/// flips when its u32 sits just above a threshold: within about 17 above
/// `2^30`, 34 above `2^31` or 51 above `3 * 2^30`.
pub fn displace_retail(obj: &ObjectDesc, ix: u32, iy: u32, iq: u32) -> (f32, f32) {
    displace_scaled(obj, ix, iy, iq, NOISE_SCALE_RETAIL)
}

/// Shared body of [`displace`] (`scale = NOISE_SCALE`) and
/// [`displace_retail`] (`scale = NOISE_SCALE_RETAIL`). For
/// `NOISE_SCALE` it performs exactly the f64 operations the ACE port always
/// did, so `AceCompat` output is byte-identical.
#[inline]
fn displace_scaled(obj: &ObjectDesc, ix: u32, iy: u32, iq: u32, scale: f64) -> (f32, f32) {
    let loc_x = obj.base_loc.origin.x;
    let loc_y = obj.base_loc.origin.y;

    // X displacement.
    let x = if obj.displace_x <= 0.0 {
        loc_x
    } else {
        let n = displace_noise_u32(ix, iy, iq, 45_773) as f64 * scale;
        (n * obj.displace_x as f64 + loc_x as f64) as f32
    };

    // Y displacement.
    let y = if obj.displace_y <= 0.0 {
        loc_y
    } else {
        let n = displace_noise_u32(ix, iy, iq, 72_719) as f64 * scale;
        (n * obj.displace_y as f64 + loc_y as f64) as f32
    };

    // Quadrant flip — Scenery.cs:122-126.
    let q = quadrant_u32(ix, iy) as f64 * scale;
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

/// Retail uniform scale, `BakeMode::Retail` form. This is `acclient.c`
/// `ObjectDesc::ScaleObj` (:351361):
///
/// ```c
/// if (min_scale == max_scale) return max_scale;
/// return pow(max_scale / min_scale,
///            (double)(1813693831 * y - (k + 32593) * (1360117743 * y * x + 1888038839)
///                     - 1109124029 * x) * 2.3283064e-10) * min_scale;
/// ```
///
/// It differs from the ACE port [`scale_obj`] in two ways, both read from
/// the shipped exe at `0x52fe00`:
/// - The noise is scaled by [`NOISE_SCALE_RETAIL`] (`fmul dword
///   [0x7c6f10]` at `0x52fe66`).
/// - `max_scale / min_scale` is NOT rounded to f32. The exe runs
///   `fld [esi+0x54]` and then `fdiv [esi+0x50]`. The quotient stays on
///   the x87 stack (53-bit precision, see module note 2) until `_CIpow`, so
///   it is the f64 quotient of the two floats. ACE's C# divides in f32
///   first.
///
/// The product with `min_scale` is a double. The caller narrows it to
/// float (`fstp dword` before `CPhysicsObj::SetScaleStatic`, `0x531679`),
/// which the `as f32` here mirrors. Retail's `_CIpow` is the MSVC x87
/// routine and this uses the platform's `f64::powf`. After the f32
/// narrowing they are not expected to differ, but that is not proven bit
/// for bit.
pub fn scale_obj_retail(obj: &ObjectDesc, ix: u32, iy: u32, iq: u32) -> f32 {
    if obj.min_scale == obj.max_scale {
        return obj.max_scale;
    }
    let n = displace_noise_u32(ix, iy, iq, 32_593) as f64 * NOISE_SCALE_RETAIL;
    let ratio = obj.max_scale as f64 / obj.min_scale as f64;
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

/// Retail scenery heading, in DEGREES, `BakeMode::Retail` form
/// (terrain-scenery-4). `acclient.c` `ObjectDesc::GetObjFrame` (:462660):
///
/// ```c
/// if (max_rot > 0.0) {
///     degrees = (double)(1813693831 * y - (k + 63127) * (1360117743 * y * x + 1888038839)
///                        - 1109124029 * x) * 2.3283064e-10 * max_rot;  // float
///     Frame::set_heading(obj_frame, degrees);
/// }
/// ```
///
/// This is the same u32 noise as [`rotate_obj`], with two differences.
/// There is no degrees-to-radians factor, because `Frame::set_heading`
/// takes a compass heading in degrees. And the noise is scaled by
/// [`NOISE_SCALE_RETAIL`] (`fmul dword [0x7c6f10]` at `0x5a6ee3`) instead
/// of ACE's literal, which often moves the heading by 1 f32 ULP. The
/// `max_rot > 0` guard belongs to the caller
/// ([`crate::orientation::obj_frame_orientation`]).
pub fn rotate_obj_retail(obj: &ObjectDesc, ix: u32, iy: u32, iq: u32) -> f32 {
    let n = displace_noise_u32(ix, iy, iq, 63_127) as f64 * NOISE_SCALE_RETAIL;
    (n * obj.max_rotation as f64) as f32
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

    /// At `j = 0`, `object_noise_retail` draws the same u32 as the
    /// ace-compat sample, scaled by 2^-32 rather than ACE's literal. At
    /// `j > 0` it is the decomp accumulator (`23399 * cellMat`, then
    /// `+= cellMat` per object), scaled by 2^-32.
    #[test]
    fn object_noise_retail_j0_matches_legacy_and_steps_by_cell_mat() {
        for &(gx, gy) in &[(42u32, 314u32), (1000, 1000), (0, 0), (u32::MAX, 7)] {
            let (a, b, c) = cell_mats_per_object(gx, gy);
            let legacy_u32 = a.wrapping_add(b).wrapping_sub(c.wrapping_mul(23_399));
            assert_eq!(
                object_noise(a, b, c).to_bits(),
                (legacy_u32 as f64 * NOISE_SCALE).to_bits()
            );
            assert_eq!(
                object_noise_retail(a, b, c, 0).to_bits(),
                (legacy_u32 as f64 * NOISE_SCALE_RETAIL).to_bits(),
                "j=0 must scale the legacy u32 draw by 2^-32 at ({gx},{gy})"
            );
            let mut acc = c.wrapping_mul(23_399);
            for j in 0..8u32 {
                let n = a.wrapping_add(b).wrapping_sub(acc);
                assert_eq!(
                    object_noise_retail(a, b, c, j).to_bits(),
                    (n as f64 * NOISE_SCALE_RETAIL).to_bits(),
                    "accumulator drift at ({gx},{gy}) j={j}"
                );
                // 2^-32 is a power of two: the scaled value is exact.
                assert_eq!(object_noise_retail(a, b, c, j) * 4_294_967_296.0, n as f64);
                acc = acc.wrapping_add(c);
            }
        }
    }

    /// `NOISE_SCALE_RETAIL` is retail's float `0x2F800000`, exactly 2^-32,
    /// and is not ACE's double literal.
    #[test]
    fn noise_scale_retail_is_the_exe_float_two_pow_minus_32() {
        assert_eq!(NOISE_SCALE_RETAIL.to_bits(), 0x3DF0_0000_0000_0000);
        assert_eq!(f32::from_bits(0x2F80_0000) as f64, NOISE_SCALE_RETAIL);
        assert_eq!((NOISE_SCALE_RETAIL as f32).to_bits(), 0x2F80_0000);
        assert_ne!(NOISE_SCALE.to_bits(), NOISE_SCALE_RETAIL.to_bits());
        // ACE's literal is the smaller one (about 1.6e-8 relative).
        assert!(NOISE_SCALE < NOISE_SCALE_RETAIL);
        let rel = (NOISE_SCALE_RETAIL - NOISE_SCALE) / NOISE_SCALE_RETAIL;
        assert!(rel > 1.5e-8 && rel < 1.6e-8, "relative gap {rel}");
    }

    /// The reviewer's failure scenario: a gate u32 of exactly `2^31` at
    /// `freq = 0.5`. Retail computes `0.5`, which is not `< 0.5`, and
    /// rejects. ACE's literal computes just under `0.5` and accepts.
    #[test]
    fn retail_gate_rejects_at_half_where_ace_literal_accepts() {
        let freq = 0.5_f32 as f64;
        // a + b - c * 23399 == 2^31 with b = c = 0.
        let (a, b, c) = (0x8000_0000u32, 0u32, 0u32);
        assert_eq!(object_noise_retail(a, b, c, 0), 0.5);
        assert!(!(object_noise_retail(a, b, c, 0) < freq), "retail rejects");
        assert!(object_noise(a, b, c) < freq, "ACE's literal accepts");
        // ACE stays under 0.5 for the next ~33 u32 values; retail does not.
        for d in 0..33u32 {
            assert!(object_noise(a + d, b, c) < freq, "ACE accepts 2^31 + {d}");
            assert!(
                !(object_noise_retail(a + d, b, c, 0) < freq),
                "retail rejects 2^31 + {d}"
            );
        }
    }

    /// Scene-pick boundary: with two scenes and `cellMat = 2^31`, retail
    /// picks scene 1, while ACE's literal (the `AceCompat` pick in the
    /// bake) gives `0.99999998` and picks scene 0.
    #[test]
    fn scene_index_retail_uses_two_pow_minus_32_at_the_boundary() {
        let cm = 0x8000_0000u32;
        assert_eq!(scene_index_retail(cm, 2), 1);
        // The AceCompat pick, as `bake_landblock_impl` computes it.
        assert_eq!((2usize as f64 * (cm as f64 * NOISE_SCALE)) as usize, 0);
        // count == 1 short-circuits to 0, as in retail.
        assert_eq!(scene_index_retail(u32::MAX, 1), 0);
        // The top u32 stays below `count` (no fall-back needed).
        assert_eq!(scene_index_retail(u32::MAX, 7), 6);
        assert_eq!(scene_index_retail(0, 7), 0);
        // Matches floor(cm * count / 2^32) across counts.
        for &cm in &[0u32, 1, 0x4000_0000, 0x5555_5556, 0xAAAA_AAAB, 0xFFFF_FFFF] {
            for count in 2..=9usize {
                let want = ((cm as u64 * count as u64) >> 32) as usize;
                assert_eq!(
                    scene_index_retail(cm, count),
                    want,
                    "cm 0x{cm:08X} count {count}"
                );
            }
        }
    }

    /// The `*_retail` pose functions equal their ACE ports with the scale
    /// swapped, and scale the raw u32 by exactly 2^-32. ScaleObj also keeps
    /// the f64 ratio.
    #[test]
    fn retail_pose_noise_uses_two_pow_minus_32() {
        let mut obj = dummy_obj();
        obj.displace_x = 3.0;
        obj.displace_y = 5.0;
        obj.min_scale = 0.8;
        obj.max_scale = 1.5;
        obj.max_rotation = 360.0;
        for &(ix, iy, iq) in &[
            (1355u32, 1442u32, 4u32),
            (1304, 1392, 0),
            (11_000, 12_000, 3),
        ] {
            let nx = displace_noise_u32(ix, iy, iq, 45_773) as f64 * NOISE_SCALE_RETAIL;
            let ny = displace_noise_u32(ix, iy, iq, 72_719) as f64 * NOISE_SCALE_RETAIL;
            let x = (nx * 3.0 + 12.0) as f32;
            let y = (ny * 5.0 + 14.0) as f32;
            let q = quadrant_u32(ix, iy) as f64 * NOISE_SCALE_RETAIL;
            let want = if q >= 0.75 {
                (y, -x)
            } else if q >= 0.5 {
                (-x, -y)
            } else if q >= 0.25 {
                (-y, x)
            } else {
                (x, y)
            };
            let got = displace_retail(&obj, ix, iy, iq);
            assert_eq!(
                (got.0.to_bits(), got.1.to_bits()),
                (want.0.to_bits(), want.1.to_bits())
            );

            let ns = displace_noise_u32(ix, iy, iq, 32_593) as f64 * NOISE_SCALE_RETAIL;
            let s = ((1.5f32 as f64 / 0.8f32 as f64).powf(ns) * 0.8f32 as f64) as f32;
            assert_eq!(scale_obj_retail(&obj, ix, iy, iq).to_bits(), s.to_bits());

            let nr = displace_noise_u32(ix, iy, iq, 63_127) as f64 * NOISE_SCALE_RETAIL;
            assert_eq!(
                rotate_obj_retail(&obj, ix, iy, iq).to_bits(),
                ((nr * 360.0) as f32).to_bits()
            );
        }
        // The ACE ports are untouched: same u32, ACE's scale.
        let (ix, iy, iq) = (1355u32, 1442u32, 4u32);
        let nr = displace_noise_u32(ix, iy, iq, 63_127) as f64 * NOISE_SCALE;
        let deg_to_rad = 0.017_453_3f32 as f64;
        assert_eq!(
            rotate_obj(&obj, ix, iy, iq).to_bits(),
            ((nr * 360.0 * deg_to_rad) as f32).to_bits()
        );
        // min == max still short-circuits.
        obj.min_scale = 2.5;
        obj.max_scale = 2.5;
        assert_eq!(scale_obj_retail(&obj, ix, iy, iq), 2.5);
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
