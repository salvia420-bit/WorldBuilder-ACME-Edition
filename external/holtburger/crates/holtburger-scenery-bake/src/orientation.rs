//! Retail scenery orientation for [`crate::BakeMode::Retail`]
//! (terrain-scenery-4): the frame `acclient.c` `CLandBlock::get_land_scenes`
//! builds for each accepted object (:352703-352706), branching on
//! `ObjectDesc.align`:
//!
//! - `align == 0` → `ObjectDesc::GetObjFrame` (:462660): `base_loc` whole,
//!   then, only when `max_rot > 0`, `Frame::set_heading(noise * max_rot)`
//!   with the heading in DEGREES ([`crate::noise::rotate_obj_retail`]).
//! - `align != 0` → `ObjectDesc::ObjAlign` (:462708): `base_loc`, then
//!   `Frame::set_heading(get_heading(-N))` of the walkable terrain
//!   triangle's normal, which turns the forward (+Y) axis UP-slope.
//!
//! `Frame::set_heading` (:357692) is a compass heading — 0 = north (+Y),
//! 90 = east (+X), clockwise from above — and it REPLACES the orientation:
//! `set_vector_heading` (:357668) → `euler_set_rotate(asin(fwd.z), 0,
//! -heading)` (:357589, static XYZ), keeping only the pitch of the base
//! frame's forward axis. For a level base, heading `d` is
//! `(cos(d/2), 0, 0, -sin(d/2))`: the opposite turn to ACE's dead
//! `Entity/Scenery.cs` (`CreateFromYawPitchRoll(0, 0, +r)`), which
//! `AceCompat` keeps.
//!
//! **atan2 argument order.** Hex-Rays prints `atan2(v.x, v.y)` in
//! `Frame::set_vector_heading` (:357683), `Frame::get_heading` (:357410)
//! and `AC1Legacy::Vector3::get_heading` (:148167). Read literally,
//! `set_heading(0)` would turn the frame -90 degrees and the identity frame
//! would read heading 90, contradicting the `450 -` math-angle-to-compass
//! conversion and AC's heading 0 = north. The port uses `atan2(y, x)`, as
//! ACE `AFrame.set_vector_heading` and `Vector3Extensions.get_heading` do.
//!
//! Precision follows [`crate::retail`]: f64 for the x87 intermediates,
//! narrowed to f32 wherever the decomp stores a float.

use holtburger_common::Quaternion;
use holtburger_dat::file_type::object_desc::ObjectDesc;

use crate::noise::rotate_obj_retail;

/// `π / 180` as the decomp spells it.
const DEG_TO_RAD: f64 = 0.0174532925199433;
/// `180 / π` as the decomp spells it.
const RAD_TO_DEG: f64 = 57.29577951308232;
/// `AC1Legacy::Vector3::normalize_check_small` (`acclient.c:143622`): a
/// vector shorter than the float `0.0002` (`0.00019999999`) is "small".
const SMALL_VECTOR: f32 = 0.0002;

/// The orientation of the frame retail builds for scenery object `iq` of a
/// Scene at global cell `(ix, iy)` (`CLandBlock::get_land_scenes`
/// :352703-352706). `walkable_normal` is the upward unit normal of the
/// terrain triangle under the placement (`walkable->plane.N`; only read
/// when `obj.align != 0`).
///
/// - `align != 0`: `ObjectDesc::ObjAlign` — `set_heading(base,
///   get_heading(-N))`, whatever `max_rotation` is.
/// - `align == 0 && max_rotation > 0`: `ObjectDesc::GetObjFrame` —
///   `set_heading(base, noise * max_rotation)`.
/// - otherwise: `base_loc.orientation`, bit for bit.
pub fn obj_frame_orientation(
    obj: &ObjectDesc,
    ix: u32,
    iy: u32,
    iq: u32,
    walkable_normal: (f32, f32, f32),
) -> Quaternion {
    let base = obj.base_loc.orientation;
    if obj.align != 0 {
        let (nx, ny, _) = walkable_normal;
        frame_set_heading(base, vector_heading(-nx, -ny))
    } else if obj.max_rotation > 0.0 {
        frame_set_heading(base, rotate_obj_retail(obj, ix, iy, iq))
    } else {
        base
    }
}

