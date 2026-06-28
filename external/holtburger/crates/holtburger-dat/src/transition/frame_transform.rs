//! `Frame` orientation transform (`m_fl2gv[0..9]`) + plane local→global,
//! ported decomp-faithfully from `acclient.c`.
//!
//! Retail stores a rigid orientation as the flat 9-float row vector
//! `m_fl2gv` (acclient.h:30653 `float m_fl2gv[9]`). Reading the decomp
//! arithmetic (acclient.c:143659) the local→global vector map is
//!
//! ```text
//! result.x = m0·x + m3·y + m6·z
//! result.y = m1·x + m4·y + m7·z
//! result.z = m2·x + m5·y + m8·z
//! ```
//!
//! i.e. `m_fl2gv` holds the local→global basis **column-major**: column 0
//! `(m0,m1,m2)` is the global image of local +X, column 1 `(m3,m4,m5)` of
//! local +Y, column 2 `(m6,m7,m8)` of local +Z. `globaltolocalvec`
//! (acclient.c:143675) applies the transpose — the orthonormal inverse —
//! which is exactly "read the same 9 floats row-major".
//!
//! This is the 3×3 transform `CSphere::slide_sphere` / `step_sphere_up`
//! lean on indirectly: a contact plane discovered in a cell's local space
//! is carried into global space by [`Frame::plane_localtoglobal`] (the
//! single-frame reduction of `Plane::localtoglobal`, acclient.c:467672)
//! before the slide/step responder uses its global normal.
//!
//! ## Owns
//! - [`Frame`]                      — `m_fl2gv[0..9]` 3×3 + `m_fOrigin`
//! - [`Frame::localtoglobalvec`]    — `Frame::localtoglobalvec`  (acclient.c:143659)
//! - [`Frame::globaltolocalvec`]    — `Frame::globaltolocalvec`  (acclient.c:143675)
//! - [`Frame::localtoglobal`]       — `Frame::localtoglobal`     (acclient.c:143702)
//! - [`Frame::globaltolocal`]       — `Frame::globaltolocal`     (acclient.c:143726)
//! - [`Frame::plane_localtoglobal`] / [`Frame::plane_localtoglobal_with_offset`]
//!                                  — `Plane::localtoglobal`     (acclient.c:467672)
//!
//! ## Phase-1 scope
//! The full `Plane::localtoglobal` (acclient.c:467672) re-bases the plane's
//! anchor point through a *second* `Position to` via
//! `Position::localtoglobal(to, from, point)` (acclient.c:147141), which
//! adds `LandDefs::get_block_offset(to.objcell_id, from.objcell_id)` — the
//! cross-cell landblock delta. The leaf layer only needs the same-cell
//! reduction (`to` and `from` share a landblock ⇒ block offset `0`), but
//! [`Frame::plane_localtoglobal_with_offset`] keeps the offset hook so
//! Phase-3 can thread the real `get_block_offset` result through without a
//! rewrite. (`from` is `self`; orientation/`Position` chaining lands in
//! Phase 2 — see [`super::types::CellPos`].)

use holtburger_common::{Plane, Vector3};

/// `struct Frame` (acclient.h: `float m_fl2gv[9]` @30653 + `m_fOrigin`):
/// a rigid orientation (the 3×3 local→global basis stored column-major as
/// 9 floats) plus its world-space origin. Phase-2 will populate `fl2gv`
/// from a `Quaternion`; the leaf layer only needs the raw transform.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Frame {
    /// `m_fl2gv[0..9]` — column-major local→global rotation basis.
    pub fl2gv: [f32; 9],
    /// `m_fOrigin` — the frame's world-space origin.
    pub origin: Vector3,
}

impl Default for Frame {
    fn default() -> Self {
        Self::identity()
    }
}

impl Frame {
    /// The identity frame: no rotation (`result == in`), origin at world 0.
    pub fn identity() -> Self {
        Self {
            fl2gv: [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0],
            origin: Vector3::zero(),
        }
    }

    /// `Frame::localtoglobalvec` (acclient.c:143659). Rotates a direction
    /// from this frame's local space into global space — no translation.
    ///
    /// Decomp (registers reordered to x,y,z):
    /// ```text
    /// result->x = m_fl2gv[6]*in->z + m_fl2gv[0]*in->x + m_fl2gv[3]*in->y;
    /// result->y = m_fl2gv[7]*in->z + m_fl2gv[1]*in->x + m_fl2gv[4]*in->y;
    /// result->z = m_fl2gv[8]*in->z + m_fl2gv[2]*in->x + m_fl2gv[5]*in->y;
    /// ```
    pub fn localtoglobalvec(&self, v: Vector3) -> Vector3 {
        // acclient.c:143659
        let m = &self.fl2gv;
        Vector3::new(
            m[0] * v.x + m[3] * v.y + m[6] * v.z,
            m[1] * v.x + m[4] * v.y + m[7] * v.z,
            m[2] * v.x + m[5] * v.y + m[8] * v.z,
        )
    }

