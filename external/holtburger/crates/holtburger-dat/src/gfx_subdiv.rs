//! Geometric relief for render meshes — subdivision + outward displacement.
//!
//! Sibling of [`crate::terrain_subdiv`], and deliberately built to the same
//! contract: **visual only**. Retail's own format separates collision from
//! visuals — a `GfxObj` carries `physics_polygons` + `physics_bsp` alongside a
//! *separate* `polygons` + `drawing_bsp`, and `CGfxObj::find_obj_collisions`
//! (acclient.c:356515) touches only the physics side. `CellStruct` has the same
//! split. Amplifying drawing geometry is the engine's native architecture.
//!
//! # The one rule
//!
//! Physics and rendering share exactly one datum: the object's `vertex_array`.
//! **Never mutate it.** Everything here reads positions out and displaces the
//! *emitted* triangles. Mutating the shared array would move collision polygon
//! vertices, desync polygon planes from their (unmoved) BSP splitting planes,
//! and inflate broad-phase AABBs.
//!
//! # Why material identity, not image luminance
//!
//! The obvious approach — derive height from texture brightness — is wrong here
//! for two independent reasons, both measured on 2026-07-30:
//!
//! 1. **Polarity.** On a Tudor wall the timber is DARK and the plaster LIGHT, so
//!    a luminance-derived height pushes the beams *into* the wall. Backwards.
//!    Integrating gradients (`normal_gen::height_from_luminance`) does not fix
//!    this: integrating ∇L reconstructs L up to a constant.
//! 2. **Banding.** That function integrates each row independently, so rows
//!    drift relative to one another. On vertical plank textures — precisely the
//!    Tudor case — it returns horizontal corrugation and destroys the planks.
//!
//! So relief is decided by **material identity**: every render polygon carries
//! `pos_surface`, so we know the Surface behind every triangle, and a Surface
//! maps to a class with a fixed outward amplitude
//! (`crate::gfx_material_class`). Timber protrudes because we say it does.
//!
//! # Welding, and why displacement is per SOURCE vertex
//!
//! AC polygons carry *per-face UVs*: the same source vertex presents different
//! UVs to adjacent polygons, so the emitted triangle soup is de-indexed and a
//! wall face has a UV seam at every polygon boundary. Displacing per emitted
//! corner would therefore open visible slits across every building.
//!
//! Instead [`weld_vertex_amplitudes`] averages the amplitude over every polygon
//! that references a source vertex, so two polygons sharing a vertex always
//! displace it identically — no cracks, by construction. The cost is that a
//! material boundary ramps rather than steps; subdivision confines that ramp to
//! one sub-triangle (see [`subdivide_displaced_triangle`]).
//!
//! # Direction: outward only
//!
//! Displacement is along the *authored* normal and never negative. The other
//! side of an exterior building wall is an interior `CellStruct` wall with its
//! own texture; both surfaces' normals point away from the solid between them,
//! so outward-only means the wall can only get thicker. The two faces can never
//! interpenetrate regardless of how their materials classify.
//!
//! Because the collision hull does not move, displaced geometry protrudes past
//! it by the amplitude. That is the accepted trade (same as terrain subdivision,
//! which clamps visual-vs-collision divergence explicitly) and is why
//! [`MAX_AMPLITUDE_M`] is small.

use std::collections::{HashMap, HashSet};

use crate::graphics::Polygon;

/// Hard ceiling on outward displacement, in metres.
///
/// From the project constraint recorded in `docs/terrainplan.md`: *"cap any
/// displacement at ~≤10 cm and noisy (pebbles, ruts, mortar). Never systematic
/// large offsets."* Also bounds how far render geometry can protrude past the
/// unmoved collision hull.
pub const MAX_AMPLITUDE_M: f32 = 0.10;

/// `Polygon::stippling` bit meaning "no positive side" — the polygon is not
/// rendered front-facing. Mirrors the triangulators in `lib.rs`.
const NO_POS: u8 = 0x04;