/// `Frame::set_heading` (`acclient.c:357692`) applied to a frame whose
/// orientation is `base`: the heading `degrees` (compass, clockwise from
/// +Y) with the pitch of `base`'s forward axis. `base`'s own yaw and roll do
/// not survive.
///
/// `direction = (sin d, cos d, m_fl2gv[5])`, where `m_fl2gv[5] =
/// 2(qy qz + qw qx)` is the z of `base`'s forward (+Y) axis
/// (`Frame::cache`), then `Frame::set_vector_heading`. Returns `base`
/// unchanged when the direction is small or the result is not a valid
/// rotation (a NaN heading), as retail leaves the frame alone then.
pub fn frame_set_heading(base: Quaternion, degrees: f32) -> Quaternion {
    let (w, x, y, z) = (base.w as f64, base.x as f64, base.y as f64, base.z as f64);
    let fwd_z = (y * (z + z) + w * (x + x)) as f32;
    let rad = degrees as f64 * DEG_TO_RAD;
    frame_set_vector_heading(base, (rad.sin() as f32, rad.cos() as f32, fwd_z))
}

/// `Frame::set_vector_heading` (`acclient.c:357668`): normalize `heading`
/// (`normalize_check_small`; a small vector leaves the frame alone), then
/// `euler_set_rotate(asin(n.z), 0, -compass_heading(n))` in radians.
fn frame_set_vector_heading(base: Quaternion, heading: (f32, f32, f32)) -> Quaternion {
    let Some((nx, ny, nz)) = normalize_check_small(heading) else {
        return base;
    };
    let az = (-compass_heading_deg(nx, ny) * DEG_TO_RAD) as f32;
    let ax = ((nz as f64).asin() * RAD_TO_DEG * DEG_TO_RAD) as f32;
    euler_set_rotate_xyz_static(base, ax, 0.0, az)
}

/// `AC1Legacy::Vector3::get_heading` (`acclient.c:148167`): the compass
/// heading in degrees (0 = +Y, 90 = +X, clockwise from above, `[0, 360)`)
/// of `(x, y)`, or 0 when it is shorter than `0.0002`. Stored as float, as
/// `ObjectDesc::ObjAlign` stores it.
pub fn vector_heading(x: f32, y: f32) -> f32 {
    match normalize_check_small((x, y, 0.0)) {
        Some((nx, ny, _)) => compass_heading_deg(nx, ny) as f32,
        None => 0.0,
    }
}

/// The turn about +Z, in radians counter-clockwise from above, that carries
/// local +Y onto the horizontal part of `q`'s forward axis:
/// `atan2(-f.x, f.y)` with `f = (m_fl2gv[3], m_fl2gv[4])` (`Frame::cache`).
/// Exactly `θ` for a yaw-only `(cos θ/2, 0, 0, sin θ/2)`, and `-heading`
/// for a [`frame_set_heading`] frame whatever its pitch. The bake passes it
/// as [`crate::PlacementXform::rotation_rad`] in `BakeMode::Retail`.
pub fn yaw_about_z(q: Quaternion) -> f32 {
    let (w, x, y, z) = (q.w as f64, q.x as f64, q.y as f64, q.z as f64);
    let fx = x * (y + y) - w * (z + z);
    let fy = 1.0 - x * (x + x) - z * (z + z);
    (-fx).atan2(fy) as f32
}

