//! **Decomp-pinned golden-vector anchor for the scenery placement algorithm.**
//!
//! This is the *authoritative algorithm oracle* for AC's procedural
//! scenery PRNG + transform math. Every expected value in this file was
//! hand-computed from the **retail decompilation** (`acclient.c`
//! `CLandBlock::get_land_scenes` @ ~352530, `ObjectDesc::ScaleObj` @
//! ~351361, the displace/rotate/quadrant noise expressions) using the
//! exact magic constants listed below — NOT by running the Rust code and
//! capturing whatever it emitted, and NOT by diffing against the C#
//! `scenery-cross-check` port.
//!
//! Why this matters: today we validate the Rust bake against a C# port
//! of `ACE.Server.Entity.Scenery.Load`. Both ports descend from the same
//! retail algorithm, so a shared misreading of the decomp would pass that
//! check silently (circular dependence). The assertions here are pinned to
//! values computed *directly from the decomp constants* (reproduced in a
//! standalone Python transcription of `acclient.c`, cross-checked by
//! inlining the raw constants in-test — see [`lcg_recomputed_from_raw_decomp_constants`]).
//! Once this anchor is trusted, the C#-port-vs-Rust-port round-trip can
//! be retired in favour of "Rust port vs decomp golden".
//!
//! ## Decomp constants (verbatim from `acclient.c` / DECOMP brief)
//!
//! | name              | value          | role                                  |
//! |-------------------|----------------|---------------------------------------|
//! | NOISE_SCALE       | 2.3283064e-10  | u32 → \[0,1) normalizer (≈ 1/2^32)    |
//! | SCENE_SELECT_A    | 712977289      | scene-pick LCG inner mul              |
//! | SCENE_SELECT_B    | 1813693831     | scene-pick LCG inner add / y-mul      |
//! | SCENE_SELECT_C    | -1109124029    | scene-pick LCG x-mul                   |
//! | SCENE_SELECT_D    | 2139937281     | scene-pick LCG add                     |
//! | OBJECT_SELECT_C   | 1360117743     | per-object cellMat x*y mul            |
//! | OBJECT_SELECT_D   | 1888038839     | per-object cellMat add                 |
//! | OBJECT_SELECT_E   | 23399          | object-noise k                         |
//! | DISPLACE_X_MAGIC  | 45773          | displace-X k offset                    |
//! | DISPLACE_Y_MAGIC  | 72719          | displace-Y k offset                    |
//! | SCALE_MAGIC       | 32593          | scale k offset                         |
//! | ROTATION_MAGIC    | 63127          | rotation k offset                      |
//! | QUADRANT_B        | 1870387557     | quadrant iy mul                        |
//! | DEG_TO_RAD        | 0.017453303    | f32 π/180 (decomp literal)             |
//!
//! All u32 arithmetic **wraps** (C# `uint` / decomp `unsigned int`).
//!
//! ## Determinism contract
//!
//! Floating-point golden values are pinned **bit-exactly** via
//! `.to_bits()`. A `!= ` on the bits is a real regression, not a tolerance
//! drift — these functions must be reproducible to the last mantissa bit
//! across machines (the load-bearing property of the whole bake).

use holtburger_common::{Quaternion, Vector3};
use holtburger_dat::file_type::object_desc::ObjectDesc;
use holtburger_dat::graphics::Frame;
use holtburger_scenery_bake::{
    NOISE_SCALE, cell_mat_scene, cell_mats_per_object, displace, object_noise, rotate_obj,
    scale_obj,
};

// ----------------------------------------------------------------------
// Raw decomp constants — copied verbatim from the DECOMP brief so the
// recomputation in `lcg_recomputed_from_raw_decomp_constants` does not
// route through any production code path.
// ----------------------------------------------------------------------
const SCENE_SELECT_A: u32 = 712_977_289;
const SCENE_SELECT_B: u32 = 1_813_693_831;
const SCENE_SELECT_C_NEG: u32 = 1_109_124_029; // |SCENE_SELECT_C|; subtracted (== add of -C)
const SCENE_SELECT_D: u32 = 2_139_937_281;
const OBJECT_SELECT_C: u32 = 1_360_117_743;
const OBJECT_SELECT_D: u32 = 1_888_038_839;
const OBJECT_SELECT_E: u32 = 23_399;
const DISPLACE_X_MAGIC: u32 = 45_773;
const DISPLACE_Y_MAGIC: u32 = 72_719;
const QUADRANT_B: u32 = 1_870_387_557;
const QUADRANT_C: u32 = 1_109_124_029;
const QUADRANT_D_NEG: u32 = 402_451_965; // |QUADRANT_D| (-402451965); subtracted

