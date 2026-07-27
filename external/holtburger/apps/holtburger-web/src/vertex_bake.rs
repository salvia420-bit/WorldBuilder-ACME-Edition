//! RND-04 — retail static-light vertex bake (the arithmetic core).
//!
//! Port of `D3DPolyRender::SetStaticLightingVertexColors` (acclient.c:454918)
//! and `calc_point_light` (acclient.c:454579). Retail runs this lazily at
//! draw time on `cell->constructed_mesh` (`DrawEnvCell` acclient.c:456900)
//! against the current `Render::world_lights` static pool; we run it once at
//! cell-mesh pack time against the cell's own + `VisibleCells` static lights,
//! which is a superset-equivalent of retail's pool input for any light that
//! can reach the cell AND is stable (retail's count-triggered re-burn,
//! acclient.c:454945, is an artifact of the lazy timing — not a visual).
//!
//! DELIBERATELY DEPENDENCY-FREE: every input is a plain `[f32; 3]` in the
//! TARGET MESH's LOCAL frame. Retail converts each light into that frame
//! first (`LIGHTINFO::convert_to_local` acclient.c:454319 — full affine
//! `globaltolocal` for positional types 0/2, rotation-only
//! `get_vector_heading` + `globaltolocalvec` for directional type 1); the
//! caller does that via [`rotate_by_conjugate`]. No wasm-bindgen, no
//! `holtburger_common`, no `std` collections — so the offline
//! Rust-vs-Python differ compiles this exact file unchanged.

/// acclient.c:45774 `static_light_factor`. `range = falloff * 1.3`.
/// Single source of truth for the Rust side; the JS live-light path applies
/// the same constant exactly once in `makeThreeLightForSetupLight`
/// (`STATIC_LIGHT_FACTOR`, lighting.js) — `collect_setup_model_lights`
/// surfaces RAW falloff, so there is no double-multiply anywhere.
pub const STATIC_LIGHT_FACTOR: f32 = 1.3;

/// acclient.c:454608 half-Lambert wrap: `(N·D + 0.5*d) / 1.5`. The decomp
/// spells the constants as `(0.75 + 0.75 - 1.0)` and `1.0 / (0.75 + 0.75)`.
const WRAP_BIAS: f32 = 0.5;
const WRAP_RECIP: f32 = 1.0 / 1.5;

/// acclient.c:45530 `Render::max_static_lights`. Retail drops the farthest
/// light when the pool is full (`Render::insert_light` acclient.c:380540).
pub const MAX_STATIC_LIGHTS: usize = 40;

/// `LIGHTINFO::type` (acclient.h:31688). The bake's outer loop
/// (acclient.c:454987-455010) dispatches on it: `0` → `calc_point_light`,
/// `1` → the directional form, and **any other value contributes NOTHING**
/// (the `if (type) { if (type == 1) {...} }` has no else — spot/type-2
/// lights are simply absent from the static bake).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BakeLightKind {
    Point,
    Directional,
}

/// One static light already converted into the target mesh's local frame.
#[derive(Clone, Copy, Debug)]
pub struct BakeLight {
    pub kind: BakeLightKind,
    /// `Point`: the light's local-frame ORIGIN.
    /// `Directional`: the local-frame heading VECTOR (magnitude carries no
    /// meaning in retail's directional branch beyond scaling `N·L`).
    pub offset: [f32; 3],
    /// Linear 0..1 per channel — retail's `RGBColor` after the ARGB unpack.
    /// NOT gamma-decoded: retail stores the authored byte triple straight
    /// into the D3D vertex diffuse, so the baked bytes stay in the authored
    /// (sRGB) space and the consumer decodes.
    pub color: [f32; 3],
    pub intensity: f32,
    /// RAW authored falloff — this function applies [`STATIC_LIGHT_FACTOR`].
    pub falloff: f32,
}

/// `calc_point_light` acclient.c:454579, term for term.
///
/// `D` is UNNORMALISED, so `N·D == d * (N·L̂)` for a unit `N` and the wrap
/// term is retail's half-Lambert `(N·L̂ + 0.5) / 1.5`. The `d2 <= 1` arm
/// divides by `d` only (no inverse-square inside 1 m); outside it the
/// `wrap / (d2 * d)` form is the 1/d² law.
#[inline]
pub fn accumulate_point_light(
    pos: [f32; 3],
    nrm: [f32; 3],
    light: &BakeLight,
    rgb: &mut [f32; 3],
) {
    let dx = light.offset[0] - pos[0];
    let dy = light.offset[1] - pos[1];
    let dz = light.offset[2] - pos[2];
    let d2 = dz * dz + dy * dy + dx * dx;
    let d = d2.sqrt();
    let range = light.falloff * STATIC_LIGHT_FACTOR;
    if d < range {
        let wrap = (WRAP_BIAS * d + nrm[2] * dz + nrm[1] * dy + nrm[0] * dx) * WRAP_RECIP;
        if wrap > 0.0 {
            let atten = if d2 <= 1.0 { wrap / d } else { wrap / (d2 * d) };
            let k = atten * ((1.0 - d / range) * light.intensity);
            // PER-CHANNEL clamp to the light's own colour (acclient.c:454616-
            // 454627): with the authored intensity 100 this is what makes a
            // lamp saturate to exactly its own tint across most of its range
            // instead of washing toward white.
            let mut i = 0;
            while i < 3 {
                let c = light.color[i];
                let contrib = k * c;
                rgb[i] += if contrib > c { c } else { contrib };
                i += 1;
            }
        }
    }
}