/// `Polygon::sides_type` == `CullMode::None` — the real TWO-SIDED marker.
///
/// These are alpha cards (banners, foliage, fences): displacing them thickens
/// a zero-thickness sheet and makes its two faces disagree.
///
/// This was `0x2` until 2026-07-30, which was wrong and near-inert. Retail
/// culls on `sides_type == 1 ? CULLMODE_NONE : CULLMODE_CW`
/// (acclient `D3DPolyRender` @455346, mirrored at `Tri::sides_type` in
/// `apps/holtburger-web/src/lib.rs` and at `adapter.js` `dbl = sidesTypes[t] === 1`).
/// Measured over every GfxObj polygon in `client_portal.dat`:
/// `Landblock(0x0)` 334,021 · **`None(0x1)` 65,508** · `Clockwise(0x2)` **1**.
/// So the old constant excluded a single polygon in the entire dat and let
/// every real alpha card through.
const SIDES_CULL_NONE: i32 = 0x1;

/// `Polygon::sides_type` == `CullMode::Clockwise` — the polygon's back face is
/// drawn with its own DIFFERENT surface (`neg_surface`, and `neg_uv_indices` is
/// populated only for this value). Also excluded: the front and back tris are
/// emitted from the same source vertices with opposed normals, so an
/// outward-only displacement would push them apart and split the sheet.
const SIDES_DISTINCT_BACK: i32 = 0x2;

/// How finely to subdivide, and how hard to push.
#[derive(Copy, Clone, Debug, PartialEq)]
pub struct ReliefConfig {
    /// 0 = no subdivision (1 tri), 1 = 4 tris, 2 = 16 tris per source triangle.
    ///
    /// Subdivision does not add relief on its own — a uniform-material polygon
    /// displaces rigidly either way. What it buys is *localisation*: with more
    /// interior vertices the material-boundary ramp is confined to a narrower
    /// band, so a beam reads as a step rather than a swell.
    pub level: u8,
    /// Multiplier on every class amplitude. 0.0 disables relief entirely while
    /// leaving subdivision in place (useful as an A/B control).
    pub scale: f32,
}

impl Default for ReliefConfig {
    fn default() -> Self {
        Self { level: 1, scale: 1.0 }
    }
}

impl ReliefConfig {
    /// Segments per triangle edge: 1, 2 or 4. Levels above 2 are clamped —
    /// this is a visual-detail knob, not a tessellation benchmark, and the
    /// measured budget (2026-07-30) puts the streaming/memory wall near 4x.
    #[inline]
    pub fn segments(&self) -> u32 {
        match self.level {
            0 => 1,
            1 => 2,
            _ => 4,
        }
    }

    /// True when this config cannot change any vertex position, so callers can
    /// skip the whole path and keep byte-identical output.
    #[inline]
    pub fn is_noop(&self) -> bool {
        self.level == 0 && !(self.scale > 0.0)
    }
}