// ----------------------------------------------------------------------
// Standalone decomp transcriptions. These reproduce the retail algorithm
// from the raw constants above, INDEPENDENT of `noise.rs`. They are what
// the production functions are pinned against — if a future "simplify"
// rewrites noise.rs and changes behaviour, these stay anchored to the
// decomp and the assertions catch the drift.
// ----------------------------------------------------------------------

/// `acclient.c` scene-pick LCG (mirrors Scenery.cs:43). Pure u32 wrap.
fn decomp_cell_mat_scene(gx: u32, gy: u32) -> u32 {
    let inner = SCENE_SELECT_A.wrapping_mul(gx).wrapping_add(SCENE_SELECT_B);
    gy.wrapping_mul(inner)
        .wrapping_sub(SCENE_SELECT_C_NEG.wrapping_mul(gx))
        .wrapping_add(SCENE_SELECT_D)
}

/// `acclient.c` per-object cellMat reset (mirrors Scenery.cs:52-54).
fn decomp_cell_mats(gx: u32, gy: u32) -> (u32, u32, u32) {
    let cell_x_mat = SCENE_SELECT_C_NEG.wrapping_mul(gx).wrapping_neg();
    let cell_y_mat = SCENE_SELECT_B.wrapping_mul(gy);
    let cell_mat = OBJECT_SELECT_C
        .wrapping_mul(gx)
        .wrapping_mul(gy)
        .wrapping_add(OBJECT_SELECT_D);
    (cell_x_mat, cell_y_mat, cell_mat)
}

/// `acclient.c` per-object noise sample (mirrors Scenery.cs:59).
fn decomp_object_noise(a: u32, b: u32, c: u32) -> f64 {
    let n = a.wrapping_add(b).wrapping_sub(c.wrapping_mul(OBJECT_SELECT_E));
    n as f64 * NOISE_SCALE
}

/// `acclient.c` displace/scale/rotate shared noise core. `magic` selects
/// the channel (45773 X, 72719 Y, 32593 scale, 63127 rotation).
fn decomp_displace_noise(ix: u32, iy: u32, iq: u32, magic: u32) -> f64 {
    let inner = OBJECT_SELECT_C
        .wrapping_mul(iy)
        .wrapping_mul(ix)
        .wrapping_add(OBJECT_SELECT_D);
    let v = SCENE_SELECT_B
        .wrapping_mul(iy)
        .wrapping_sub(iq.wrapping_add(magic).wrapping_mul(inner))
        .wrapping_sub(SCENE_SELECT_C_NEG.wrapping_mul(ix));
    v as f64 * NOISE_SCALE
}

/// `acclient.c` quadrant tag (mirrors Scenery.cs:120).
fn decomp_quadrant(ix: u32, iy: u32) -> f64 {
    let inner = QUADRANT_B.wrapping_mul(iy).wrapping_add(QUADRANT_C);
    let v = SCENE_SELECT_B
        .wrapping_mul(iy)
        .wrapping_sub(ix.wrapping_mul(inner))
        .wrapping_sub(QUADRANT_D_NEG);
    v as f64 * NOISE_SCALE
}

/// Convert a content LB hex (e.g. `0xA3AE`, byte layout `lbX:lbY`) plus a
/// local cell `(cx, cy)` into the global cell coords the noise functions
/// consume. `block_x = lbX*8`, `block_y = lbY*8` per Scenery.cs:21-22.
fn global_cell(lb: u16, cx: u32, cy: u32) -> (u32, u32) {
    let lb_x = ((lb >> 8) & 0xFF) as u32;
    let lb_y = (lb & 0xFF) as u32;
    (cx.wrapping_add(lb_x * 8), cy.wrapping_add(lb_y * 8))
}

