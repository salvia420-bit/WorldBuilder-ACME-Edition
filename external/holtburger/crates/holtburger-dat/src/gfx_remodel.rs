//! Texture-blind structural remodelling of render geometry.
//!
//! Sibling of [`crate::gfx_subdiv`], same visual-only contract, but a
//! fundamentally safer operation: this module is **purely additive**. It never
//! moves an existing vertex. Not one original triangle's position, uv, normal,
//! `surface_did`, `sides_type` or `stippling` changes — new triangles are
//! appended alongside them.
//!
//! That makes crack-freeness a *theorem* rather than a test. `gfx_subdiv`
//! displaces shared vertices and therefore has to weld amplitudes across AC's
//! per-face UV seams and eat a ramp at every material boundary; nothing here
//! needs any of that.
//!
//! # Why texture-blind
//!
//! Every attempt to read relief out of the texture has failed on real data:
//! luminance-as-height sinks Tudor beams (dark timber, light plaster);
//! integrating gradients fixes the banding but not the polarity; and colour
//! segmentation fired on a red-and-white banner and a shield boss. A prior
//! census concluded that **no pixel statistic can decide where relief belongs** —
//! a painted pennant carries four times the local-line contrast of real brick
//! mortar.
//!
//! So this module never samples a texel. It works from vertex positions,
//! polygon adjacency, dihedral angle, face orientation, and `pos_surface` used
//! *only* as an opaque material-identity token — never to ask what the material
//! looks like. It cannot be fooled by paint, and its ceiling is equally honest:
//! it can never place a window.
//!
//! # OP1 — the convex-edge rail
//!
//! AC buildings read as boxes because their corners are zero-radius: two large
//! flat quads meeting at a razor line with no transition band, so nothing
//! catches the light. Retail construction puts a board there. So do we.
//!
//! Along every hard convex edge we add a **chamfer cap**: a two-facet wedge
//! whose border lies exactly in both parent faces' planes. Because the border
//! is coplanar with what it sits on, the cap is watertight against the original
//! mesh — no grazing-angle slit, no z-fighting (it is strictly proud everywhere
//! except along the border line itself).
//!
//! Rails meeting at a shared vertex are deliberately allowed to
//! **interpenetrate** rather than mitre. Interpenetration of opaque
//! same-material solids is invisible; a gap is not. That one decision removes
//! the corner-solve that makes general bevelling hard.

use std::collections::{HashMap, HashSet};

use crate::graphics::Polygon;

/// Ceiling on how far a rail may stand proud, in metres. Shared with
/// [`crate::gfx_subdiv::MAX_AMPLITUDE_M`] so the "render may protrude past the
/// unmoved collision hull by at most this" contract is one number, not two.
pub const MAX_AMPLITUDE_M: f32 = 0.10;

/// `Polygon::stippling` bit meaning "no positive side" — not rendered
/// front-facing, so it has no silhouette to improve.
const NO_POS: u8 = 0x04;

/// `sides_type == CullMode::None` — the real two-sided marker (retail culls on
/// `sides_type == 1 ? CULLMODE_NONE : CULLMODE_CW`, acclient `D3DPolyRender`
/// @455346). These are alpha cards: banners, foliage, fences. 65,508 polygons
/// in `client_portal.dat` carry it. Railing the silhouette of a cutout card
/// draws a solid batten around a leaf.
const SIDES_CULL_NONE: i32 = 0x1;

/// `sides_type == CullMode::Clockwise` — the back face is drawn with its own
/// `neg_surface`. A sheet, not a solid; it has no meaningful convex corner.
const SIDES_DISTINCT_BACK: i32 = 0x2;

/// Tunables for OP1. Defaults come from the measured edge scale on town
/// buildings (median edge 1.16–2.50 m), not from taste.
#[derive(Copy, Clone, Debug, PartialEq)]
pub struct RemodelConfig {
    /// Setback from the edge along each parent face, metres.
    pub width_m: f32,
    /// How far the cap stands proud of the parent faces, metres.
    pub height_m: f32,
    /// Shortest edge worth railing, metres. Below this the rail is smaller than
    /// its own setback and reads as noise.
    pub min_edge_m: f32,
    /// Multiplier on `width_m`/`height_m`; 0.0 disables all emission while
    /// leaving classification intact (the A/B control arm).
    pub scale: f32,
}