/// Directional form, acclient.c:454990-455000. No distance terms and — note
/// — NO per-channel clamp; only the final [0,1] clamp bounds it.
#[inline]
pub fn accumulate_directional_light(nrm: [f32; 3], light: &BakeLight, rgb: &mut [f32; 3]) {
    let n_dot_l =
        light.offset[2] * nrm[2] + light.offset[0] * nrm[0] + light.offset[1] * nrm[1];
    if n_dot_l > 0.0 {
        let k = n_dot_l * light.intensity;
        let mut i = 0;
        while i < 3 {
            rgb[i] += light.color[i] * k;
            i += 1;
        }
    }
}

/// Per-vertex accumulate → clamp → pack, acclient.c:454940-455040.
///
/// `positions` / `normals` are flat xyz triples IN THE MESH's LOCAL FRAME,
/// one entry per vertex (the pack path emits 9 floats per triangle, i.e. 3
/// vertices, un-indexed — the bake is per emitted vertex exactly as retail
/// walks the D3D vertex buffer). Output is 3 bytes per vertex.
///
/// `lights` EMPTY is meaningful, not a no-op: retail leaves rgb at 0 and
/// still writes the diffuse (acclient.c:455037), i.e. a cell with no static
/// light bakes to BLACK. Under emissive-add semantics black contributes
/// nothing, which is the correct outcome.
pub fn bake_vertex_colors(positions: &[f32], normals: &[f32], lights: &[BakeLight]) -> Vec<u8> {
    let vert_count = positions.len() / 3;
    let mut out = vec![0u8; vert_count * 3];
    for v in 0..vert_count {
        let base = v * 3;
        let pos = [positions[base], positions[base + 1], positions[base + 2]];
        // A short normals array is a malformed mesh, not a crash: a zero
        // normal makes every wrap term `0.5*d/1.5 > 0`, i.e. omnidirectional
        // — visually obvious, and it cannot panic.
        let nrm = if normals.len() >= base + 3 {
            [normals[base], normals[base + 1], normals[base + 2]]
        } else {
            [0.0, 0.0, 0.0]
        };
        let mut rgb = [0.0f32; 3];
        for light in lights {
            match light.kind {
                BakeLightKind::Point => accumulate_point_light(pos, nrm, light, &mut rgb),
                BakeLightKind::Directional => {
                    accumulate_directional_light(nrm, light, &mut rgb)
                }
            }
        }
        for c in 0..3 {
            let mut x = rgb[c];
            if x >= 0.0 {
                if x > 1.0 {
                    x = 1.0;
                }
            } else {
                x = 0.0;
            }
            // acclient.c:455037 casts through an integer: TRUNCATION toward
            // zero, not rounding. `as u8` on an f32 in [0,255] does the same.
            out[base + c] = (x * 255.0) as u8;
        }
    }
    out
}

/// `Frame::globaltolocal` (the rotation half): `conj(q) * v`, with `q` in
/// AC wire order `[w, x, y, z]`. Same expansion as
/// `holtburger_common::Quaternion::rotate_vector`, with the vector part
/// negated — kept here so the offline differ links the identical code.
#[inline]
pub fn rotate_by_conjugate(q: [f32; 4], v: [f32; 3]) -> [f32; 3] {
    let (w, x, y, z) = (q[0], -q[1], -q[2], -q[3]);
    let xx = x * x;
    let yy = y * y;
    let zz = z * z;
    let xy = x * y;
    let xz = x * z;
    let yz = y * z;
    let wx = w * x;
    let wy = w * y;
    let wz = w * z;
    [
        v[0] * (1.0 - 2.0 * (yy + zz)) + v[1] * (2.0 * (xy - wz)) + v[2] * (2.0 * (xz + wy)),
        v[0] * (2.0 * (xy + wz)) + v[1] * (1.0 - 2.0 * (xx + zz)) + v[2] * (2.0 * (yz - wx)),
        v[0] * (2.0 * (xz - wy)) + v[1] * (2.0 * (yz + wx)) + v[2] * (1.0 - 2.0 * (xx + yy)),
    ]
}