/// Build an `ObjectDesc` that exposes the noise core through the public
/// `displace`/`scale_obj`/`rotate_obj` API with no extra scaling:
/// `displace_x = displace_y = 1.0`, origin `(0,0,0)` so the displaced
/// coordinate IS the raw `displace_noise` value (modulo quadrant flip).
fn probe_obj(displace_amt: f32, min_scale: f32, max_scale: f32, max_rotation: f32) -> ObjectDesc {
    ObjectDesc {
        obj_id: 0x0100_0001,
        base_loc: Frame {
            origin: Vector3::new(0.0, 0.0, 0.0),
            orientation: Quaternion::default(),
        },
        freq: 1.0,
        displace_x: displace_amt,
        displace_y: displace_amt,
        min_scale,
        max_scale,
        max_rotation,
        min_slope: 0.0,
        max_slope: 1.0,
        align: 0,
        orient: 0,
        weenie_obj: 0,
    }
}

// ======================================================================
// 1. LCG (scene-pick) — pinned to hand-computed hex from the decomp.
// ======================================================================

/// The scene-pick LCG, pinned to literal hex constants that were
/// hand-computed from the decomp formula in Python. These are the
/// authoritative anchor: any change to `cell_mat_scene` that shifts even
/// one bit fails here.
///
/// Hand-computed (Python transcription of acclient.c):
///   cell_mat_scene(42, 314)   = 0x7F0E_8239  (2_131_657_273)
///   cell_mat_scene(1000,1000) = 0x813A_0B51  (2_168_064_849)
///   cell_mat_scene(0, 0)      = 0x7F8C_DA01  (2_139_937_281 == SCENE_SELECT_D)
///   cell_mat_scene(1, 1)      = 0xD40A_E754  (3_557_484_372)
#[test]
fn lcg_scene_select_pinned_to_decomp_hex() {
    assert_eq!(cell_mat_scene(42, 314), 0x7F0E_8239, "lb-relative (42,314)");
    assert_eq!(cell_mat_scene(1000, 1000), 0x813A_0B51, "(1000,1000)");
    // gx=gy=0 collapses the LCG to exactly the additive constant D.
    assert_eq!(cell_mat_scene(0, 0), 0x7F8C_DA01);
    assert_eq!(cell_mat_scene(0, 0), SCENE_SELECT_D, "origin == add const D");
    assert_eq!(cell_mat_scene(1, 1), 0xD40A_E754, "(1,1)");
}

/// Independent cross-check: recompute the LCG *inline from the raw decomp
/// constants* (no production-code call) and assert the production
/// `cell_mat_scene` agrees across a sweep. This is what makes the anchor
/// non-circular — `decomp_cell_mat_scene` shares no code with `noise.rs`.
#[test]
fn lcg_recomputed_from_raw_decomp_constants() {
    for &(gx, gy) in &[
        (42u32, 314u32),
        (1000, 1000),
        (0, 0),
        (1, 1),
        (1304, 1392), // 0xA3AE cell (0,0)
        (1384, 1472), // 0xACB7 cell (8,8)
        (u32::MAX, 7),
        (7, u32::MAX), // wrap stress
    ] {
        assert_eq!(
            cell_mat_scene(gx, gy),
            decomp_cell_mat_scene(gx, gy),
            "cell_mat_scene drift from raw decomp at ({gx},{gy})"
        );
    }
    // And the hand-pinned hex must equal the inline recomputation, proving
    // the Python transcription and the Rust transcription agree.
    assert_eq!(decomp_cell_mat_scene(42, 314), 0x7F0E_8239);
    assert_eq!(decomp_cell_mat_scene(1000, 1000), 0x813A_0B51);
}

// ======================================================================
// 2. Per-object cellMat reset + object_noise — bit-exact f64 pins.
// ======================================================================