impl Default for RemodelConfig {
    fn default() -> Self {
        Self { width_m: 0.06, height_m: 0.05, min_edge_m: 1.0, scale: 1.0 }
    }
}

impl RemodelConfig {
    #[inline]
    fn w(&self) -> f32 {
        (self.width_m * self.scale).clamp(0.0, MAX_AMPLITUDE_M)
    }
    #[inline]
    fn h(&self) -> f32 {
        (self.height_m * self.scale).clamp(0.0, MAX_AMPLITUDE_M)
    }
    /// True when nothing can be emitted, so callers keep byte-identical output.
    #[inline]
    pub fn is_noop(&self) -> bool {
        !(self.scale > 0.0) || !(self.w() > 0.0) || !(self.h() > 0.0)
    }
}

/// Gate deciding whether a model is architecture at all.
///
/// The failure mode this exists to prevent is railing a prop, an item, or a
/// creature part. Measured separation on real data: world median edge length is
/// 0.16 m and town-building median is 1.40 m, so edge *scale* is the reliable
/// discriminator. Authored-normal deviation is NOT — AC smoothed vertex normals
/// even on boxes, so Holtburg buildings score 20–48° and would be mistaken for
/// already-detailed models.
#[derive(Copy, Clone, Debug, PartialEq)]
pub struct ModelGate {
    pub min_bbox_extent_m: f32,
    pub min_median_edge_m: f32,
    pub min_area_m2: f32,
    pub max_double_sided_frac: f32,
}

impl Default for ModelGate {
    fn default() -> Self {
        Self {
            min_bbox_extent_m: 4.0,
            min_median_edge_m: 0.60,
            min_area_m2: 50.0,
            max_double_sided_frac: 0.25,
        }
    }
}