/// `q * v` (forward rotate), AC wire order `[w, x, y, z]`. Used to place a
/// Setup light at `stab.frame ∘ ViewSpaceLocation.origin`.
#[inline]
pub fn rotate_by(q: [f32; 4], v: [f32; 3]) -> [f32; 3] {
    rotate_by_conjugate([q[0], -q[1], -q[2], -q[3]], v)
}

/// Squared distance from `p` to the AABB `[min, max]` (0 inside). Used to
/// drop lights that provably cannot reach a cell before the O(V·L) loop —
/// an EXACT cull (the `d < range` guard would reject every vertex anyway),
/// not an approximation.
#[inline]
pub fn dist_sq_point_aabb(p: [f32; 3], min: [f32; 3], max: [f32; 3]) -> f32 {
    let mut acc = 0.0f32;
    for c in 0..3 {
        let v = p[c];
        if v < min[c] {
            let d = min[c] - v;
            acc += d * d;
        } else if v > max[c] {
            let d = v - max[c];
            acc += d * d;
        }
    }
    acc
}

/// Reach test for the pre-cull: a point light contributes to a vertex only
/// while `d < falloff * 1.3`, so a light whose sphere misses the mesh's AABB
/// contributes to nothing. Directional lights always reach.
#[inline]
pub fn light_reaches_aabb(light: &BakeLight, min: [f32; 3], max: [f32; 3]) -> bool {
    match light.kind {
        BakeLightKind::Directional => true,
        BakeLightKind::Point => {
            let range = light.falloff * STATIC_LIGHT_FACTOR;
            if !(range > 0.0) {
                return false;
            }
            dist_sq_point_aabb(light.offset, min, max) < range * range
        }
    }
}

/// One static light placed in LANDBLOCK-LOCAL space
/// (`stab.frame ∘ LightInfo.ViewSpaceLocation.origin`), the space every
/// EnvCell frame in a landblock already lives in.
///
/// Deliberately NOT world space: the landblock corner offset reaches
/// 0xFF*192 = 48 960 m, and adding it before the per-cell subtraction burns
/// ~3 decimal digits of f32 mantissa on positions authored to millimetres.
/// The cell frame carries the same offset, so it cancels.
#[derive(Clone, Copy, Debug)]
pub struct PlacedLight {
    pub pos: [f32; 3],
    pub color: [f32; 3],
    pub intensity: f32,
    pub falloff: f32,
}

/// Outcome of [`select_cell_pool`] — the lights that actually reach a cell,
/// converted into its local frame, plus whether the retail cap bound.
pub struct CellPool {
    pub lights: Vec<BakeLight>,
    /// How many reaching lights were dropped by [`MAX_STATIC_LIGHTS`]. Callers
    /// MUST surface a non-zero value; a silently truncated pool reads as
    /// "covered everything" when it did not.
    pub dropped_by_cap: usize,
}