/// `Frame::cache` (`acclient.c`): the local-to-global rotation matrix of
/// `q`, as the nine floats `m_fl2gv` stores. Column-major: `[0..3]` is the
/// image of local +X, `[3..6]` of +Y (forward), `[6..9]` of +Z.
pub(crate) fn frame_cache(q: Quaternion) -> [f32; 9] {
    let (w, x, y, z) = (q.w as f64, q.x as f64, q.y as f64, q.z as f64);
    let (b2, c2, d2) = (x + x, y + y, z + z);
    let (wb, wc, wd) = (w * b2, w * c2, w * d2);
    let (xb, xc, xd) = (x * b2, x * c2, x * d2);
    let (yc, yd, zd) = (y * c2, y * d2, z * d2);
    [
        (1.0 - yc - zd) as f32,
        (xc + wd) as f32,
        (xd - wc) as f32,
        (xc - wd) as f32,
        (1.0 - xb - zd) as f32,
        (yd + wb) as f32,
        (xd + wc) as f32,
        (yd - wb) as f32,
        (1.0 - xb - yc) as f32,
    ]
}

/// `fmod(450 - atan2(y, x) * 180/π, 360)` of a normalized horizontal
/// direction: math angle (CCW from +X) to compass heading (CW from +Y).
/// `450 - atan2` lies in `[270, 630]`, so the result is in `[0, 360)`.
fn compass_heading_deg(nx: f32, ny: f32) -> f64 {
    (450.0 - (ny as f64).atan2(nx as f64) * RAD_TO_DEG) % 360.0
}

/// `AC1Legacy::Vector3::normalize_check_small` (`acclient.c:143622`): `None`
/// when `|v| < 0.0002` (or NaN), else `v / |v|` stored as floats.
fn normalize_check_small(v: (f32, f32, f32)) -> Option<(f32, f32, f32)> {
    let (x, y, z) = (v.0 as f64, v.1 as f64, v.2 as f64);
    let len = (x * x + y * y + z * z).sqrt();
    if len >= SMALL_VECTOR as f64 {
        let inv = 1.0 / len;
        Some(((inv * x) as f32, (inv * y) as f32, (inv * z) as f32))
    } else {
        None
    }
}

/// `Frame::euler_set_rotate(x, y, z, 0)` (`acclient.c:357589`): Shoemake's
/// `Eul_ToQuat` for order 0 (`EulOrdXYZs`: static axes, X then Y then Z, so
/// `q = qz * qy * qx`), then [`set_rotate`]. Order 0 unpacks (`EulGetOrd`)
/// to `i, j, k = 0, 1, 2`, no repetition, even parity, static frame.
fn euler_set_rotate_xyz_static(base: Quaternion, ax: f32, ay: f32, az: f32) -> Quaternion {
    let (ti, tj, th) = (ax as f64 * 0.5, ay as f64 * 0.5, az as f64 * 0.5);
    let (ci, cj, ch) = (ti.cos() as f32, tj.cos() as f32, th.cos() as f32);
    let (si, sj, sh) = (ti.sin() as f32, tj.sin() as f32, th.sin() as f32);
    let cc = ch * ci;
    let cs = ci * sh;
    let sc = si * ch;
    let ss = sh * si;
    let a_i = sc * cj - cs * sj;
    let a_j = cc * sj + ss * cj;
    let a_k = cs * cj - sc * sj;
    let w = ss * sj + cc * cj;
    set_rotate(
        base,
        Quaternion {
            w,
            x: a_i,
            y: a_j,
            z: a_k,
        },
    )
}

/// `Frame::set_rotate` (`acclient.c:357063`): normalize the new quaternion
/// and keep it if `Frame::IsValid` accepts it, else keep the old one.
fn set_rotate(old: Quaternion, new: Quaternion) -> Quaternion {
    let (w, x, y, z) = (new.w as f64, new.x as f64, new.y as f64, new.z as f64);
    let inv = 1.0 / (w * w + x * x + y * y + z * z).sqrt();
    let q = Quaternion {
        w: (w * inv) as f32,
        x: (x * inv) as f32,
        y: (y * inv) as f32,
        z: (inv * z) as f32,
    };
    if quat_is_valid(q) { q } else { old }
}