/// Per-source-vertex outward displacement in metres, welded across every
/// polygon that references the vertex.
///
/// `amp_for_surface` maps a Surface DataID to its class amplitude in metres
/// (see `crate::gfx_material_class`); it is passed in rather than called
/// directly so this module stays testable without the baked table.
///
/// A vertex touched by *any* excluded polygon is pinned to zero rather than
/// averaged. A wall vertex that happens to be shared with a hanging banner
/// therefore stays put — preferring "no motion" over "half motion" keeps the
/// banner's two faces from separating.
///
/// `portal_poly_ids` is empty for `GfxObj`; for `CellStruct` it is
/// `portal_poly_ids`, the doorway quads that drive portal culling and the
/// stencil renderer. Those must never move.
pub fn weld_vertex_amplitudes(
    polygons: &HashMap<u16, Polygon>,
    surfaces: &[u32],
    portal_poly_ids: &[u16],
    scale: f32,
    amp_for_surface: &dyn Fn(u32) -> f32,
) -> HashMap<u16, f32> {
    let mut accum: HashMap<u16, (f32, u32)> = HashMap::new();
    let mut pinned: HashSet<u16> = HashSet::new();
    let portals: HashSet<u16> = portal_poly_ids.iter().copied().collect();

    // Deterministic order: a HashMap walk is unordered, and f32 addition is not
    // associative, so an unordered accumulate would make the output depend on
    // hash iteration order and break byte-reproducibility between runs.
    let mut poly_ids: Vec<u16> = polygons.keys().copied().collect();
    poly_ids.sort_unstable();

    for pid in poly_ids {
        let poly = &polygons[&pid];
        if poly.vertex_ids.len() < 3 {
            continue;
        }

        let excluded = (poly.stippling & NO_POS) != 0
            || poly.sides_type == SIDES_CULL_NONE
            || poly.sides_type == SIDES_DISTINCT_BACK
            || portals.contains(&pid);

        if excluded {
            for &raw in &poly.vertex_ids {
                if raw >= 0 {
                    pinned.insert(raw as u16);
                }
            }
            continue;
        }

        let did = if poly.pos_surface >= 0 && (poly.pos_surface as usize) < surfaces.len() {
            surfaces[poly.pos_surface as usize]
        } else {
            0
        };
        let amp = if did == 0 {
            0.0
        } else {
            amp_for_surface(did).clamp(0.0, MAX_AMPLITUDE_M) * scale
        };

        for &raw in &poly.vertex_ids {
            if raw < 0 {
                continue;
            }
            let e = accum.entry(raw as u16).or_insert((0.0, 0));
            e.0 += amp;
            e.1 += 1;
        }
    }

    let mut out = HashMap::with_capacity(accum.len());
    for (vid, (sum, n)) in accum {
        if pinned.contains(&vid) || n == 0 {
            continue;
        }
        let a = sum / n as f32;
        // Outward only, and never past the ceiling however `scale` was set.
        if a > 0.0 {
            out.insert(vid, a.min(MAX_AMPLITUDE_M));
        }
    }
    out
}

#[inline]
fn norm3(v: [f32; 3]) -> Option<[f32; 3]> {
    let l2 = v[0] * v[0] + v[1] * v[1] + v[2] * v[2];
    if l2 <= 1e-12 {
        return None;
    }
    let inv = 1.0 / l2.sqrt();
    Some([v[0] * inv, v[1] * inv, v[2] * inv])
}

#[inline]
fn smoothstep01(x: f32) -> f32 {
    let t = x.clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// Subdivide one triangle and displace every resulting vertex outward.
///
/// `corner_amp` is the welded amplitude at each corner (from
/// [`weld_vertex_amplitudes`]); `face_amp` is the amplitude of *this*
/// triangle's own material.
///
/// Interior sub-vertices blend from the barycentric-interpolated corner value
/// toward `face_amp`, weighted by distance from the triangle edges. On a
/// triangle entirely inside one material every corner already equals
/// `face_amp`, so the blend is a no-op and the face displaces rigidly. On a
/// triangle straddling a material boundary it flattens the interior to the
/// face's own height and confines the ramp to the shared edge — which is what
/// turns a swell into a step.
///
/// Corners are always emitted at exactly their welded amplitude, so adjacent
/// triangles sharing a corner agree to the bit and no crack can open.
///
/// `emit` receives (positions, uvs, normals) per output triangle, in the same
/// winding as the input. Normals are the interpolated *authored* normals — the
/// displaced surface is shaded as the original smooth surface, which is correct
/// for small amplitudes and avoids a normal recompute the JS side does not do.
/// Per-texel relief for one triangle.
///
/// `height` maps a UV to `[0, 1]`, where **1 is a proud face and 0 is the
/// bottom of a groove**. Displacement becomes `face_amp * height(uv)`, so
/// everything still moves outward only and grooves are carved by leaving them
/// behind rather than by pushing inward.
///
/// `boundary` marks which of the triangle's three edges — `(0,1)`, `(1,2)`,
/// `(2,0)` — lie on an original polygon boundary rather than being an interior
/// fan diagonal.
///
/// That distinction is load-bearing. AC carries per-face UVs, so the polygon on
/// the other side of a boundary edge samples the height field at a *different*
/// UV and would displace the shared edge differently — a slit. So height
/// modulation fades to the welded corner amplitude as a boundary edge is
/// approached, which pins shared edges to a value both polygons agree on. Fan
/// diagonals are interior to one polygon and share UVs, so they keep full
/// relief; suppressing those instead would stamp a visible ridge down the
/// middle of every quad.
pub struct ReliefSampler<'a> {
    pub height: &'a dyn Fn([f32; 2]) -> f32,
    pub boundary: [bool; 3],
}