/// `cell_mats_per_object` pinned to hand-computed u32 triples, and
/// `object_noise` pinned to bit-exact f64. Hand-computed from decomp:
///   (42,314)     → (0x276CA2FE,0x98D64796,0xC6ECC3F3), noise=0.5521346725954254
///   (1000,1000)  → (0xC30E65B8,0x48939758,0x8775C977), noise=0.674326002958482
///   (0,0)        → (0x00000000,0x00000000,0x70892FB7), noise=0.9564170908498522
///   (1,1)        → (0xBDE41C43,0x6C1AC587,0xC19AEFA6), noise=0.193244215793664
#[test]
fn per_object_cellmat_and_noise_pinned() {
    let cases: &[(u32, u32, (u32, u32, u32), u64)] = &[
        // (gx, gy, expected (cell_x_mat, cell_y_mat, cell_mat), object_noise.to_bits())
        (42, 314, (0x276C_A2FE, 0x98D6_4796, 0xC6EC_C3F3), 0x3FE1_AB16_5539_1EE1),
        (1000, 1000, (0xC30E_65B8, 0x4893_9758, 0x8775_C977), 0x3FE5_9414_2031_920F),
        (0, 0, (0x0000_0000, 0x0000_0000, 0x7089_2FB7), 0x3FEE_9AF8_03D1_2370),
        (1, 1, (0xBDE4_1C43, 0x6C1A_C587, 0xC19A_EFA6), 0x3FC8_BC39_F97C_CB47),
    ];
    for &(gx, gy, exp_triple, exp_noise_bits) in cases {
        let triple = cell_mats_per_object(gx, gy);
        assert_eq!(
            triple, exp_triple,
            "cell_mats_per_object({gx},{gy}) drift"
        );
        let (a, b, c) = triple;
        let n = object_noise(a, b, c);
        assert_eq!(
            n.to_bits(),
            exp_noise_bits,
            "object_noise({gx},{gy}) = {n} (bits 0x{:016X}) != decomp golden 0x{exp_noise_bits:016X}",
            n.to_bits()
        );
        // Cross-check: inline decomp recomputation must agree bit-exactly.
        assert_eq!(triple, decomp_cell_mats(gx, gy));
        assert_eq!(n.to_bits(), decomp_object_noise(a, b, c).to_bits());
    }
}

// ======================================================================
// 3. Displace formula — pinned through the public `displace()` API.
// ======================================================================

/// With `origin=(0,0)` and `displace_x = displace_y = 1.0`, the public
/// `displace()` returns the raw `displace_noise` (cast to f32) for each
/// axis, then applies the quadrant flip. Pinned to hand-computed f32 bit
/// patterns derived directly from the decomp displace + quadrant
/// expressions.
///
/// Golden vectors span the ring (DECOMP golden LBs) AND exercise two
/// quadrant branches: the first four cases have `quadrant < 0.25` (no
/// flip → output = (noise_x, noise_y)); the last (`0xAFBA`,
/// `quadrant ≈ 0.7848 ≥ 0.75`) takes the `(y, -x)` branch.
///
/// Hand-computed (decomp; floats are post-f32-narrowing):
///   0xA3AE c(0,0) j=0 → ( 0.760063648, 0.355072081)  bits (0x3F429388,0x3EB5CC02)
///   0xA3AE c(0,0) j=5 → ( 0.965696216, 0.560704648)  bits (0x3F7737DE,0x3F0F8A57)
///   0xA6B1 c(3,4) j=2 → ( 0.718806624, 0.958846152)  bits (0x3F3803B6,0x3F7576F1)
///   0xACB7 c(8,8) j=7 → ( 0.390831530, 0.717797816)  bits (0x3EC81B12,0x3F37C199)
///   0xAFBA c(1,2) j=3 → ( 0.755929112,-0.943529546)  bits (0x3F418492,0xBF718B27)  [flip]
#[test]
fn displace_formula_pinned_to_decomp() {
    let obj = probe_obj(1.0, 1.0, 1.0, 0.0);
    let cases: &[(u16, u32, u32, u32, u32, u32)] = &[
        // (lb, cx, cy, j, expected x.to_bits(), expected y.to_bits())
        (0xA3AE, 0, 0, 0, 0x3F42_9388, 0x3EB5_CC02),
        (0xA3AE, 0, 0, 5, 0x3F77_37DE, 0x3F0F_8A57),
        (0xA6B1, 3, 4, 2, 0x3F38_03B6, 0x3F75_76F1),
        (0xACB7, 8, 8, 7, 0x3EC8_1B12, 0x3F37_C199),
        (0xAFBA, 1, 2, 3, 0x3F41_8492, 0xBF71_8B27), // quadrant (y,-x) branch
    ];
    for &(lb, cx, cy, j, exp_x_bits, exp_y_bits) in cases {
        let (ix, iy) = global_cell(lb, cx, cy);
        let (x, y) = displace(&obj, ix, iy, j);
        assert_eq!(
            x.to_bits(),
            exp_x_bits,
            "displace.x 0x{lb:04X} c({cx},{cy}) j={j}: got {x} (0x{:08X}) != golden 0x{exp_x_bits:08X}",
            x.to_bits()
        );
        assert_eq!(
            y.to_bits(),
            exp_y_bits,
            "displace.y 0x{lb:04X} c({cx},{cy}) j={j}: got {y} (0x{:08X}) != golden 0x{exp_y_bits:08X}",
            y.to_bits()
        );
    }
}