/// The orientation half of `Frame::IsValid` (`acclient.c`): no NaN
/// component, and `|q|^2` (stored as float) within `5 * 0.0002` of 1.
fn quat_is_valid(q: Quaternion) -> bool {
    if q.w.is_nan() || q.x.is_nan() || q.y.is_nan() || q.z.is_nan() {
        return false;
    }
    let (w, x, y, z) = (q.w as f64, q.x as f64, q.y as f64, q.z as f64);
    let norm = (z * z + y * y + x * x + w * w) as f32;
    !(norm.is_nan() || SMALL_VECTOR as f64 * 5.0 < (norm as f64 - 1.0).abs())
}

#[cfg(test)]
mod tests {
    use super::*;
    use holtburger_common::Vector3;
    use holtburger_dat::graphics::Frame;

    const EPS: f32 = 1e-6;

    fn identity() -> Quaternion {
        Quaternion::identity()
    }

    fn yaw(rad: f64) -> Quaternion {
        Quaternion {
            w: (rad * 0.5).cos() as f32,
            x: 0.0,
            y: 0.0,
            z: (rad * 0.5).sin() as f32,
        }
    }

    /// `q` applied to `v` through the `Frame::cache` matrix.
    fn apply(q: Quaternion, v: (f32, f32, f32)) -> (f32, f32, f32) {
        let m = frame_cache(q);
        (
            m[0] * v.0 + m[3] * v.1 + m[6] * v.2,
            m[1] * v.0 + m[4] * v.1 + m[7] * v.2,
            m[2] * v.0 + m[5] * v.1 + m[8] * v.2,
        )
    }

    fn assert_vec(got: (f32, f32, f32), want: (f32, f32, f32), what: &str) {
        assert!(
            (got.0 - want.0).abs() < EPS
                && (got.1 - want.1).abs() < EPS
                && (got.2 - want.2).abs() < EPS,
            "{what}: got {got:?}, want {want:?}"
        );
    }

    fn assert_quat(got: Quaternion, want: Quaternion, what: &str) {
        assert!(
            (got.w - want.w).abs() < EPS
                && (got.x - want.x).abs() < EPS
                && (got.y - want.y).abs() < EPS
                && (got.z - want.z).abs() < EPS,
            "{what}: got {got:?}, want {want:?}"
        );
    }

    fn obj(base: Quaternion, max_rotation: f32, align: u32) -> ObjectDesc {
        ObjectDesc {
            obj_id: 0x0100_0001,
            base_loc: Frame {
                origin: Vector3::new(0.0, 0.0, 0.0),
                orientation: base,
            },
            freq: 1.0,
            displace_x: 0.0,
            displace_y: 0.0,
            min_scale: 1.0,
            max_scale: 1.0,
            max_rotation,
            min_slope: 0.0,
            max_slope: 1.0,
            align,
            orient: 0,
            weenie_obj: 0,
        }
    }

    /// Heading 0 is north: the identity frame stays the identity, to the
    /// signed zero retail's Euler build leaves in `qz`.
    #[test]
    fn set_heading_zero_on_identity_is_identity() {
        let q = frame_set_heading(identity(), 0.0);
        assert_eq!([q.w, q.x, q.y, q.z], [1.0, 0.0, 0.0, 0.0]);
        assert_vec(apply(q, (0.0, 1.0, 0.0)), (0.0, 1.0, 0.0), "forward");
    }