pub fn subdivide_displaced_triangle<F>(
    pos: [[f32; 3]; 3],
    uv: [[f32; 2]; 3],
    nrm: [[f32; 3]; 3],
    corner_amp: [f32; 3],
    face_amp: f32,
    cfg: ReliefConfig,
    emit: &mut F,
) where
    F: FnMut([[f32; 3]; 3], [[f32; 2]; 3], [[f32; 3]; 3]),
{
    subdivide_displaced_triangle_sampled(pos, uv, nrm, corner_amp, face_amp, cfg, None, emit)
}

/// [`subdivide_displaced_triangle`] with an optional per-texel height field.
pub fn subdivide_displaced_triangle_sampled<F>(
    pos: [[f32; 3]; 3],
    uv: [[f32; 2]; 3],
    nrm: [[f32; 3]; 3],
    corner_amp: [f32; 3],
    face_amp: f32,
    cfg: ReliefConfig,
    sampler: Option<&ReliefSampler<'_>>,
    emit: &mut F,
) where
    F: FnMut([[f32; 3]; 3], [[f32; 2]; 3], [[f32; 3]; 3]),
{
    let n = cfg.segments();

    // Fast path: nothing to subdivide and nothing to move.
    if n == 1 && corner_amp == [0.0; 3] && (sampler.is_none() || face_amp <= 0.0) {
        emit(pos, uv, nrm);
        return;
    }

    let inv_n = 1.0 / n as f32;
    // Grid of (i, j) with i + j <= n, barycentric w = (n-i-j, i, j) / n.
    let idx = |i: u32, j: u32| -> usize { ((i * (2 * n + 3 - i)) / 2 + j) as usize };
    let count = ((n + 1) * (n + 2) / 2) as usize;
    let mut gp: Vec<[f32; 3]> = Vec::with_capacity(count);
    let mut gu: Vec<[f32; 2]> = Vec::with_capacity(count);
    let mut gn: Vec<[f32; 3]> = Vec::with_capacity(count);

    for i in 0..=n {
        for j in 0..=(n - i) {
            let w1 = i as f32 * inv_n;
            let w2 = j as f32 * inv_n;
            let w0 = 1.0 - w1 - w2;

            let p = [
                pos[0][0] * w0 + pos[1][0] * w1 + pos[2][0] * w2,
                pos[0][1] * w0 + pos[1][1] * w1 + pos[2][1] * w2,
                pos[0][2] * w0 + pos[1][2] * w1 + pos[2][2] * w2,
            ];
            let t = [
                uv[0][0] * w0 + uv[1][0] * w1 + uv[2][0] * w2,
                uv[0][1] * w0 + uv[1][1] * w1 + uv[2][1] * w2,
            ];
            let nv = [
                nrm[0][0] * w0 + nrm[1][0] * w1 + nrm[2][0] * w2,
                nrm[0][1] * w0 + nrm[1][1] * w1 + nrm[2][1] * w2,
                nrm[0][2] * w0 + nrm[1][2] * w1 + nrm[2][2] * w2,
            ];

            let welded = corner_amp[0] * w0 + corner_amp[1] * w1 + corner_amp[2] * w2;
            let amp = match sampler {
                None => {
                    // Per-material relief: blend toward this face's own
                    // amplitude away from the edges. `edge` is 0 on any edge
                    // (corners keep the welded value and stay crack-free) and
                    // 1 at the centroid.
                    let edge = smoothstep01(w0.min(w1).min(w2) * 3.0);
                    welded * (1.0 - edge) + face_amp * edge
                }
                Some(s) => {
                    // Per-texel relief. Fade to the welded amplitude only as an
                    // ORIGINAL POLYGON boundary is approached — the barycentric
                    // coordinate opposite an edge is zero on it, so edge (0,1)
                    // is gated by w2, (1,2) by w0, and (2,0) by w1. Interior fan
                    // diagonals are not boundaries and keep full relief.
                    let mut d = 1.0f32;
                    if s.boundary[0] {
                        d = d.min(w2);
                    }
                    if s.boundary[1] {
                        d = d.min(w0);
                    }
                    if s.boundary[2] {
                        d = d.min(w1);
                    }
                    let inner = smoothstep01(d * 3.0);
                    let h = (s.height)([t[0], t[1]]).clamp(0.0, 1.0);
                    welded * (1.0 - inner) + face_amp * h * inner
                }
            };

            let p = match norm3(nv) {
                // No authored normal to push along → leave the vertex where it
                // is. Neighbours substituting a different face normal here is
                // exactly what tears a mesh open.
                None => p,
                Some(un) if amp <= 0.0 => {
                    let _ = un;
                    p
                }
                Some(un) => [p[0] + un[0] * amp, p[1] + un[1] * amp, p[2] + un[2] * amp],
            };

            gp.push(p);
            gu.push(t);
            gn.push(nv);
        }
    }

    for i in 0..n {
        for j in 0..(n - i) {
            let a = idx(i, j);
            let b = idx(i + 1, j);
            let c = idx(i, j + 1);
            emit([gp[a], gp[b], gp[c]], [gu[a], gu[b], gu[c]], [gn[a], gn[b], gn[c]]);
            if i + j + 1 < n {
                let d = idx(i + 1, j + 1);
                emit([gp[b], gp[d], gp[c]], [gu[b], gu[d], gu[c]], [gn[b], gn[d], gn[c]]);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn poly(vertex_ids: Vec<i16>, pos_surface: i16, sides_type: i32, stippling: u8) -> Polygon {
        Polygon {
            num_pts: vertex_ids.len() as u8,
            stippling,
            sides_type,
            pos_surface,
            neg_surface: -1,
            pos_uv_indices: vec![0; vertex_ids.len()],
            neg_uv_indices: vec![],
            vertex_ids,
        }
    }

    /// Surface 10 is "timber" at 5 cm; everything else is flush.
    fn amp(did: u32) -> f32 {
        if did == 10 { 0.05 } else { 0.0 }
    }

    #[test]
    fn welds_shared_vertices_to_the_average() {
        let mut polys = HashMap::new();
        polys.insert(0, poly(vec![0, 1, 2], 0, 0, 0)); // timber
        polys.insert(1, poly(vec![1, 2, 3], 1, 0, 0)); // flush
        let surfaces = [10u32, 20u32];

        let w = weld_vertex_amplitudes(&polys, &surfaces, &[], 1.0, &amp);
        // Vertex 0 is timber-only → full amplitude.
        assert!((w[&0] - 0.05).abs() < 1e-6);
        // Vertices 1 and 2 straddle both → the average, i.e. a ramp not a step.
        assert!((w[&1] - 0.025).abs() < 1e-6);
        assert!((w[&2] - 0.025).abs() < 1e-6);
        // Vertex 3 is flush-only → absent (zero displacement).
        assert!(!w.contains_key(&3));
    }

    #[test]
    fn excluded_polygons_pin_their_vertices_to_zero() {
        // A two-sided banner and a clipmap card must not move, and must also
        // stop any wall vertex they share from moving.
        for (sides, stipple) in [(SIDES_CULL_NONE, 0u8), (SIDES_DISTINCT_BACK, 0u8), (0, NO_POS)] {
            let mut polys = HashMap::new();
            polys.insert(0, poly(vec![0, 1, 2], 0, 0, 0)); // timber wall
            polys.insert(1, poly(vec![2, 3, 4], 0, sides, stipple)); // excluded
            let w = weld_vertex_amplitudes(&polys, &[10u32], &[], 1.0, &amp);
            assert!((w[&0] - 0.05).abs() < 1e-6, "wall-only vertex still moves");
            assert!(!w.contains_key(&2), "shared vertex must be pinned");
            assert!(!w.contains_key(&3), "excluded-only vertex must be pinned");
        }
    }

    #[test]
    fn portal_polygons_never_move() {
        // Portal quads drive portal culling and the stencil renderer.
        let mut polys = HashMap::new();
        polys.insert(7, poly(vec![0, 1, 2], 0, 0, 0));
        let w = weld_vertex_amplitudes(&polys, &[10u32], &[7], 1.0, &amp);
        assert!(w.is_empty(), "portal polygon displaced its vertices");
    }

    #[test]
    fn amplitude_is_clamped_and_outward_only() {
        let mut polys = HashMap::new();
        polys.insert(0, poly(vec![0, 1, 2], 0, 0, 0));
        // A caller asking for 10x must still not exceed the ceiling.
        let w = weld_vertex_amplitudes(&polys, &[10u32], &[], 10.0, &amp);
        assert!(w[&0] <= MAX_AMPLITUDE_M + 1e-6);
        // Negative scale must never produce inward displacement.
        let w = weld_vertex_amplitudes(&polys, &[10u32], &[], -1.0, &amp);
        assert!(w.is_empty(), "negative scale produced inward displacement");
    }

    #[test]
    fn subdivision_emits_the_expected_triangle_counts() {
        for (level, want) in [(0u8, 1usize), (1, 4), (2, 16)] {
            let mut n = 0;
            subdivide_displaced_triangle(
                [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]],
                [[0.0, 0.0], [1.0, 0.0], [0.0, 1.0]],
                [[0.0, 0.0, 1.0]; 3],
                [0.0; 3],
                0.0,
                ReliefConfig { level, scale: 1.0 },
                &mut |_, _, _| n += 1,
            );
            assert_eq!(n, want, "level {level}");
        }
    }

    #[test]
    fn zero_amplitude_leaves_positions_untouched() {
        // The flag-off / flush-material path must be byte-identical.
        let p = [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]];
        let mut got = vec![];
        subdivide_displaced_triangle(
            p,
            [[0.0, 0.0], [1.0, 0.0], [0.0, 1.0]],
            [[0.0, 0.0, 1.0]; 3],
            [0.0; 3],
            0.0,
            ReliefConfig { level: 0, scale: 1.0 },
            &mut |q, _, _| got.push(q),
        );
        assert_eq!(got, vec![p]);
    }

    #[test]
    fn corners_displace_by_exactly_the_welded_amount() {
        // Two triangles sharing an edge must place that edge identically, or a
        // crack opens. Corner amplitude must ignore `face_amp` entirely.
        let mut corners = vec![];
        subdivide_displaced_triangle(
            [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]],
            [[0.0, 0.0]; 3],
            [[0.0, 0.0, 1.0]; 3],
            [0.05, 0.0, 0.0],
            0.05, // a very different face amplitude must not leak into corners
            ReliefConfig { level: 2, scale: 1.0 },
            &mut |q, _, _| corners.push(q),
        );
        // The level-2 grid's first vertex is barycentric corner 0.
        let first = corners[0][0];
        assert!((first[2] - 0.05).abs() < 1e-6, "corner 0 got {first:?}");
    }

    #[test]
    fn displacement_follows_the_normal_and_never_inverts() {
        let mut out = vec![];
        subdivide_displaced_triangle(
            [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]],
            [[0.0, 0.0]; 3],
            [[0.0, 0.0, -1.0]; 3], // normal points -Z
            [0.04; 3],
            0.04,
            ReliefConfig { level: 0, scale: 1.0 },
            &mut |q, _, _| out.push(q),
        );
        // Along -Z, i.e. outward along the authored normal, not along +Z.
        for v in out[0] {
            assert!((v[2] + 0.04).abs() < 1e-6, "expected -0.04, got {v:?}");
        }
    }

    #[test]
    fn degenerate_normals_do_not_displace() {
        let p = [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]];
        let mut out = vec![];
        subdivide_displaced_triangle(
            p,
            [[0.0, 0.0]; 3],
            [[0.0, 0.0, 0.0]; 3], // no authored normal anywhere
            [0.05; 3],
            0.05,
            ReliefConfig { level: 0, scale: 1.0 },
            &mut |q, _, _| out.push(q),
        );
        assert_eq!(out[0], p, "displaced along a degenerate normal");
    }

    /// Collect every emitted vertex as (position, uv).
    fn run_sampled(
        boundary: [bool; 3],
        height: &dyn Fn([f32; 2]) -> f32,
        corner_amp: [f32; 3],
        face_amp: f32,
    ) -> Vec<([f32; 3], [f32; 2])> {
        let mut out = vec![];
        let s = ReliefSampler { height, boundary };
        subdivide_displaced_triangle_sampled(
            [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]],
            [[0.0, 0.0], [1.0, 0.0], [0.0, 1.0]],
            [[0.0, 0.0, 1.0]; 3],
            corner_amp,
            face_amp,
            ReliefConfig { level: 2, scale: 1.0 },
            Some(&s),
            &mut |p, u, _| {
                for k in 0..3 {
                    out.push((p[k], u[k]));
                }
            },
        );
        out
    }

    #[test]
    fn per_texel_relief_carves_grooves_outward_only() {
        // Height 1 = proud face, 0 = groove bottom. Nothing may move inward.
        let pts = run_sampled([false; 3], &|uv| if uv[0] < 0.5 { 1.0 } else { 0.0 }, [0.05; 3], 0.05);
        let zs: Vec<f32> = pts.iter().map(|(p, _)| p[2]).collect();
        let hi = zs.iter().cloned().fold(f32::MIN, f32::max);
        let lo = zs.iter().cloned().fold(f32::MAX, f32::min);
        assert!((hi - 0.05).abs() < 1e-6, "proud face should reach face_amp, got {hi}");
        assert!(lo >= -1e-6, "groove displaced INWARD: {lo}");
    }

    #[test]
    fn boundary_edges_ignore_the_height_field() {
        // The polygon across a boundary edge samples a DIFFERENT uv, so the
        // shared edge must land on the welded amplitude regardless of height
        // or a slit opens. Edge (1,2) is the hypotenuse; it is gated by w0.
        let pts = run_sampled([false, true, false], &|_| 0.0, [0.04; 3], 0.04);
        for (p, uv) in &pts {
            // On edge (1,2), u + v == 1.
            if (uv[0] + uv[1] - 1.0).abs() < 1e-6 {
                assert!(
                    (p[2] - 0.04).abs() < 1e-6,
                    "boundary vertex at {uv:?} followed the height field: {p:?}"
                );
            }
        }
    }

    #[test]
    fn interior_diagonals_keep_full_relief() {
        // Same geometry, but the hypotenuse is now an interior fan diagonal.
        // It must NOT be pinned — otherwise every quad grows a ridge down its
        // middle where the two fan triangles meet.
        let pts = run_sampled([false; 3], &|_| 0.0, [0.04; 3], 0.04);
        let on_diag: Vec<f32> = pts
            .iter()
            .filter(|(_, uv)| (uv[0] + uv[1] - 1.0).abs() < 1e-6)
            .map(|(p, _)| p[2])
            .collect();
        assert!(!on_diag.is_empty());
        assert!(
            on_diag.iter().all(|z| *z < 0.04 - 1e-6),
            "interior diagonal was pinned to the welded amplitude: {on_diag:?}"
        );
    }

    #[test]
    fn interior_blends_to_the_face_amplitude_but_edges_do_not() {
        // Straddling triangle: corner 0 is interior to the material, 1 and 2
        // sit on the boundary at half amplitude. The centroid should pull back
        // up toward the face's own amplitude; the boundary edge must not.
        let mut pts = vec![];
        subdivide_displaced_triangle(
            [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]],
            [[0.0, 0.0]; 3],
            [[0.0, 0.0, 1.0]; 3],
            [0.06, 0.03, 0.03],
            0.06,
            ReliefConfig { level: 2, scale: 1.0 },
            &mut |q, _, _| pts.extend_from_slice(&q),
        );
        let zs: Vec<f32> = pts.iter().map(|p| p[2]).collect();
        let hi = zs.iter().cloned().fold(f32::MIN, f32::max);
        let lo = zs.iter().cloned().fold(f32::MAX, f32::min);
        assert!((hi - 0.06).abs() < 1e-6, "interior never reached face amp: {hi}");
        assert!((lo - 0.03).abs() < 1e-6, "boundary edge moved off welded: {lo}");
    }
}