/// Independent cross-check of the displace core: recompute the raw X/Y
/// noise + quadrant *inline from the decomp constants* and assert the
/// public `displace()` reproduces them (with the f32 narrowing and
/// quadrant flip applied identically). Non-circular: shares no code with
/// `noise.rs`.
#[test]
fn displace_core_recomputed_from_raw_decomp() {
    let obj = probe_obj(1.0, 1.0, 1.0, 0.0);
    for &(lb, cx, cy, j) in &[
        (0xA3AEu16, 0u32, 0u32, 0u32),
        (0xA3AE, 0, 0, 5),
        (0xA6B1, 3, 4, 2),
        (0xACB7, 8, 8, 7),
        (0xAFBA, 1, 2, 3),
    ] {
        let (ix, iy) = global_cell(lb, cx, cy);
        // Inline decomp recomputation of what displace() should return.
        let nx = decomp_displace_noise(ix, iy, j, DISPLACE_X_MAGIC) as f32;
        let ny = decomp_displace_noise(ix, iy, j, DISPLACE_Y_MAGIC) as f32;
        let q = decomp_quadrant(ix, iy);
        let expected = if q >= 0.75 {
            (ny, (-nx))
        } else if q >= 0.5 {
            (-nx, -ny)
        } else if q >= 0.25 {
            (-ny, nx)
        } else {
            (nx, ny)
        };
        let got = displace(&obj, ix, iy, j);
        assert_eq!(
            got.0.to_bits(),
            expected.0.to_bits(),
            "displace.x decomp drift 0x{lb:04X} c({cx},{cy}) j={j} (q={q})"
        );
        assert_eq!(
            got.1.to_bits(),
            expected.1.to_bits(),
            "displace.y decomp drift 0x{lb:04X} c({cx},{cy}) j={j} (q={q})"
        );
    }
}

// ======================================================================
// 4. Scale formula — pinned to hand-computed f32 bits.
// ======================================================================

/// `scale_obj` over the golden vectors with `min_scale=0.8, max_scale=1.5`.
/// The decomp computes `pow((max/min)_f32, noise) * min`, narrowed to f32.
/// Pinned bit-exactly. Hand-computed (decomp):
///   0xA3AE c(0,0) j=0 → 1.252097726  bits 0x3FA044BD
///   0xA3AE c(0,0) j=5 → 1.424873114  bits 0x3FB6623E
///   0xA6B1 c(3,4) j=2 → 1.235465646  bits 0x3F9E23BD
///   0xACB7 c(8,8) j=7 → 1.166307449  bits 0x3F954990
///   0xAFBA c(1,2) j=3 → 1.275519848  bits 0x3FA3443C
#[test]
fn scale_formula_pinned_to_decomp() {
    let obj = probe_obj(0.0, 0.8, 1.5, 0.0);
    let cases: &[(u16, u32, u32, u32, u32)] = &[
        (0xA3AE, 0, 0, 0, 0x3FA0_44BD),
        (0xA3AE, 0, 0, 5, 0x3FB6_623E),
        (0xA6B1, 3, 4, 2, 0x3F9E_23BD),
        (0xACB7, 8, 8, 7, 0x3F95_4990),
        (0xAFBA, 1, 2, 3, 0x3FA3_443C),
    ];
    for &(lb, cx, cy, j, exp_bits) in cases {
        let (ix, iy) = global_cell(lb, cx, cy);
        let s = scale_obj(&obj, ix, iy, j);
        assert_eq!(
            s.to_bits(),
            exp_bits,
            "scale_obj 0x{lb:04X} c({cx},{cy}) j={j}: got {s} (0x{:08X}) != golden 0x{exp_bits:08X}",
            s.to_bits()
        );
        // Scale must land inside [min, max] for these noise samples.
        assert!((0.8..=1.5).contains(&s), "scale {s} outside [0.8,1.5]");
    }
}