    /// Heading 90 is east: local +Y goes to world +X, and the quaternion is
    /// `(cos 45°, 0, 0, -sin 45°)` — the opposite sign to ACE's dead port.
    #[test]
    fn set_heading_90_turns_forward_to_plus_x() {
        let q = frame_set_heading(identity(), 90.0);
        let h = std::f32::consts::FRAC_1_SQRT_2;
        assert_quat(q, Quaternion { w: h, x: 0.0, y: 0.0, z: -h }, "heading 90");
        assert_vec(apply(q, (0.0, 1.0, 0.0)), (1.0, 0.0, 0.0), "forward");
        assert_vec(apply(q, (1.0, 0.0, 0.0)), (0.0, -1.0, 0.0), "right");
    }

    /// Clockwise from north: 180 faces -Y, 270 faces -X, 45 faces north-east.
    #[test]
    fn set_heading_is_a_clockwise_compass() {
        let s = std::f32::consts::FRAC_1_SQRT_2;
        for (deg, want) in [
            (180.0f32, (0.0f32, -1.0f32)),
            (270.0, (-1.0, 0.0)),
            (45.0, (s, s)),
        ] {
            let f = apply(frame_set_heading(identity(), deg), (0.0, 1.0, 0.0));
            assert_vec(f, (want.0, want.1, 0.0), &format!("heading {deg}"));
        }
    }

    /// The base's own yaw does not survive: a base turned -90° and set to
    /// heading 30 faces heading 30.
    #[test]
    fn set_heading_replaces_the_base_yaw() {
        let base = yaw(-std::f64::consts::FRAC_PI_2);
        let q = frame_set_heading(base, 30.0);
        assert_quat(q, frame_set_heading(identity(), 30.0), "yawed base");
        let f = apply(q, (0.0, 1.0, 0.0));
        assert_vec(f, (0.5, 0.866_025_4, 0.0), "forward at heading 30");
    }

    /// A base pitched 10° about X keeps its forward axis' pitch: with
    /// `fwd.z = sin 10°`, the direction `(1, 0, sin 10°)` normalizes to
    /// `z = sin 10° / sqrt(1 + sin² 10°)` and the frame becomes
    /// `qz(-90°) * qx(asin(z))` — forward east, tilted up by `asin(z)`.
    #[test]
    fn set_heading_keeps_the_base_forward_pitch() {
        let base = Quaternion {
            w: 5.0f64.to_radians().cos() as f32,
            x: 5.0f64.to_radians().sin() as f32,
            y: 0.0,
            z: 0.0,
        };
        let fwd_z = 10.0f64.to_radians().sin();
        let ax = (fwd_z / (1.0 + fwd_z * fwd_z).sqrt()).asin();
        let q = frame_set_heading(base, 90.0);
        let (c, s) = ((ax * 0.5).cos() as f32, (ax * 0.5).sin() as f32);
        let h = std::f32::consts::FRAC_1_SQRT_2;
        assert_quat(q, Quaternion { w: h * c, x: h * s, y: -h * s, z: -h * c }, "pitched");
        assert!(q.x.abs() > 0.05 && q.y.abs() > 0.05, "pitch rides on qx/qy: {q:?}");
        let f = apply(q, (0.0, 1.0, 0.0));
        assert_vec(f, (ax.cos() as f32, 0.0, ax.sin() as f32), "forward");
    }

    /// A NaN heading normalizes as "small": retail leaves the frame alone.
    #[test]
    fn set_heading_nan_keeps_the_base() {
        let base = yaw(-std::f64::consts::FRAC_PI_2);
        let q = frame_set_heading(base, f32::NAN);
        assert_eq!(
            [q.w, q.x, q.y, q.z].map(f32::to_bits),
            [base.w, base.x, base.y, base.z].map(f32::to_bits)
        );
    }