#[inline]
fn sub(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
#[inline]
fn add(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}
#[inline]
fn mul(a: [f32; 3], s: f32) -> [f32; 3] {
    [a[0] * s, a[1] * s, a[2] * s]
}
#[inline]
fn dot(a: [f32; 3], b: [f32; 3]) -> f32 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
#[inline]
fn cross(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}
#[inline]
fn norm(v: [f32; 3]) -> Option<[f32; 3]> {
    let l2 = dot(v, v);
    if l2 <= 1e-12 {
        return None;
    }
    let inv = 1.0 / l2.sqrt();
    Some(mul(v, inv))
}

/// One face's geometry, computed once per model.
#[derive(Clone, Debug)]
struct FaceRec {
    /// Outward normal, from a Newell sum over the AUTHORED ring order — which
    /// is the front face (the triangulators fan `ring[0], ring[i-1], ring[i]`
    /// as the positive side).
    n: [f32; 3],
    centroid: [f32; 3],
    /// In-plane affine mapping a projected point to (u, v). See
    /// [`FaceRec::uv_at`].
    origin: [f32; 3],
    u_axis: [f32; 3],
    v_axis: [f32; 3],
    /// `U = a*s + b*t + c`, `V = d*s + e*t + f`, stored `[a,b,c,d,e,f]`.
    uv: Option<[f32; 6]>,
    /// Constant fallback when the UV solve is singular.
    uv_const: [f32; 2],
    /// UV bounding box of the source ring, used to clamp extrapolation.
    uv_min: [f32; 2],
    uv_max: [f32; 2],
}

impl FaceRec {
    /// UV for an arbitrary point near the face plane.
    ///
    /// New vertices have no authored UV, so they inherit the parent face's
    /// mapping: a rail facet therefore samples the texels of the wall it covers
    /// and reads as extruded wall.
    ///
    /// Clamping to the source ring's UV bbox (expanded 10%) is not cosmetic:
    /// `static_atlas.js` packs many surfaces into one array texture, so an
    /// out-of-range UV would bleed a *different building's* texture onto the
    /// rail.
    fn uv_at(&self, p: [f32; 3]) -> [f32; 2] {
        let Some(k) = self.uv else { return self.uv_const };
        let d = sub(p, self.origin);
        let s = dot(d, self.u_axis);
        let t = dot(d, self.v_axis);
        let u = k[0] * s + k[1] * t + k[2];
        let v = k[3] * s + k[4] * t + k[5];
        let pad_u = (self.uv_max[0] - self.uv_min[0]).abs() * 0.10 + 1e-4;
        let pad_v = (self.uv_max[1] - self.uv_min[1]).abs() * 0.10 + 1e-4;
        [
            u.clamp(self.uv_min[0] - pad_u, self.uv_max[0] + pad_u),
            v.clamp(self.uv_min[1] - pad_v, self.uv_max[1] + pad_v),
        ]
    }
}

/// Least-squares solve of `U ≈ a*s + b*t + c` over the ring. Exact for a
/// triangle, over-determined for quads and up. Returns `None` when the ring is
/// UV-degenerate (all-equal UVs, or collinear in the plane), which is common
/// enough on trim pieces to be a normal outcome rather than an error.
fn solve_affine(st: &[[f32; 2]], w: &[f32]) -> Option<[f32; 3]> {
    let (mut m00, mut m01, mut m02, mut m11, mut m12, mut m22) = (0.0f64, 0.0, 0.0, 0.0, 0.0, 0.0);
    let (mut b0, mut b1, mut b2) = (0.0f64, 0.0, 0.0);
    for (p, &val) in st.iter().zip(w.iter()) {
        let (s, t, val) = (p[0] as f64, p[1] as f64, val as f64);
        m00 += s * s;
        m01 += s * t;
        m02 += s;
        m11 += t * t;
        m12 += t;
        m22 += 1.0;
        b0 += s * val;
        b1 += t * val;
        b2 += val;
    }
    // 3x3 symmetric solve by cofactors.
    let a = [[m00, m01, m02], [m01, m11, m12], [m02, m12, m22]];
    let det = a[0][0] * (a[1][1] * a[2][2] - a[1][2] * a[2][1])
        - a[0][1] * (a[1][0] * a[2][2] - a[1][2] * a[2][0])
        + a[0][2] * (a[1][0] * a[2][1] - a[1][1] * a[2][0]);
    if !det.is_finite() || det.abs() < 1e-9 {
        return None;
    }
    let b = [b0, b1, b2];
    let mut out = [0.0f32; 3];
    for c in 0..3 {
        let mut m = a;
        for r in 0..3 {
            m[r][c] = b[r];
        }
        let d = m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
            - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
            + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
        out[c] = (d / det) as f32;
    }
    Some(out)
}

/// Everything OP1 needs about a model, built once and reused for every edge.
pub struct ModelTopology {
    faces: HashMap<u16, FaceRec>,
    /// `(min_vid, max_vid) -> polygon ids sharing it`.
    edges: HashMap<(u16, u16), Vec<u16>>,
    /// Vertices touched by an excluded polygon; any edge using one is skipped.
    pinned: HashSet<u16>,
    /// Resolved positions for every vertex referenced by an included polygon,
    /// in the SAME space the caller emits triangles in (so a GfxObj part
    /// transform is already applied). Read-only copies — `vertex_array` itself
    /// is never touched, because writing it would move collision.
    verts: HashMap<u16, [f32; 3]>,
    /// Median edge length and bbox extent, for [`ModelTopology::passes_gate`].
    median_edge_m: f32,
    bbox_extent_m: f32,
    total_area_m2: f32,
    double_sided_frac: f32,
}

impl ModelTopology {
    /// Build adjacency and per-face frames.
    ///
    /// `vertex_pos` and `vertex_uv` are closures so this works for both
    /// `GfxObj` (positions already carrying the part transform) and
    /// `CellStruct`, and so the module never touches `vertex_array` itself —
    /// reading is fine, writing would move collision.
    pub fn build(
        polygons: &HashMap<u16, Polygon>,
        portal_poly_ids: &[u16],
        vertex_pos: &dyn Fn(i16) -> Option<[f32; 3]>,
        vertex_uv: &dyn Fn(i16, usize) -> Option<[f32; 2]>,
    ) -> Self {
        let portals: HashSet<u16> = portal_poly_ids.iter().copied().collect();
        let mut faces: HashMap<u16, FaceRec> = HashMap::new();
        let mut edges: HashMap<(u16, u16), Vec<u16>> = HashMap::new();
        let mut pinned: HashSet<u16> = HashSet::new();
        let mut verts: HashMap<u16, [f32; 3]> = HashMap::new();
        let mut lens: Vec<f32> = Vec::new();
        let mut lo = [f32::MAX; 3];
        let mut hi = [f32::MIN; 3];
        let mut area_sum = 0.0f32;
        let mut dbl = 0usize;
        let mut total = 0usize;

        // Sorted for determinism: f32 accumulation is not associative and a
        // HashMap walk is unordered, so an unordered build would make output
        // depend on hash iteration order.
        let mut pids: Vec<u16> = polygons.keys().copied().collect();
        pids.sort_unstable();

        for pid in pids {
            let poly = &polygons[&pid];
            if poly.vertex_ids.len() < 3 {
                continue;
            }
            total += 1;
            if poly.sides_type == SIDES_CULL_NONE {
                dbl += 1;
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

            let mut ring: Vec<[f32; 3]> = Vec::with_capacity(poly.vertex_ids.len());
            let mut ok = true;
            for &raw in &poly.vertex_ids {
                match if raw < 0 { None } else { vertex_pos(raw) } {
                    Some(p) => ring.push(p),
                    None => {
                        ok = false;
                        break;
                    }
                }
            }
            if !ok || ring.len() < 3 {
                continue;
            }

            // Newell: robust for non-planar rings, and its magnitude is twice
            // the projected area.
            let mut nv = [0.0f32; 3];
            for i in 0..ring.len() {
                let a = ring[i];
                let b = ring[(i + 1) % ring.len()];
                nv[0] += (a[1] - b[1]) * (a[2] + b[2]);
                nv[1] += (a[2] - b[2]) * (a[0] + b[0]);
                nv[2] += (a[0] - b[0]) * (a[1] + b[1]);
            }
            let area = 0.5 * dot(nv, nv).sqrt();
            let Some(n) = norm(nv) else { continue };
            if area <= 1e-9 {
                continue;
            }
            area_sum += area;

            let mut c = [0.0f32; 3];
            for p in &ring {
                c = add(c, *p);
                for k in 0..3 {
                    lo[k] = lo[k].min(p[k]);
                    hi[k] = hi[k].max(p[k]);
                }
            }
            let c = mul(c, 1.0 / ring.len() as f32);

            let origin = ring[0];
            let u_axis = match norm(sub(ring[1], ring[0])) {
                Some(u) => u,
                None => continue,
            };
            let v_axis = match norm(cross(n, u_axis)) {
                Some(v) => v,
                None => continue,
            };

            let mut st: Vec<[f32; 2]> = Vec::with_capacity(ring.len());
            let mut us: Vec<f32> = Vec::with_capacity(ring.len());
            let mut vs: Vec<f32> = Vec::with_capacity(ring.len());
            let mut uv_min = [f32::MAX; 2];
            let mut uv_max = [f32::MIN; 2];
            for (i, p) in ring.iter().enumerate() {
                if poly.vertex_ids[i] >= 0 {
                    verts.insert(poly.vertex_ids[i] as u16, *p);
                }
                let d = sub(*p, origin);
                st.push([dot(d, u_axis), dot(d, v_axis)]);
                let uv = vertex_uv(poly.vertex_ids[i], i).unwrap_or([0.0, 0.0]);
                us.push(uv[0]);
                vs.push(uv[1]);
                uv_min[0] = uv_min[0].min(uv[0]);
                uv_min[1] = uv_min[1].min(uv[1]);
                uv_max[0] = uv_max[0].max(uv[0]);
                uv_max[1] = uv_max[1].max(uv[1]);
            }
            let uv = match (solve_affine(&st, &us), solve_affine(&st, &vs)) {
                (Some(a), Some(b)) => Some([a[0], a[1], a[2], b[0], b[1], b[2]]),
                _ => None,
            };

            faces.insert(
                pid,
                FaceRec {
                    n,
                    centroid: c,
                    origin,
                    u_axis,
                    v_axis,
                    uv,
                    uv_const: [us[0], vs[0]],
                    uv_min,
                    uv_max,
                },
            );

            for i in 0..poly.vertex_ids.len() {
                let a = poly.vertex_ids[i];
                let b = poly.vertex_ids[(i + 1) % poly.vertex_ids.len()];
                if a < 0 || b < 0 || a == b {
                    continue;
                }
                let (a, b) = (a as u16, b as u16);
                edges.entry((a.min(b), a.max(b))).or_default().push(pid);
                if let (Some(pa), Some(pb)) = (vertex_pos(a as i16), vertex_pos(b as i16)) {
                    lens.push(dot(sub(pb, pa), sub(pb, pa)).sqrt());
                }
            }
        }

        lens.sort_by(|x, y| x.partial_cmp(y).unwrap_or(std::cmp::Ordering::Equal));
        let median_edge_m = if lens.is_empty() { 0.0 } else { lens[lens.len() / 2] };
        let bbox_extent_m = if hi[0] < lo[0] {
            0.0
        } else {
            (hi[0] - lo[0]).max(hi[1] - lo[1]).max(hi[2] - lo[2])
        };

        Self {
            faces,
            edges,
            pinned,
            verts,
            median_edge_m,
            bbox_extent_m,
            total_area_m2: area_sum,
            double_sided_frac: if total == 0 { 0.0 } else { dbl as f32 / total as f32 },
        }
    }

    /// Is this model architecture worth railing? The safe answer is "no" —
    /// 5,006 of 5,718 world GfxObjs are expected to fail and stay byte-identical.
    pub fn passes_gate(&self, g: &ModelGate) -> bool {
        self.bbox_extent_m >= g.min_bbox_extent_m
            && self.median_edge_m >= g.min_median_edge_m
            && self.total_area_m2 >= g.min_area_m2
            && self.double_sided_frac <= g.max_double_sided_frac
    }

    /// Emit OP1 chamfer caps.
    ///
    /// `emit` receives `(parent_polygon_id, positions, uvs, facet_normal)`. The
    /// caller copies `surface_did` / `sides_type` / `stippling` from the parent
    /// polygon, so every new triangle lands in an EXISTING material subset and
    /// **no draw call is added** — the wall this work has to stay under.
    ///
    /// Flat-shaded on purpose: the constant facet normal is what makes a batten
    /// read as a batten. A smoothed normal would blend it back into the wall
    /// and undo the whole point.
    pub fn emit_convex_rails<F>(&self, cfg: &RemodelConfig, emit: &mut F) -> u32
    where
        F: FnMut(u16, [[f32; 3]; 3], [[f32; 2]; 3], [f32; 3]),
    {
        if cfg.is_noop() {
            return 0;
        }
        let (w, h) = (cfg.w(), cfg.h());
        let mut n_rails = 0u32;

        let mut keys: Vec<(u16, u16)> = self.edges.keys().copied().collect();
        keys.sort_unstable();

        for key in keys {
            let pids = &self.edges[&key];
            // Manifold interior edges only. A boundary edge (1 face) has no
            // dihedral; >2 is non-manifold and its "outward" is undefined.
            if pids.len() != 2 {
                continue;
            }
            if self.pinned.contains(&key.0) || self.pinned.contains(&key.1) {
                continue;
            }
            let (Some(fa), Some(fb)) = (self.faces.get(&pids[0]), self.faces.get(&pids[1])) else {
                continue;
            };

            // Edge endpoints come from face A's frame so both faces agree.
            let (Some(p0), Some(p1)) = (self.vert(key.0), self.vert(key.1)) else {
                continue;
            };
            let ev = sub(p1, p0);
            let len = dot(ev, ev).sqrt();
            if len < cfg.min_edge_m {
                continue;
            }
            let Some(e) = norm(ev) else { continue };
            let mid = mul(add(p0, p1), 0.5);

            let cosang = dot(fa.n, fb.n).clamp(-1.0, 1.0);
            let ang = cosang.acos().to_degrees();
            // Below 60° the faces are nearly coplanar — a material transition,
            // not a corner (that is OP3's job). Above 165° they have folded
            // back on each other: a sheet, not a corner.
            if !(60.0..=165.0).contains(&ang) {
                continue;
            }
            // Convex iff each face's outward normal points away from the other
            // face's centroid.
            let convex = dot(fa.n, sub(fb.centroid, mid)) + dot(fb.n, sub(fa.centroid, mid)) < 0.0;
            if !convex {
                continue;
            }

            // Tangents pointing INTO each face, so the footprints land on the
            // faces themselves rather than out in the air.
            let mut ta = match norm(cross(fa.n, e)) {
                Some(t) => t,
                None => continue,
            };
            if dot(ta, sub(fa.centroid, mid)) < 0.0 {
                ta = mul(ta, -1.0);
            }
            let mut tb = match norm(cross(fb.n, e)) {
                Some(t) => t,
                None => continue,
            };
            if dot(tb, sub(fb.centroid, mid)) < 0.0 {
                tb = mul(tb, -1.0);
            }
            let Some(no) = norm(add(fa.n, fb.n)) else { continue };

            // Footprints lie EXACTLY in each parent plane → watertight border.
            let ai0 = add(p0, mul(ta, w));
            let ai1 = add(p1, mul(ta, w));
            let bi0 = add(p0, mul(tb, w));
            let bi1 = add(p1, mul(tb, w));
            let k0 = add(p0, mul(no, h));
            let k1 = add(p1, mul(no, h));

            // Facet over A: (ai0, ai1, k1, k0). Facet over B: (k0, k1, bi1, bi0).
            let fa_n = norm(cross(sub(ai1, ai0), sub(k0, ai0))).unwrap_or(fa.n);
            let fb_n = norm(cross(sub(k1, k0), sub(bi0, k0))).unwrap_or(fb.n);

            let quad = |emit: &mut F, pid: u16, f: &FaceRec, q: [[f32; 3]; 4], nrm: [f32; 3]| {
                let uv = |p: [f32; 3]| f.uv_at(p);
                emit(
                    pid,
                    [q[0], q[1], q[2]],
                    [uv(q[0]), uv(q[1]), uv(q[2])],
                    nrm,
                );
                emit(
                    pid,
                    [q[0], q[2], q[3]],
                    [uv(q[0]), uv(q[2]), uv(q[3])],
                    nrm,
                );
            };
            quad(emit, pids[0], fa, [ai0, ai1, k1, k0], fa_n);
            quad(emit, pids[1], fb, [k0, k1, bi1, bi0], fb_n);
            n_rails += 1;
        }
        n_rails
    }

    #[inline]
    fn vert(&self, vid: u16) -> Option<[f32; 3]> {
        self.verts.get(&vid).copied()
    }

    /// Rails that would be emitted for this model at `cfg` — the census hook,
    /// so trigger counts can be measured without building geometry.
    pub fn count_convex_rails(&self, cfg: &RemodelConfig) -> u32 {
        let mut n = 0;
        self.emit_convex_rails(cfg, &mut |_, _, _, _| n += 1);
        n / 4 // 4 triangles per rail
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn poly(vertex_ids: Vec<i16>, sides_type: i32, stippling: u8) -> Polygon {
        Polygon {
            num_pts: vertex_ids.len() as u8,
            stippling,
            sides_type,
            pos_surface: 0,
            neg_surface: -1,
            pos_uv_indices: vec![0; vertex_ids.len()],
            neg_uv_indices: vec![],
            vertex_ids,
        }
    }

    #[test]
    fn affine_solve_is_exact_for_a_triangle() {
        let st = [[0.0, 0.0], [2.0, 0.0], [0.0, 3.0]];
        let u = [1.0, 5.0, 1.0]; // U = 2s + 1
        let k = solve_affine(&st, &u).expect("solvable");
        assert!((k[0] - 2.0).abs() < 1e-4, "a={}", k[0]);
        assert!(k[1].abs() < 1e-4, "b={}", k[1]);
        assert!((k[2] - 1.0).abs() < 1e-4, "c={}", k[2]);
    }

    #[test]
    fn affine_solve_reports_degenerate_rings() {
        // All points collinear in the plane → singular, must be None so the
        // caller falls back to a constant UV rather than emitting garbage that
        // would sample a different building's atlas layer.
        let st = [[0.0, 0.0], [1.0, 0.0], [2.0, 0.0]];
        assert!(solve_affine(&st, &[0.0, 1.0, 2.0]).is_none());
    }

    #[test]
    fn config_noop_is_byte_identical() {
        for c in [
            RemodelConfig { scale: 0.0, ..Default::default() },
            RemodelConfig { width_m: 0.0, ..Default::default() },
            RemodelConfig { height_m: 0.0, ..Default::default() },
        ] {
            assert!(c.is_noop(), "{c:?} should emit nothing");
        }
        assert!(!RemodelConfig::default().is_noop());
    }

    #[test]
    fn amplitude_is_clamped_to_the_shared_ceiling() {
        let c = RemodelConfig { width_m: 1.0, height_m: 1.0, scale: 10.0, ..Default::default() };
        assert!(c.w() <= MAX_AMPLITUDE_M + 1e-6);
        assert!(c.h() <= MAX_AMPLITUDE_M + 1e-6);
    }

    #[test]
    fn excluded_polygons_pin_their_vertices() {
        // Alpha cards (CullMode::None) and distinct-back sheets must not
        // contribute edges, and must stop any edge that touches them.
        for sides in [SIDES_CULL_NONE, SIDES_DISTINCT_BACK] {
            let mut polys = HashMap::new();
            polys.insert(0u16, poly(vec![0, 1, 2], sides, 0));
            let pos = |v: i16| Some([v as f32, 0.0, 0.0]);
            let uv = |_v: i16, _i: usize| Some([0.0, 0.0]);
            let t = ModelTopology::build(&polys, &[], &pos, &uv);
            assert!(t.pinned.contains(&0), "sides_type {sides} did not pin");
            assert!(t.faces.is_empty());
        }
    }

    /// A 6 m cube: the canonical AC building. Every one of its 12 edges is a
    /// hard convex corner, which is exactly the "razor edge" complaint.
    fn cube(size: f32) -> (HashMap<u16, Polygon>, Vec<[f32; 3]>) {
        let s = size;
        let v = vec![
            [0.0, 0.0, 0.0], [s, 0.0, 0.0], [s, s, 0.0], [0.0, s, 0.0],
            [0.0, 0.0, s],   [s, 0.0, s],   [s, s, s],   [0.0, s, s],
        ];
        // Rings wound so the Newell normal points OUT of the cube.
        let f: [[i16; 4]; 6] = [
            [0, 3, 2, 1], // -Z
            [4, 5, 6, 7], // +Z
            [0, 1, 5, 4], // -Y
            [2, 3, 7, 6], // +Y
            [1, 2, 6, 5], // +X
            [0, 4, 7, 3], // -X
        ];
        let mut polys = HashMap::new();
        for (i, ring) in f.iter().enumerate() {
            polys.insert(i as u16, poly(ring.to_vec(), 0, 0));
        }
        (polys, v)
    }

    #[test]
    fn a_cube_rails_all_twelve_convex_edges() {
        let (polys, v) = cube(6.0);
        let pos = |i: i16| v.get(i as usize).copied();
        let uv = |_i: i16, k: usize| Some([k as f32 * 0.25, 0.0]);
        let t = ModelTopology::build(&polys, &[], &pos, &uv);
        assert_eq!(t.faces.len(), 6);
        assert_eq!(t.edges.len(), 12, "a cube has 12 edges");
        assert!(t.passes_gate(&ModelGate::default()), "a 6m cube is architecture");
        assert_eq!(t.count_convex_rails(&RemodelConfig::default()), 12);
    }

    #[test]
    fn an_inside_out_box_rails_nothing() {
        // A dungeon room is a cube viewed from inside: every edge is CONCAVE.
        // Convex-only ops must do nothing indoors — which is why interiors need
        // a different operation set, not this one.
        let (polys, v) = cube(6.0);
        let flipped: HashMap<u16, Polygon> = polys
            .iter()
            .map(|(k, p)| {
                let mut q = p.clone();
                q.vertex_ids.reverse();
                (*k, q)
            })
            .collect();
        let pos = |i: i16| v.get(i as usize).copied();
        let uv = |_i: i16, _k: usize| Some([0.0, 0.0]);
        let t = ModelTopology::build(&flipped, &[], &pos, &uv);
        assert_eq!(t.count_convex_rails(&RemodelConfig::default()), 0);
    }

    #[test]
    fn rails_stay_proud_and_within_the_ceiling() {
        // Every emitted vertex must sit outside the original surface, and never
        // further out than the shared amplitude ceiling.
        let (polys, v) = cube(6.0);
        let pos = |i: i16| v.get(i as usize).copied();
        let uv = |_i: i16, _k: usize| Some([0.0, 0.0]);
        let t = ModelTopology::build(&polys, &[], &pos, &uv);
        let cfg = RemodelConfig::default();
        let mut worst: f32 = 0.0;
        t.emit_convex_rails(&cfg, &mut |_pid, p, _uv, _n| {
            for q in p {
                // Distance outside the cube on each axis.
                for k in 0..3 {
                    let out = (-q[k]).max(q[k] - 6.0);
                    worst = worst.max(out);
                }
            }
        });
        assert!(worst > 0.0, "rails never left the surface");
        assert!(worst <= MAX_AMPLITUDE_M + 1e-4, "rail protruded {worst} m");
    }

    #[test]
    fn short_edges_are_skipped() {
        // A 0.5 m cube has 0.5 m edges, below min_edge_m — rails smaller than
        // their own setback read as noise.
        let (polys, v) = cube(0.5);
        let pos = |i: i16| v.get(i as usize).copied();
        let uv = |_i: i16, _k: usize| Some([0.0, 0.0]);
        let t = ModelTopology::build(&polys, &[], &pos, &uv);
        assert_eq!(t.count_convex_rails(&RemodelConfig::default()), 0);
    }

    #[test]
    fn gate_rejects_small_finely_tessellated_props() {
        // A 0.2 m prop with 0.1 m edges is not architecture.
        let g = ModelGate::default();
        let t = ModelTopology {
            faces: HashMap::new(),
            edges: HashMap::new(),
            pinned: HashSet::new(),
            verts: HashMap::new(),
            median_edge_m: 0.10,
            bbox_extent_m: 0.20,
            total_area_m2: 0.5,
            double_sided_frac: 0.0,
        };
        assert!(!t.passes_gate(&g));

        let t = ModelTopology { median_edge_m: 1.40, bbox_extent_m: 12.0, total_area_m2: 300.0, ..t };
        assert!(t.passes_gate(&g));
    }

    #[test]
    fn gate_rejects_mostly_double_sided_models() {
        let g = ModelGate::default();
        let t = ModelTopology {
            faces: HashMap::new(),
            edges: HashMap::new(),
            pinned: HashSet::new(),
            verts: HashMap::new(),
            median_edge_m: 1.4,
            bbox_extent_m: 12.0,
            total_area_m2: 300.0,
            double_sided_frac: 0.9,
        };
        assert!(!t.passes_gate(&g), "a foliage cluster must not pass");
    }
}