// ======================================================================
// 5. Rotation formula — pinned to hand-computed f32 bits.
// ======================================================================

/// `rotate_obj` over the golden vectors with `max_rotation=360.0` deg.
/// The decomp computes `noise * max_rotation * DEG_TO_RAD(0.017453303_f32)`
/// → radians, narrowed to f32. Pinned bit-exactly. Hand-computed (decomp):
///   0xA3AE c(0,0) j=0 → 0.437079042  bits 0x3EDFC8D3
///   0xA3AE c(0,0) j=5 → 1.729107022  bits 0x3FDD5361
///   0xA6B1 c(3,4) j=2 → 0.193679124  bits 0x3E4653D2
///   0xACB7 c(8,8) j=7 → 3.121661663  bits 0x4047C94E
///   0xAFBA c(1,2) j=3 → 5.087160110  bits 0x40A2CA04
#[test]
fn rotation_formula_pinned_to_decomp() {
    let obj = probe_obj(0.0, 1.0, 1.0, 360.0);
    let cases: &[(u16, u32, u32, u32, u32)] = &[
        (0xA3AE, 0, 0, 0, 0x3EDF_C8D3),
        (0xA3AE, 0, 0, 5, 0x3FDD_5361),
        (0xA6B1, 3, 4, 2, 0x3E46_53D2),
        (0xACB7, 8, 8, 7, 0x4047_C94E),
        (0xAFBA, 1, 2, 3, 0x40A2_CA04),
    ];
    for &(lb, cx, cy, j, exp_bits) in cases {
        let (ix, iy) = global_cell(lb, cx, cy);
        let r = rotate_obj(&obj, ix, iy, j);
        assert_eq!(
            r.to_bits(),
            exp_bits,
            "rotate_obj 0x{lb:04X} c({cx},{cy}) j={j}: got {r} (0x{:08X}) != golden 0x{exp_bits:08X}",
            r.to_bits()
        );
        // Radians must be in [0, 2π) for max_rotation=360.
        assert!(
            (0.0..std::f32::consts::TAU).contains(&r),
            "rotation {r} outside [0,2π)"
        );
    }
}

// ======================================================================
// 6. Constant anchors — the byte-exact literals the whole algorithm rides.
// ======================================================================

/// `NOISE_SCALE` is the `2.3283064e-10` *literal* from the decomp, which
/// is NOT byte-equal to `1.0 / 4294967296.0`. Pin its exact f64 bits so a
/// well-meaning "simplify to 1/2^32" refactor fails loudly. Hand-derived:
/// `(2.3283064e-10_f64).to_bits() == 0x3DEFFFFFF79322D5`.
#[test]
fn noise_scale_is_the_decomp_literal_not_one_over_two_pow_32() {
    assert_eq!(
        NOISE_SCALE.to_bits(),
        0x3DEF_FFFF_F793_22D5,
        "NOISE_SCALE must be the decomp literal 2.3283064e-10, got {NOISE_SCALE} \
         (bits 0x{:016X})",
        NOISE_SCALE.to_bits()
    );
    // It is deliberately NOT 1/2^32 — prove the bits differ.
    let one_over_2_32 = 1.0_f64 / 4_294_967_296.0_f64;
    assert_ne!(
        NOISE_SCALE.to_bits(),
        one_over_2_32.to_bits(),
        "decomp literal must differ from 1/2^32 in the low bits"
    );
}