    #[test]
    fn vector_heading_is_compass_degrees() {
        assert_eq!(vector_heading(0.0, 1.0), 0.0);
        assert_eq!(vector_heading(1.0, 0.0), 90.0);
        assert_eq!(vector_heading(0.0, -1.0), 180.0);
        assert_eq!(vector_heading(-1.0, 0.0), 270.0);
        assert!((vector_heading(1.0, 1.0) - 45.0).abs() < 1e-4);
        // Length is irrelevant above the small-vector cut, fatal below it.
        assert_eq!(vector_heading(0.0, 0.001), 0.0);
        assert_eq!(vector_heading(0.001, 0.0), 90.0);
        assert_eq!(vector_heading(1e-5, 0.0), 0.0);
        assert_eq!(vector_heading(0.0, 0.0), 0.0);
        assert_eq!(vector_heading(f32::NAN, 0.0), 0.0);
    }

    /// `yaw_about_z` reads back a yaw-only angle and the `-heading` of a
    /// pitched `set_heading` frame.
    #[test]
    fn yaw_about_z_reads_the_forward_axis() {
        for r in [0.0f64, 0.3, 1.5, -2.0, 3.0] {
            assert!((yaw_about_z(yaw(r)) as f64 - r).abs() < 1e-6, "yaw {r}");
        }
        let pitched = Quaternion {
            w: 0.98,
            x: 0.2,
            y: 0.0,
            z: 0.0,
        }
        .normalize();
        let q = frame_set_heading(pitched, 90.0);
        assert!((yaw_about_z(q) + std::f32::consts::FRAC_PI_2).abs() < 1e-6);
    }

    /// The frame selection: align beats max_rotation; no rotation keeps the
    /// base bit for bit; otherwise `set_heading(noise * max_rot)`.
    #[test]
    fn obj_frame_orientation_branches_on_align_then_max_rot() {
        let base = yaw(-std::f64::consts::FRAC_PI_2);
        let up = (0.0f32, 0.0f32, 1.0f32);
        let still = obj_frame_orientation(&obj(base, 0.0, 0), 11_000, 12_000, 0, up);
        assert_eq!(
            [still.w, still.x, still.y, still.z].map(f32::to_bits),
            [base.w, base.x, base.y, base.z].map(f32::to_bits)
        );

        let o = obj(base, 360.0, 0);
        let want = frame_set_heading(base, rotate_obj_retail(&o, 11_000, 12_000, 3));
        assert_eq!(obj_frame_orientation(&o, 11_000, 12_000, 3, up), want);

        // A plane rising toward +X: N = (-g, 0, 1)/|.|, so -N points +X
        // horizontally and the aligned forward axis turns UP-slope (east),
        // even with a max_rotation present.
        let g = 0.25f32;
        let n = 1.0 / (1.0 + g * g).sqrt();
        let aligned = obj_frame_orientation(&obj(base, 360.0, 1), 11_000, 12_000, 3, (-g * n, 0.0, n));
        assert_vec(apply(aligned, (0.0, 1.0, 0.0)), (1.0, 0.0, 0.0), "aligned forward");
        // Flat ground has no horizontal normal: heading 0, north.
        let flat = obj_frame_orientation(&obj(base, 0.0, 1), 11_000, 12_000, 0, up);
        assert_vec(apply(flat, (0.0, 1.0, 0.0)), (0.0, 1.0, 0.0), "flat aligned forward");
    }

    /// `frame_cache` is the rotation `Quaternion::rotate_vector` applies.
    #[test]
    fn frame_cache_matches_rotate_vector() {
        let q = Quaternion {
            w: 0.7,
            x: 0.1,
            y: -0.3,
            z: 0.6,
        }
        .normalize();
        for v in [(1.0f32, 0.0f32, 0.0f32), (0.0, 1.0, 0.0), (0.0, 0.0, 1.0), (0.3, -2.0, 5.0)] {
            let r = q.rotate_vector(Vector3::new(v.0, v.1, v.2));
            let got = apply(q, v);
            assert!(
                (got.0 - r.x).abs() < 1e-5 && (got.1 - r.y).abs() < 1e-5 && (got.2 - r.z).abs() < 1e-5,
                "{v:?}: {got:?} vs {r:?}"
            );
        }
    }
}