    /// `Frame::globaltolocalvec` (acclient.c:143675). The transpose of
    /// [`Self::localtoglobalvec`] — rotates a global direction back into
    /// local space (the orthonormal inverse).
    ///
    /// Decomp (registers reordered to x,y,z):
    /// ```text
    /// result->x = m_fl2gv[2]*in->z + m_fl2gv[0]*in->x + m_fl2gv[1]*in->y;
    /// result->y = m_fl2gv[5]*in->z + m_fl2gv[3]*in->x + m_fl2gv[4]*in->y;
    /// result->z = m_fl2gv[8]*in->z + m_fl2gv[6]*in->x + m_fl2gv[7]*in->y;
    /// ```
    pub fn globaltolocalvec(&self, v: Vector3) -> Vector3 {
        // acclient.c:143675
        let m = &self.fl2gv;
        Vector3::new(
            m[0] * v.x + m[1] * v.y + m[2] * v.z,
            m[3] * v.x + m[4] * v.y + m[5] * v.z,
            m[6] * v.x + m[7] * v.y + m[8] * v.z,
        )
    }

    /// `Frame::localtoglobal` (acclient.c:143702). Transforms a POINT from
    /// local to global space: rotate by `m_fl2gv`, then add `m_fOrigin`.
    ///
    /// Decomp adds `m_fOrigin.{x,y,z}` to each component of
    /// [`Self::localtoglobalvec`].
    pub fn localtoglobal(&self, point: Vector3) -> Vector3 {
        // acclient.c:143702
        self.localtoglobalvec(point) + self.origin
    }

    /// `Frame::globaltolocal` (acclient.c:143726). Transforms a POINT from
    /// global to local space: subtract `m_fOrigin`, then apply the
    /// transpose basis ([`Self::globaltolocalvec`]). The exact inverse of
    /// [`Self::localtoglobal`].
    pub fn globaltolocal(&self, point: Vector3) -> Vector3 {
        // acclient.c:143726
        self.globaltolocalvec(point - self.origin)
    }

    /// Same-cell reduction of `Plane::localtoglobal` (acclient.c:467672):
    /// `self` is the `from` frame and `to` shares its landblock, so the
    /// `LandDefs::get_block_offset` term is zero. See
    /// [`Self::plane_localtoglobal_with_offset`].
    pub fn plane_localtoglobal(&self, plane: &Plane) -> Plane {
        // acclient.c:467672 (block offset == 0)
        self.plane_localtoglobal_with_offset(plane, Vector3::zero())
    }