/// Retail's pool-input selection for ONE cell, ported.
///
/// `candidates` is the cell's own static lights followed by those of its
/// `VisibleCells` (retail: `CEnvCell::flush_cells` acclient.c:349880 walking
/// the visible-cell table into `CObjCell::add_static_to_global_lights`
/// acclient.c:346859). Order matters only for cap tie-breaks; it is caller-
/// deterministic, and the sort below is stable, so a landblock always bakes
/// to the same bytes.
///
/// Each surviving light is converted into the cell frame exactly as
/// `LIGHTINFO::convert_to_local` (acclient.c:454319) does for a positional
/// light: `conj(q) * (p - origin)`.
pub fn select_cell_pool(
    cell_origin: [f32; 3],
    cell_q: [f32; 4],
    candidates: &[PlacedLight],
    bbox_min: [f32; 3],
    bbox_max: [f32; 3],
) -> CellPool {
    let mut lights: Vec<BakeLight> = Vec::new();
    for l in candidates {
        let local = rotate_by_conjugate(
            cell_q,
            [
                l.pos[0] - cell_origin[0],
                l.pos[1] - cell_origin[1],
                l.pos[2] - cell_origin[2],
            ],
        );
        let bl = BakeLight {
            kind: BakeLightKind::Point,
            offset: local,
            color: l.color,
            intensity: l.intensity,
            falloff: l.falloff,
        };
        // EXACT cull, not an approximation: `calc_point_light` rejects every
        // vertex with `d >= falloff * 1.3`, so a light whose sphere misses
        // the mesh AABB contributes zero to every vertex by construction.
        if !light_reaches_aabb(&bl, bbox_min, bbox_max) {
            continue;
        }
        lights.push(bl);
    }
    let mut dropped_by_cap = 0;
    if lights.len() > MAX_STATIC_LIGHTS {
        // `Render::max_static_lights` = 40 (acclient.c:45530). Retail ranks by
        // VIEWER distance; at bake time there is no viewer, so rank by
        // distance to the cell's own centre — deterministic and frame-
        // independent. The reach cull above means this essentially never binds.
        let centre = [
            (bbox_min[0] + bbox_max[0]) * 0.5,
            (bbox_min[1] + bbox_max[1]) * 0.5,
            (bbox_min[2] + bbox_max[2]) * 0.5,
        ];
        let key = |b: &BakeLight| -> f32 {
            let d0 = b.offset[0] - centre[0];
            let d1 = b.offset[1] - centre[1];
            let d2 = b.offset[2] - centre[2];
            d0 * d0 + d1 * d1 + d2 * d2
        };
        lights.sort_by(|a, b| key(a).partial_cmp(&key(b)).unwrap_or(core::cmp::Ordering::Equal));
        dropped_by_cap = lights.len() - MAX_STATIC_LIGHTS;
        lights.truncate(MAX_STATIC_LIGHTS);
    }
    CellPool {
        lights,
        dropped_by_cap,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lamp(offset: [f32; 3], falloff: f32) -> BakeLight {
        // The Cragstone meeting-hall lamp, Setup 0x020005D9: ARGB(255,255,150,80),
        // intensity 100 (dat-dumps/meeting_hall_cragstone_0x0121.json).
        BakeLight {
            kind: BakeLightKind::Point,
            offset,
            color: [1.0, 150.0 / 255.0, 80.0 / 255.0],
            intensity: 100.0,
            falloff,
        }
    }

    #[test]
    fn saturates_to_lamp_colour_inside_the_falloff() {
        // Facing the lamp 1.5 m away, intensity 100 → k ≫ 1 → every channel
        // pins at the light's own colour (the per-channel min).
        let out = bake_vertex_colors(&[0.0, 0.0, 0.0], &[0.0, 0.0, 1.0], &[lamp([0.0, 0.0, 1.5], 4.0)]);
        assert_eq!(out, vec![255, 150, 80]);
    }

    #[test]
    fn no_contribution_beyond_range() {
        // falloff 4 → range 5.2; a lamp at 6 m is out of reach entirely.
        let out = bake_vertex_colors(&[0.0, 0.0, 0.0], &[0.0, 0.0, 1.0], &[lamp([0.0, 0.0, 6.0], 4.0)]);
        assert_eq!(out, vec![0, 0, 0]);
        assert!(!light_reaches_aabb(&lamp([0.0, 0.0, 6.0], 4.0), [0.0; 3], [0.0; 3]));
    }

    #[test]
    fn back_face_is_dark_but_the_wrap_is_not_a_hard_terminator() {
        // N·L̂ = -1 → wrap = (-1 + 0.5)/1.5 < 0 → rejected.
        let out = bake_vertex_colors(&[0.0, 0.0, 0.0], &[0.0, 0.0, -1.0], &[lamp([0.0, 0.0, 1.5], 4.0)]);
        assert_eq!(out, vec![0, 0, 0]);
        // N·L̂ = 0 (grazing) → wrap = 0.5/1.5 > 0 → still lit, unlike a raw
        // saturate(dot(N,L)) which would clamp to black here.
        let out = bake_vertex_colors(&[0.0, 0.0, 0.0], &[1.0, 0.0, 0.0], &[lamp([0.0, 0.0, 1.5], 4.0)]);
        assert!(out[0] > 0, "grazing angle must survive the half-Lambert wrap");
    }

    #[test]
    fn empty_light_set_bakes_black() {
        let out = bake_vertex_colors(&[0.0, 0.0, 0.0], &[0.0, 0.0, 1.0], &[]);
        assert_eq!(out, vec![0, 0, 0]);
    }

    #[test]
    fn conjugate_rotation_round_trips() {
        // The fixture stab quat: 90 deg about Z (AC wire order w,x,y,z).
        let q = [0.707107f32, 0.0, 0.0, -0.707107];
        let v = [0.0175f32, 0.0, -1.27];
        let fwd = rotate_by(q, v);
        let back = rotate_by_conjugate(q, fwd);
        for c in 0..3 {
            assert!((back[c] - v[c]).abs() < 1e-5, "round-trip drift on axis {c}");
        }
        // Matches the fixture's precomputed lbLocalPos delta for cell
        // 0xA9B40101 (stab origin + rotated view-space origin).
        assert!((fwd[0] - 0.0).abs() < 1e-4);
        assert!((fwd[1] + 0.0175).abs() < 1e-4);
        assert!((fwd[2] + 1.27).abs() < 1e-4);
    }
}