    /// `Plane::localtoglobal` (acclient.c:467672). Carries a plane out of
    /// `from`'s (== `self`) local space into global space.
    ///
    /// The decomp:
    /// 1. anchors the plane at its foot-point `point = N · (-d)` (local);
    /// 2. rotates the normal by `from`'s basis only
    ///    (`v9/v10/v11` = `from.m_fl2gv` · `N` — same arithmetic as
    ///    [`Self::localtoglobalvec`], NOT renormalized);
    /// 3. transforms the foot-point through
    ///    `Position::localtoglobal(to, from, point)` (acclient.c:147141) =
    ///    `from.localtoglobal(point)` **plus**
    ///    `LandDefs::get_block_offset(to.objcell_id, from.objcell_id)`;
    /// 4. re-derives `d = -dot(N_global, point_global)`.
    ///
    /// `block_offset` is that landblock delta (zero within one cell; Phase-3
    /// supplies the cross-cell value).
    pub fn plane_localtoglobal_with_offset(&self, plane: &Plane, block_offset: Vector3) -> Plane {
        // acclient.c:467672
        // (1) foot-point in local space: point = N * (-d).
        let foot = plane.normal * (-plane.d);
        // (2) rotate the normal by `from`'s basis (v9/v10/v11).
        let normal = self.localtoglobalvec(plane.normal);
        // (3) Position::localtoglobal(to, from, point): from.localtoglobal +
        //     cross-cell block offset (acclient.c:147141).
        let point = self.localtoglobal(foot) + block_offset;
        // (4) d = -(N_global · point_global).
        let d = -normal.dot(&point);
        Plane { normal, d }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(x: f32, y: f32, z: f32) -> Vector3 {
        Vector3::new(x, y, z)
    }

    /// +90° rotation about Z stored column-major in `m_fl2gv`:
    /// maps local +X→+Y, +Y→−X, +Z→+Z. Columns are the global images of
    /// the local axes ⇒ col0=(0,1,0), col1=(-1,0,0), col2=(0,0,1).
    fn rot_z_90(origin: Vector3) -> Frame {
        Frame {
            fl2gv: [0.0, 1.0, 0.0, -1.0, 0.0, 0.0, 0.0, 0.0, 1.0],
            origin,
        }
    }

    const EPS: f32 = 1e-4;
    fn close(a: Vector3, b: Vector3) -> bool {
        (a.x - b.x).abs() < EPS && (a.y - b.y).abs() < EPS && (a.z - b.z).abs() < EPS
    }

    #[test]
    fn identity_vec_is_passthrough() {
        // Hand-derived: identity basis ⇒ result == in for the vector map,
        // result == in + origin for the point map.
        let f = Frame::identity();
        assert!(close(f.localtoglobalvec(v(1.0, 2.0, 3.0)), v(1.0, 2.0, 3.0)));
        assert!(close(f.globaltolocalvec(v(1.0, 2.0, 3.0)), v(1.0, 2.0, 3.0)));
        assert!(close(f.localtoglobal(v(4.0, 5.0, 6.0)), v(4.0, 5.0, 6.0)));

        // Translated identity: the POINT map shifts by the origin, the
        // VECTOR map does not.
        let t = Frame {
            origin: v(10.0, -2.0, 0.5),
            ..Frame::identity()
        };
        assert!(close(t.localtoglobal(v(1.0, 1.0, 1.0)), v(11.0, -1.0, 1.5)));
        assert!(close(t.localtoglobalvec(v(1.0, 1.0, 1.0)), v(1.0, 1.0, 1.0)));
    }

    #[test]
    fn rot_z_90_vec_matches_hand_math() {
        let f = rot_z_90(v(10.0, 0.0, 0.0));

        // localtoglobalvec((1,2,3)): rotate (x,y)→(-y,x), z unchanged.
        //   x = m0*1 + m3*2 + m6*3 = 0 + (-2) + 0 = -2
        //   y = m1*1 + m4*2 + m7*3 = 1  +   0  + 0 =  1
        //   z = m2*1 + m5*2 + m8*3 = 0  +   0  + 3 =  3
        assert!(close(f.localtoglobalvec(v(1.0, 2.0, 3.0)), v(-2.0, 1.0, 3.0)));

        // Basis column check: local +X → global +Y.
        assert!(close(f.localtoglobalvec(v(1.0, 0.0, 0.0)), v(0.0, 1.0, 0.0)));

        // globaltolocalvec is the exact inverse (transpose): undo the rotate.
        assert!(close(f.globaltolocalvec(v(-2.0, 1.0, 3.0)), v(1.0, 2.0, 3.0)));
    }

    #[test]
    fn localtoglobal_point_round_trips() {
        let f = rot_z_90(v(10.0, 0.0, 0.0));

        // localtoglobal((1,0,0)) = localtoglobalvec((1,0,0)) + origin
        //                        = (0,1,0) + (10,0,0) = (10,1,0)
        let g = f.localtoglobal(v(1.0, 0.0, 0.0));
        assert!(close(g, v(10.0, 1.0, 0.0)));

        // globaltolocal is the exact inverse of localtoglobal.
        assert!(close(f.globaltolocal(g), v(1.0, 0.0, 0.0)));
    }

    #[test]
    fn plane_localtoglobal_rotates_plane() {
        // Local plane x = 2  →  N=(1,0,0), d=-2  (N·P + d = 0).
        let local = Plane {
            normal: v(1.0, 0.0, 0.0),
            d: -2.0,
        };

        // Identity frame leaves the plane unchanged.
        let same = Frame::identity().plane_localtoglobal(&local);
        assert!(close(same.normal, v(1.0, 0.0, 0.0)));
        assert!((same.d - (-2.0)).abs() < EPS, "d={}", same.d);

        // +90°-about-Z frame at origin (10,0,0). Hand-derived:
        //   N_global = localtoglobalvec((1,0,0)) = (0,1,0)
        //   foot     = N*(-d) = (2,0,0)
        //   foot_g   = localtoglobal((2,0,0)) = (0,2,0)+(10,0,0) = (10,2,0)
        //   d        = -dot((0,1,0),(10,2,0)) = -2
        // ⇒ global plane y = 2. (Any local (2,y,z) ↦ global (10-y,2,z).)
        let f = rot_z_90(v(10.0, 0.0, 0.0));
        let g = f.plane_localtoglobal(&local);
        assert!(close(g.normal, v(0.0, 1.0, 0.0)), "n={:?}", g.normal);
        assert!((g.d - (-2.0)).abs() < EPS, "d={}", g.d);
    }

    #[test]
    fn plane_localtoglobal_with_offset_shifts_d() {
        // Same +90° frame and local plane x=2 → global y=2 (d=-2), but now
        // add the cross-cell landblock offset (5,7,0). The foot-point moves
        // to (10,2,0)+(5,7,0) = (15,9,0); the normal is unchanged.
        //   d = -dot((0,1,0),(15,9,0)) = -9
        // i.e. d shifts by -dot(N, offset) = -7 (from -2 to -9).
        let local = Plane {
            normal: v(1.0, 0.0, 0.0),
            d: -2.0,
        };
        let f = rot_z_90(v(10.0, 0.0, 0.0));
        let g = f.plane_localtoglobal_with_offset(&local, v(5.0, 7.0, 0.0));
        assert!(close(g.normal, v(0.0, 1.0, 0.0)), "n={:?}", g.normal);
        assert!((g.d - (-9.0)).abs() < EPS, "d={}", g.d);

        // An offset parallel to the plane (along N=±0 in y) leaves d alone:
        // offset (0,0,24) is orthogonal to N=(0,1,0) ⇒ d stays -2.
        let g2 = f.plane_localtoglobal_with_offset(&local, v(0.0, 0.0, 24.0));
        assert!((g2.d - (-2.0)).abs() < EPS, "d={}", g2.d);
    }
}
