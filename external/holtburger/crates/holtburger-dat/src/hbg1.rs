//! HBG1 — baked indexed geometry payloads (SPEC §1.2, pass 4 S1; T13/ST3).
//!
//! Fills the pack GEOM section rows with `encoding = 0x0001` payloads:
//!
//! * **kind 0 — PART mesh** (one per 0x01 GfxObj; also each entry inside a
//!   kind-2 ENV directory): indexed, subset-partitioned, upload-ready streams.
//! * **kind 1 — SETUP directory** (one per 0x02 SetupModel): part DID list +
//!   per-part default-pose frame + per-part scale + per-part hinge frame +
//!   fused bbox + bake-resolved `did_degrade`. No vertex data.
//! * **kind 2 — ENV directory** (one per 0x0D Environment): per-cellstruct
//!   kind-0 mesh blocks whose subset `surface_ref` is the SLOT index into the
//!   consuming EnvCell's surface list (remapped per cell at load).
//!
//! The ENCODER mirrors the runtime triangulators in
//! `apps/holtburger-web/src/lib.rs` (`append_gfx_tris_with_tex_swaps` with an
//! empty swap table for models, `append_environment_tris` for env cellstructs,
//! `walk_setup_parts`' pose-priority chain for setup frames) — byte-for-byte on
//! the values the runtime emits, with vertices deduplicated over the corner
//! identity `(vertex_id, effective_uv_index, side, quantized_normal)`. The
//! quantized normal is part of the key (a small extension over pass 4 D-04.1's
//! `(vertex_id, uv_index, side)`) because the runtime's face-normal FALLBACK is
//! per-triangle: two triangles of one polygon fan can give the same source
//! corner different normals when the authored normal is degenerate, and a
//! key without the normal would merge them and lose that fidelity.
//!
//! Geometric relief (`gfx_relief_config`) is a per-instance opt-in that is OFF
//! by default; the GEOM section keeps baking the DEFAULT (relief-free)
//! geometry, which is the byte-exact differ baseline.
//!
//! **RELIEF-IN-BAKE (2026-08-10).** Relief is now ALSO bakeable, as a separate
//! VARIANT payload set ([`ReliefBake`], [`encode_gfx_part_relief`]) that the
//! bake emits into its own pack section (`GEOMR`, `section_kind::GEOM_RELIEF`)
//! alongside — never in place of — the relief-free rows. What is baked is the
//! MATERIAL-IDENTITY relief that actually ships: `gfx_remodel`'s OP1 convex-edge
//! + OP3 material-boundary rails, which presets run at `subdivLevel = 0`. The
//! per-texel displacement path was retired on 2026-07-30 and is deliberately
//! NOT reproduced here (it needs decoded surface height fields; see
//! `ReliefBake`). Variant rows exist only for models the profile actually
//! changes, so an absent row means "relief is a no-op for this model" and the
//! consumer reads the default row.
//!
//! ## Layout deviations from pass-04 S1 (recorded, T10-D1 class)
//!
//! Pass 4 S1 declares the subset row "12 B" but its own field list
//! (`u32 + u8 + u8×3 + u32 + u32`) sums to 16 — rows here are **16 B**.
//! The kind-1 row is declared "40 B" but its field list sums to 32 and omits
//! two load-bearing per-part values the runtime consumes (read-verified
//! `walk_setup_parts` lib.rs:7174-7193 and `compute_hinge_frames`
//! lib.rs:15461+): the per-part `default_scale` (applied to vertices PRE
//! rotation) and the hinge frame, whose fallback chain (placement 0 → 1 →
//! first) DIFFERS from the pose chain (idle-anim → placement 0x65 → 0 →
//! first). Rows here are **72 B**: `part_did u32 | frame pos f32×3 | frame
//! quat f32×4 (w,x,y,z) | scale f32×3 | hinge pos f32×3 | hinge quat f32×4`.
//!
//! ENV subset `surface_ref` uses **0xFFFF_FFFF** as the "no positive surface"
//! sentinel (slot 0 is a legitimate EnvCell surface slot, so the model path's
//! `0` sentinel is unavailable). Back-face subsets carry flag bit 3 and the
//! POSITIVE slot of their polygon in `reserved[0..2]` (LE u16): the runtime
//! decides back-face emission per CELL by comparing the RESOLVED pos/neg DIDs
//! (append_environment_tris lib.rs:19651-19661 — palette-dependent, F14-2),
//! so the bake emits the back faces unconditionally and the per-cell assembly
//! DROPS a back subset whose resolved DID is 0 or equal to its paired front.
//!
//! Determinism (pass 2 D-02.6): pure functions of the parsed records —
//! subsets in first-seen order, triangles in source-polygon order (stable
//! partition), vertices numbered by first use in final index order.

use crate::ResourceSource;
use crate::file_type::environment::CellStruct;
use crate::file_type::setup_model::AnimationFrame;
use crate::file_type::{Animation, Environment, GfxObj, MotionTable, SetupModel};
use crate::graphics::Polygon;
use crate::{EOR_PORTAL_NAMESPACE, ResourceKey};
use std::collections::HashMap;
use std::io::Cursor;

pub const HBG1_MAGIC: &[u8; 4] = b"HBG1";
pub const HBG1_VERSION: u8 = 1;
/// GEOM section row `encoding` value for HBG1 payloads (0x0000 = runtime decode).
pub const ENCODING_HBG1: u16 = 0x0001;

pub const KIND_PART: u8 = 0;
pub const KIND_SETUP: u8 = 1;
pub const KIND_ENV: u8 = 2;

pub mod flags {
    /// Baked-light stream present (ENV cellstruct meshes; zero-filled at bake).
    pub const BAKED_LIGHT: u16 = 1 << 0;
    /// Reserved: f16 uv stream. MUST be 0 in v1.
    pub const UV_F16: u16 = 1 << 1;
    /// Indices are u32 (else u16).
    pub const IDX_U32: u16 = 1 << 2;
    /// `did_degrade` trailer present.
    pub const DID_DEGRADE: u16 = 1 << 3;
}

pub mod subset_flags {
    /// Group renders DoubleSide under `?perPolyCull=on` (poly `sides_type == 1`).
    pub const DOUBLE_SIDED: u8 = 1 << 0;
    /// RND-33 bit 0 (side-agnostic `DrawMesh` stipple reading).
    pub const STIPPLE_WRAP: u8 = 1 << 1;
    /// RND-33 bit 1 (side-specific `SetSurface` stipple reading).
    pub const STIPPLE_SIDE: u8 = 1 << 2;
    /// ENV only: this subset is the BACK face of a two-sided polygon whose
    /// positive slot sits in `reserved[0..2]`; dropped per cell when the
    /// resolved DID is 0 or equals the paired front DID.
    pub const ENV_BACKFACE: u8 = 1 << 3;
}

/// ENV "no positive surface" slot sentinel (`pos_surface < 0`).
pub const ENV_SLOT_NONE: u32 = 0xFFFF_FFFF;

pub const PAYLOAD_HEADER_LEN: usize = 16;
pub const MESH_HEADER_LEN: usize = 44;
pub const SUBSET_ROW_LEN: usize = 16;
pub const SETUP_PART_ROW_LEN: usize = 72;

/// Hard cap per mesh payload (pass 4 S1: MUST be ≤ 4 MiB, fail loud).
pub const MESH_PAYLOAD_MAX: usize = 4 * 1024 * 1024;
/// SHOULD cap (census-reported, not enforced).
pub const MESH_PAYLOAD_SOFT: usize = 256 * 1024;

// ---------------------------------------------------------------------------
// Quantization
// ---------------------------------------------------------------------------

/// f32 normal component → snorm8. Matches the decoder's `v as f32 / 127.0`.
#[inline]
pub fn quant_snorm8(v: f32) -> i8 {
    let c = if v.is_finite() { v.clamp(-1.0, 1.0) } else { 0.0 };
    (c * 127.0).round() as i32 as i8
}

/// snorm8 → f32 (the bundle-assembly dequantizer; -128 clamps like GL).
#[inline]
pub fn dequant_snorm8(v: i8) -> f32 {
    (v as f32 / 127.0).max(-1.0)
}

// ---------------------------------------------------------------------------
// Mesh builder (shared by GfxObj + Environment encoders)
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq)]
struct CornerRec {
    pos: [f32; 3],
    uv: [f32; 2],
    qn: [i8; 3],
}

#[derive(Clone, Copy, PartialEq, Eq, Hash)]
struct CornerKey {
    vid: u16,
    uv_idx: u16,
    side: u8,
    qn: [i8; 3],
    /// RELIEF-IN-BAKE: 0 for every corner that descends from a SOURCE vertex
    /// (so the relief-free encode is byte-identical to the pre-relief codec).
    /// Relief rail corners are synthetic positions with no source vertex id;
    /// each gets a distinct ordinal so two rails never merge — mirroring the
    /// runtime, which emits rails de-indexed.
    synth: u32,
}

struct SubsetAccum {
    surface_ref: u32,
    flags: u8,
    /// ENV back-face subsets: paired positive slot. 0 elsewhere.
    pair_slot: u16,
    /// Triangles as corner descriptors (key + values), in emission order.
    tris: Vec<[(CornerKey, CornerRec); 3]>,
}

#[derive(Default)]
struct MeshBuilder {
    subsets: Vec<SubsetAccum>,
    subset_map: HashMap<(u32, u8, u16), usize>,
}

impl MeshBuilder {
    fn push_tri(
        &mut self,
        surface_ref: u32,
        flags: u8,
        pair_slot: u16,
        corners: [(CornerKey, CornerRec); 3],
    ) {
        let key = (surface_ref, flags, pair_slot);
        let idx = match self.subset_map.get(&key) {
            Some(&i) => i,
            None => {
                let i = self.subsets.len();
                self.subsets.push(SubsetAccum {
                    surface_ref,
                    flags,
                    pair_slot,
                    tris: Vec::new(),
                });
                self.subset_map.insert(key, i);
                i
            }
        };
        self.subsets[idx].tris.push(corners);
    }

    /// Serialize to a kind-0 payload. `baked_light`: emit the zero-filled
    /// baked-light stream (ENV blocks). `did_degrade`: trailer when non-zero.
    fn serialize(&self, kind: u8, baked_light: bool, did_degrade: u32) -> Result<Vec<u8>, String> {
        // Final vertex numbering: first use in final index order.
        let mut vert_of: HashMap<CornerKey, u32> = HashMap::new();
        let mut verts: Vec<CornerRec> = Vec::new();
        let mut subset_rows: Vec<(u32, u8, u16, u32, u32)> = Vec::new();
        let mut indices: Vec<u32> = Vec::new();
        for s in &self.subsets {
            if s.tris.is_empty() {
                continue;
            }
            let first_index = indices.len() as u32;
            for tri in &s.tris {
                for (key, rec) in tri {
                    let vi = match vert_of.get(key) {
                        Some(&v) => v,
                        None => {
                            let v = verts.len() as u32;
                            verts.push(*rec);
                            vert_of.insert(*key, v);
                            v
                        }
                    };
                    indices.push(vi);
                }
            }
            subset_rows.push((
                s.surface_ref,
                s.flags,
                s.pair_slot,
                first_index,
                indices.len() as u32 - first_index,
            ));
        }

        let vertex_count = verts.len();
        let index_count = indices.len();
        let idx_u32 = vertex_count > u16::MAX as usize;

        let mut bbox_min = [f32::INFINITY; 3];
        let mut bbox_max = [f32::NEG_INFINITY; 3];
        for v in &verts {
            for k in 0..3 {
                if v.pos[k] < bbox_min[k] {
                    bbox_min[k] = v.pos[k];
                }
                if v.pos[k] > bbox_max[k] {
                    bbox_max[k] = v.pos[k];
                }
            }
        }
        if !bbox_min[0].is_finite() {
            bbox_min = [0.0; 3];
            bbox_max = [0.0; 3];
        }

        let mut payload_flags: u16 = 0;
        if baked_light {
            payload_flags |= flags::BAKED_LIGHT;
        }
        if idx_u32 {
            payload_flags |= flags::IDX_U32;
        }
        if did_degrade != 0 {
            payload_flags |= flags::DID_DEGRADE;
        }

        let stream_off = PAYLOAD_HEADER_LEN + MESH_HEADER_LEN; // 60, 4-B aligned
        let idx_bytes = if idx_u32 { 4 } else { 2 } * index_count;
        let streams_len = 12 * vertex_count
            + 4 * vertex_count
            + 8 * vertex_count
            + if baked_light { 4 * vertex_count } else { 0 }
            + align4(idx_bytes);
        let subs_off = stream_off + streams_len;
        let trailer_off = if did_degrade != 0 {
            subs_off + subset_rows.len() * SUBSET_ROW_LEN
        } else {
            0
        };
        let total = subs_off
            + subset_rows.len() * SUBSET_ROW_LEN
            + if did_degrade != 0 { 4 } else { 0 };
        if total > MESH_PAYLOAD_MAX {
            return Err(format!(
                "HBG1 mesh payload {total} B exceeds the {MESH_PAYLOAD_MAX} B hard cap"
            ));
        }

        let mut out = Vec::with_capacity(total);
        // PayloadHeader.
        out.extend_from_slice(HBG1_MAGIC);
        out.push(kind);
        out.push(HBG1_VERSION);
        out.extend_from_slice(&payload_flags.to_le_bytes());
        out.extend_from_slice(&0u32.to_le_bytes()); // reserved
        out.extend_from_slice(&(trailer_off as u32).to_le_bytes());
        // MeshHeader.
        out.extend_from_slice(&(vertex_count as u32).to_le_bytes());
        out.extend_from_slice(&(index_count as u32).to_le_bytes());
        out.extend_from_slice(&(subset_rows.len() as u16).to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes()); // reserved
        for v in bbox_min.iter().chain(bbox_max.iter()) {
            out.extend_from_slice(&v.to_le_bytes());
        }
        out.extend_from_slice(&(stream_off as u32).to_le_bytes());
        // Trailing reserved u32 pads the MeshHeader to its declared 44 B
        // (the field list itself sums to 40 — the T10-D1 padding convention).
        out.extend_from_slice(&0u32.to_le_bytes());
        assert_eq!(out.len(), stream_off, "HBG1 serialize: header layout drift");
        // Streams: positions.
        for v in &verts {
            for c in v.pos {
                out.extend_from_slice(&c.to_le_bytes());
            }
        }
        // Normals snorm8×3 + pad.
        for v in &verts {
            out.push(v.qn[0] as u8);
            out.push(v.qn[1] as u8);
            out.push(v.qn[2] as u8);
            out.push(0);
        }
        // UVs.
        for v in &verts {
            out.extend_from_slice(&v.uv[0].to_le_bytes());
            out.extend_from_slice(&v.uv[1].to_le_bytes());
        }
        // Baked-light (zeros at bake).
        if baked_light {
            out.resize(out.len() + 4 * vertex_count, 0);
        }
        // Indices (+ pad to 4).
        if idx_u32 {
            for &i in &indices {
                out.extend_from_slice(&i.to_le_bytes());
            }
        } else {
            for &i in &indices {
                out.extend_from_slice(&(i as u16).to_le_bytes());
            }
        }
        while out.len() % 4 != 0 {
            out.push(0);
        }
        assert_eq!(out.len(), subs_off, "HBG1 serialize: stream layout drift");
        // Subset table.
        for (sref, f, pair, first, count) in &subset_rows {
            out.extend_from_slice(&sref.to_le_bytes());
            out.push(*f);
            out.extend_from_slice(&pair.to_le_bytes());
            out.push(0);
            out.extend_from_slice(&first.to_le_bytes());
            out.extend_from_slice(&count.to_le_bytes());
        }
        // Trailer.
        if did_degrade != 0 {
            out.extend_from_slice(&did_degrade.to_le_bytes());
        }
        assert_eq!(out.len(), total, "HBG1 serialize: total layout drift");
        Ok(out)
    }
}

#[inline]
fn align4(n: usize) -> usize {
    (n + 3) & !3
}

// ---------------------------------------------------------------------------
// GfxObj (kind 0) encoder — mirrors append_gfx_tris_with_tex_swaps(&[]) at
// identity transform, relief off.
// ---------------------------------------------------------------------------

const NO_POS: u8 = 0x04;
const NO_NEG: u8 = 0x08;
const CULL_CLOCKWISE: i32 = 0x2;

/// RND-33 stipple reduction — mirrors lib.rs `tri_stipple_bits` exactly.
/// `side`: 0 = positive/front, 1 = negative/back.
#[inline]
fn stipple_bits(stippling: u8, side: u8) -> u8 {
    let mut bits = 0u8;
    if stippling > 0 {
        bits |= 0x1;
    }
    let side_bit = if side == 1 { 0x2 } else { 0x1 };
    if (stippling & side_bit) != 0 {
        bits |= 0x2;
    }
    bits
}

#[inline]
fn face_normal(a: [f32; 3], b: [f32; 3], c: [f32; 3]) -> [f32; 3] {
    let ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    let ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    [
        ab[1] * ac[2] - ab[2] * ac[1],
        ab[2] * ac[0] - ab[0] * ac[2],
        ab[0] * ac[1] - ab[1] * ac[0],
    ]
}

#[inline]
fn subset_flag_bits(double_sided: bool, stip: u8) -> u8 {
    let mut f = 0u8;
    if double_sided {
        f |= subset_flags::DOUBLE_SIDED;
    }
    if stip & 0x1 != 0 {
        f |= subset_flags::STIPPLE_WRAP;
    }
    if stip & 0x2 != 0 {
        f |= subset_flags::STIPPLE_SIDE;
    }
    f
}

/// Shared polygon-fan walk over a `(vertex_array, polygons)` pair.
/// `resolve_surfaces(poly) -> Option<(front_ref, Option<(back_ref, pair_slot)>)>`
/// returns `None` to skip the polygon entirely; `has_authored_normals` selects
/// the model path's authored-normal-with-fallback behaviour (env uses face
/// normals only).
#[allow(clippy::too_many_arguments)]
fn fan_polygons<F>(
    builder: &mut MeshBuilder,
    vertices: &HashMap<u16, crate::graphics::SWVertex>,
    polygons: &HashMap<u16, Polygon>,
    authored_normals: bool,
    mut resolve: F,
) where
    F: FnMut(&Polygon) -> Option<(u32, Option<(u32, u16)>)>,
{
    let mut poly_ids: Vec<u16> = polygons.keys().copied().collect();
    poly_ids.sort_unstable();
    for pid in poly_ids {
        let poly = &polygons[&pid];
        if poly.vertex_ids.len() < 3 {
            continue;
        }
        if (poly.stippling & NO_POS) != 0 {
            continue;
        }
        let Some((front_ref, back)) = resolve(poly) else {
            continue;
        };
        let emit_back = back.is_some();

        // Resolve the ring: positions + effective uv indices + authored normals.
        let mut ring_pos: Vec<[f32; 3]> = Vec::with_capacity(poly.vertex_ids.len());
        let mut ring_vid: Vec<u16> = Vec::with_capacity(poly.vertex_ids.len());
        let mut ring_uv_pos: Vec<([f32; 2], u16)> = Vec::with_capacity(poly.vertex_ids.len());
        let mut ring_uv_neg: Vec<([f32; 2], u16)> = Vec::with_capacity(poly.vertex_ids.len());
        let mut ring_normal: Vec<Option<[f32; 3]>> = Vec::with_capacity(poly.vertex_ids.len());
        let mut ok = true;
        for (i, &raw) in poly.vertex_ids.iter().enumerate() {
            if raw < 0 {
                ok = false;
                break;
            }
            let Some(vert) = vertices.get(&(raw as u16)) else {
                ok = false;
                break;
            };
            let mut uv_pos_idx: usize = 0;
            if i < poly.pos_uv_indices.len() {
                uv_pos_idx = poly.pos_uv_indices[i] as usize;
            }
            if uv_pos_idx >= vert.uvs.len() {
                uv_pos_idx = 0;
            }
            let uv_pos = if vert.uvs.is_empty() {
                ([0.0, 0.0], u16::MAX)
            } else {
                ([vert.uvs[uv_pos_idx].u, vert.uvs[uv_pos_idx].v], uv_pos_idx as u16)
            };
            let uv_neg = if emit_back && i < poly.neg_uv_indices.len() {
                let mut uv_neg_idx = poly.neg_uv_indices[i] as usize;
                if uv_neg_idx >= vert.uvs.len() {
                    uv_neg_idx = 0;
                }
                if vert.uvs.is_empty() {
                    ([0.0, 0.0], u16::MAX)
                } else {
                    ([vert.uvs[uv_neg_idx].u, vert.uvs[uv_neg_idx].v], uv_neg_idx as u16)
                }
            } else {
                ([0.0, 0.0], u16::MAX)
            };
            ring_pos.push([vert.origin.x, vert.origin.y, vert.origin.z]);
            ring_vid.push(raw as u16);
            ring_uv_pos.push(uv_pos);
            ring_uv_neg.push(uv_neg);
            if authored_normals {
                // Identity part frame: normalise the authored normal directly
                // (mirrors quat_rotate(identity) + normalise in the appender).
                let n = [vert.normal.x, vert.normal.y, vert.normal.z];
                let len2 = n[0] * n[0] + n[1] * n[1] + n[2] * n[2];
                if len2 > 1e-12 {
                    let inv = 1.0 / len2.sqrt();
                    ring_normal.push(Some([n[0] * inv, n[1] * inv, n[2] * inv]));
                } else {
                    ring_normal.push(None);
                }
            } else {
                ring_normal.push(None);
            }
        }
        if !ok || ring_pos.len() < 3 {
            continue;
        }

        let dbl = poly.sides_type == 1 || !authored_normals; // env forces DoubleSide
        let front_flags = subset_flag_bits(dbl, stipple_bits(poly.stippling, 0));
        let back_flags = |extra: u8| {
            subset_flag_bits(dbl, stipple_bits(poly.stippling, 1)) | extra
        };

        for i in 2..ring_pos.len() {
            let (a, b, c) = (ring_pos[0], ring_pos[i - 1], ring_pos[i]);
            let n = face_normal(a, b, c);
            let len2 = n[0] * n[0] + n[1] * n[1] + n[2] * n[2];
            if len2 < 1e-12 {
                continue;
            }
            let inv = 1.0 / len2.sqrt();
            let face = [n[0] * inv, n[1] * inv, n[2] * inv];
            let n0 = ring_normal[0].unwrap_or(face);
            let n1 = ring_normal[i - 1].unwrap_or(face);
            let n2 = ring_normal[i].unwrap_or(face);

            let corner = |ring_idx: usize, uv: ([f32; 2], u16), nrm: [f32; 3], side: u8| {
                let qn = [quant_snorm8(nrm[0]), quant_snorm8(nrm[1]), quant_snorm8(nrm[2])];
                (
                    CornerKey { vid: ring_vid[ring_idx], uv_idx: uv.1, side, qn, synth: 0 },
                    CornerRec { pos: ring_pos[ring_idx], uv: uv.0, qn },
                )
            };

            // Front tri: (ring0, ring[i-1], ring[i]) — source order.
            builder.push_tri(
                front_ref,
                front_flags,
                0,
                [
                    corner(0, ring_uv_pos[0], n0, 0),
                    corner(i - 1, ring_uv_pos[i - 1], n1, 0),
                    corner(i, ring_uv_pos[i], n2, 0),
                ],
            );
            // Back tri: (ring0, ring[i], ring[i-1]) with negated normals.
            if let Some((back_ref, pair_slot)) = back {
                let neg = |v: [f32; 3]| [-v[0], -v[1], -v[2]];
                let extra = if authored_normals { 0 } else { subset_flags::ENV_BACKFACE };
                builder.push_tri(
                    back_ref,
                    back_flags(extra),
                    if authored_normals { 0 } else { pair_slot },
                    [
                        corner(0, ring_uv_neg[0], neg(n0), 1),
                        corner(i, ring_uv_neg[i], neg(n2), 1),
                        corner(i - 1, ring_uv_neg[i - 1], neg(n1), 1),
                    ],
                );
            }
        }
    }
}

// ---------------------------------------------------------------------------
// RELIEF-IN-BAKE — material-identity relief variants (2026-08-10)
// ---------------------------------------------------------------------------

/// Bake-side relief profile: the SAME `gfx_remodel` rails the runtime emits at
/// `set_gfx_relief(true, level, scale)`, resolved once at bake instead of once
/// per wasm instance.
///
/// What relief IS, read-verified before this landed (`gfx_subdiv.rs` module
/// docs + `apps/holtburger-web/src/lib.rs` `append_gfx_tris_with_tex_swaps`):
/// the per-TEXEL displacement path (`subdivide_displaced_triangle_sampled`)
/// is gated on `subdiv.level > 0` AND a decoded surface height field, and it
/// was RETIRED as a default on 2026-07-30 (polarity + row-integration banding);
/// presets ship `subdivLevel = 0`, at which the ONLY live relief is
/// `gfx_remodel`'s OP1 convex-edge rails + OP3 material-boundary rails. Those
/// rails are texture-blind, purely ADDITIVE, deterministic, and a pure function
/// of `(polygons, surfaces, positions, uvs, RemodelConfig)` — i.e. exactly the
/// bakeable half. Heights are still decided by MATERIAL IDENTITY; this type
/// only moves WHERE that decision runs.
///
/// The bake is therefore for `subdiv_level = 0` profiles. A t-level ladder of
/// variants (level 1..5) is the designed follow-up and is NOT representable
/// here, because the runtime's level > 0 path needs per-texel height fields.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ReliefBake {
    /// Rail dimensions. `scale` mirrors `?gfxReliefScale`.
    pub remodel: crate::gfx_remodel::RemodelConfig,
    /// "Is this model architecture at all" gate — the runtime uses
    /// `ModelGate::default()`.
    pub gate: crate::gfx_remodel::ModelGate,
    /// Subdivision level the profile was authored for. MUST be 0 in v1: the
    /// bake refuses to claim a level it cannot reproduce.
    pub subdiv_level: u8,
}

impl Default for ReliefBake {
    fn default() -> Self {
        Self {
            remodel: crate::gfx_remodel::RemodelConfig::default(),
            gate: crate::gfx_remodel::ModelGate::default(),
            subdiv_level: 0,
        }
    }
}

impl ReliefBake {
    /// Profile for `set_gfx_relief(true, 0, scale)` — the shipped preset shape.
    pub fn from_scale(scale: f32) -> Self {
        Self {
            remodel: crate::gfx_remodel::RemodelConfig {
                scale,
                ..Default::default()
            },
            ..Default::default()
        }
    }

    /// True when this profile cannot add a single triangle, so callers keep
    /// the relief-free payload and emit no variant row.
    pub fn is_noop(&self) -> bool {
        self.subdiv_level != 0 || self.remodel.is_noop()
    }

    /// Stable identity string for the manifest / report ("which variant is
    /// this dist carrying"). Deliberately mirrors the resolved client config.
    pub fn variant_key(&self) -> String {
        format!(
            "rails-l{}-s{:.3}-w{:.3}-h{:.3}-rw{:.3}-rh{:.3}-e{:.3}-c{:.1}",
            self.subdiv_level,
            self.remodel.scale,
            self.remodel.width_m,
            self.remodel.height_m,
            self.remodel.rail_width_m,
            self.remodel.rail_height_m,
            self.remodel.min_edge_m,
            self.remodel.coplanar_deg,
        )
    }
}

/// Append the relief rails for one GfxObj, mirroring the runtime's OP1+OP3
/// block (`append_gfx_tris_with_tex_swaps`, lib.rs "OP1 — texture-blind
/// convex-edge rails") at the identity part transform HBG1 kind-0 payloads
/// are encoded in, with an empty texture-swap table (the bake path).
///
/// Rails inherit the parent polygon's material identity (`pos_surface` DID,
/// `sides_type`, `stippling`), so every rail triangle lands in an EXISTING
/// subset — no new surface, no new material, no new draw call. That is the
/// property the differ asserts.
fn append_gfx_rails(b: &mut MeshBuilder, gfx: &GfxObj, relief: &ReliefBake) {
    use crate::gfx_remodel::ModelTopology;
    if relief.is_noop() || gfx.vertex_array.vertices.is_empty() || gfx.polygons.is_empty() {
        return;
    }
    let vpos = |raw: i16| -> Option<[f32; 3]> {
        if raw < 0 {
            return None;
        }
        let v = gfx.vertex_array.vertices.get(&(raw as u16))?;
        Some([v.origin.x, v.origin.y, v.origin.z])
    };
    let vuv = |raw: i16, _ring_idx: usize| -> Option<[f32; 2]> {
        if raw < 0 {
            return None;
        }
        let v = gfx.vertex_array.vertices.get(&(raw as u16))?;
        v.uvs.first().map(|t| [t.u, t.v])
    };
    let topo = ModelTopology::build(&gfx.polygons, &gfx.surfaces, &[], &vpos, &vuv);
    if !topo.passes_gate(&relief.gate) {
        return;
    }
    let mut synth: u32 = 0;
    let mut push = |pid: u16, pos: [[f32; 3]; 3], uv: [[f32; 2]; 3], nrm: [f32; 3]| {
        let Some(poly) = gfx.polygons.get(&pid) else {
            return;
        };
        let did = if poly.pos_surface >= 0 && (poly.pos_surface as usize) < gfx.surfaces.len() {
            gfx.surfaces[poly.pos_surface as usize]
        } else {
            0
        };
        if did == 0 {
            return;
        }
        // Flat-shaded on purpose (runtime comment: "a constant facet normal is
        // what makes a batten read as a batten").
        let qn = [quant_snorm8(nrm[0]), quant_snorm8(nrm[1]), quant_snorm8(nrm[2])];
        let flags = subset_flag_bits(poly.sides_type == 1, stipple_bits(poly.stippling, 0));
        let mut corners: Vec<(CornerKey, CornerRec)> = Vec::with_capacity(3);
        for k in 0..3 {
            synth += 1;
            corners.push((
                CornerKey { vid: u16::MAX, uv_idx: u16::MAX, side: 0, qn, synth },
                CornerRec { pos: pos[k], uv: uv[k], qn },
            ));
        }
        let tri: [(CornerKey, CornerRec); 3] = match corners.try_into() {
            Ok(t) => t,
            Err(_) => return,
        };
        b.push_tri(did, flags, 0, tri);
    };
    // OP1 takes edges >= coplanar_deg, OP3 takes edges below it — disjoint by
    // construction, so an edge never grows two rails. Same call order as the
    // runtime (determinism: both walk sorted edge keys).
    topo.emit_convex_rails(&relief.remodel, &mut push);
    topo.emit_material_rails(&relief.remodel, &mut push);
}

/// Encode one 0x01 GfxObj's drawing polygons as a kind-0 PART payload.
/// Mirrors `append_gfx_tris` (identity transform, no swaps, relief off).
/// The `did_degrade` trailer carries the record's own chain id.
pub fn encode_gfx_part(gfx: &GfxObj) -> Result<Vec<u8>, String> {
    encode_gfx_part_variant(gfx, None)
}

/// Relief VARIANT of [`encode_gfx_part`] (RELIEF-IN-BAKE). `None` reproduces
/// the relief-free default byte-for-byte — the differ baseline is never
/// disturbed by this path existing.
pub fn encode_gfx_part_relief(gfx: &GfxObj, relief: &ReliefBake) -> Result<Vec<u8>, String> {
    encode_gfx_part_variant(gfx, Some(relief))
}

fn encode_gfx_part_variant(
    gfx: &GfxObj,
    relief: Option<&ReliefBake>,
) -> Result<Vec<u8>, String> {
    let mut b = MeshBuilder::default();
    if !gfx.vertex_array.vertices.is_empty() && !gfx.polygons.is_empty() {
        fan_polygons(
            &mut b,
            &gfx.vertex_array.vertices,
            &gfx.polygons,
            true,
            |poly| {
                let raw_pos = if poly.pos_surface >= 0
                    && (poly.pos_surface as usize) < gfx.surfaces.len()
                {
                    gfx.surfaces[poly.pos_surface as usize]
                } else {
                    0
                };
                let has_back = poly.sides_type == CULL_CLOCKWISE
                    && (poly.stippling & NO_NEG) == 0
                    && !poly.neg_uv_indices.is_empty();
                let raw_neg = if has_back
                    && poly.neg_surface >= 0
                    && (poly.neg_surface as usize) < gfx.surfaces.len()
                {
                    gfx.surfaces[poly.neg_surface as usize]
                } else {
                    0
                };
                let emit_back = has_back && raw_neg != 0 && raw_neg != raw_pos;
                Some((raw_pos, if emit_back { Some((raw_neg, 0)) } else { None }))
            },
        );
    }
    // Relief runs LAST and is purely additive — exactly the runtime's ordering,
    // so the base triangles of every subset keep their emission order and the
    // variant differs from the default only by appended rail triangles.
    if let Some(r) = relief {
        append_gfx_rails(&mut b, gfx, r);
    }
    b.serialize(KIND_PART, false, gfx.did_degrade.unwrap_or(0))
}

/// Encode one Environment cellstruct as a kind-0 block with SLOT subset refs
/// and the zero-filled baked-light stream. Mirrors `append_environment_tris`
/// with the per-cell DID comparisons deferred to load (module docs).
pub fn encode_env_cellstruct(cell: &CellStruct) -> Result<Vec<u8>, String> {
    let mut b = MeshBuilder::default();
    if !cell.vertex_array.vertices.is_empty() && !cell.polygons.is_empty() {
        fan_polygons(
            &mut b,
            &cell.vertex_array.vertices,
            &cell.polygons,
            false,
            |poly| {
                let front = if poly.pos_surface >= 0 {
                    poly.pos_surface as u32
                } else {
                    ENV_SLOT_NONE
                };
                // Bake-side condition: runtime additionally requires the neg
                // slot in-range of the CELL's surface list and the resolved
                // DIDs distinct — both per-cell facts, applied at assembly.
                let has_back = poly.sides_type == CULL_CLOCKWISE
                    && (poly.stippling & NO_NEG) == 0
                    && !poly.neg_uv_indices.is_empty()
                    && poly.neg_surface >= 0;
                let pair = if poly.pos_surface >= 0 { poly.pos_surface as u16 } else { u16::MAX };
                Some((
                    front,
                    if has_back { Some((poly.neg_surface as u32, pair)) } else { None },
                ))
            },
        );
    }
    b.serialize(KIND_ENV_MESH_KIND, true, 0)
}

/// Embedded ENV mesh blocks are serialized with the PART kind byte so a
/// single mesh parser handles both; the ENCLOSING payload is kind 2.
const KIND_ENV_MESH_KIND: u8 = KIND_PART;

// ---------------------------------------------------------------------------
// Setup directory (kind 1) encoder
// ---------------------------------------------------------------------------

/// Frame = (pos, quat wxyz). Identity when absent.
pub type Frame7 = ([f32; 3], [f32; 4]);

const IDENTITY_FRAME: Frame7 = ([0.0, 0.0, 0.0], [1.0, 0.0, 0.0, 0.0]);

fn frame_of(f: &crate::graphics::Frame) -> Frame7 {
    (
        [f.origin.x, f.origin.y, f.origin.z],
        [f.orientation.w, f.orientation.x, f.orientation.y, f.orientation.z],
    )
}

/// The static-path pose chain (`walk_setup_parts`, pose_override = None,
/// mtable_override = None, wire_placement = None): idle-anim frame →
/// static placement frame → identity. The placement chain uses RETAIL order
/// (`0x65 → 0 → first`) because the wasm `?placementId` gate defaults ON
/// (lib.rs:832-853); the client disarms `?geomBundles` under
/// `?placementId=off`.
fn resolve_idle_anim_frame<S: ResourceSource + ?Sized>(
    source: &S,
    setup: &SetupModel,
) -> Option<AnimationFrame> {
    let mut anim_did: u32 = 0;
    if let Some(mt_id) = setup.default_motion_table {
        if (mt_id >> 24) == 0x09
            && let Ok(bytes) = source.get_file_by_key(ResourceKey::new(EOR_PORTAL_NAMESPACE, mt_id))
            && let Ok(mtable) = MotionTable::read(&mut Cursor::new(&bytes))
            && let Some(&idle_substate) = mtable.style_defaults.get(&mtable.default_style)
        {
            let cycle_key = (mtable.default_style << 16) | (idle_substate & 0x00FF_FFFF);
            if let Some(motion_data) = mtable.cycles.get(&cycle_key)
                && let Some(first_anim) = motion_data.anims.first()
            {
                anim_did = first_anim.anim_id;
            }
        }
    }
    if anim_did == 0
        && let Some(da) = setup.default_animation
    {
        anim_did = da;
    }
    if anim_did == 0 || (anim_did >> 24) != 0x03 {
        return None;
    }
    let bytes = source
        .get_file_by_key(ResourceKey::new(EOR_PORTAL_NAMESPACE, anim_did))
        .ok()?;
    let anim = Animation::read(&mut Cursor::new(&bytes)).ok()?;
    anim.part_frames.into_iter().next()
}

/// Bake-resolved `did_degrade` for a setup — mirrors `resolve_did_degrade`
/// (lib.rs:9406): single-part setups take their part's chain; multi-part 0.
fn resolve_setup_degrade<S: ResourceSource + ?Sized>(source: &S, setup: &SetupModel) -> u32 {
    if setup.parts.len() != 1 {
        return 0;
    }
    let Some(&first_part) = setup.parts.first() else {
        return 0;
    };
    if (first_part >> 24) as u8 != 0x01 {
        return 0;
    }
    let Ok(bytes) = source.get_file_by_key(ResourceKey::new(EOR_PORTAL_NAMESPACE, first_part))
    else {
        return 0;
    };
    let Ok(gfx) = GfxObj::unpack(&mut Cursor::new(&bytes)) else {
        return 0;
    };
    gfx.did_degrade.unwrap_or(0)
}

/// Encode one 0x02 SetupModel as a kind-1 SETUP directory.
pub fn encode_setup_directory<S: ResourceSource + ?Sized>(
    source: &S,
    setup: &SetupModel,
) -> Result<Vec<u8>, String> {
    let idle = resolve_idle_anim_frame(source, setup);
    // Retail placement chain (see resolve_static_placement_frame, retail arm,
    // wire_placement = None): 0x65 → 0 → first.
    let placement = setup
        .placement_frames
        .get(&0x65)
        .or_else(|| setup.placement_frames.get(&0))
        .or_else(|| setup.placement_frames.values().next());
    // Hinge chain (compute_hinge_frames): 0 → 1 → first.
    let hinge_placement = setup
        .placement_frames
        .get(&0)
        .or_else(|| setup.placement_frames.get(&1))
        .or_else(|| setup.placement_frames.values().next());

    let did_degrade = resolve_setup_degrade(source, setup);

    let mut rows: Vec<(u32, Frame7, [f32; 3], Frame7)> = Vec::with_capacity(setup.parts.len());
    let mut fused_min = [f32::INFINITY; 3];
    let mut fused_max = [f32::NEG_INFINITY; 3];
    for (pi, &part_id) in setup.parts.iter().enumerate() {
        let frame = idle
            .as_ref()
            .filter(|f| pi < f.frames.len())
            .map(|f| frame_of(&f.frames[pi]))
            .or_else(|| {
                placement
                    .filter(|p| pi < p.anim_frame.frames.len())
                    .map(|p| frame_of(&p.anim_frame.frames[pi]))
            })
            .unwrap_or(IDENTITY_FRAME);
        let hinge = hinge_placement
            .filter(|p| pi < p.anim_frame.frames.len())
            .map(|p| frame_of(&p.anim_frame.frames[pi]))
            .unwrap_or(IDENTITY_FRAME);
        let scale = setup
            .default_scale
            .get(pi)
            .map(|s| [s.x, s.y, s.z])
            .unwrap_or([1.0, 1.0, 1.0]);

        // Fused bbox: fold each drawable part's emitted-corner bbox through
        // scale → rotate → translate (exact over unique corners; informational).
        if (part_id >> 24) as u8 == 0x01
            && let Ok(bytes) =
                source.get_file_by_key(ResourceKey::new(EOR_PORTAL_NAMESPACE, part_id))
            && let Ok(gfx) = GfxObj::unpack(&mut Cursor::new(&bytes))
            && let Ok(payload) = encode_gfx_part(&gfx)
            && let Ok(mesh) = Hbg1Mesh::parse(&payload)
        {
            let (pos, quat) = frame;
            for v in 0..mesh.vertex_count {
                let p = mesh.position(v);
                let scaled = [p[0] * scale[0], p[1] * scale[1], p[2] * scale[2]];
                let r = quat_rotate(quat, scaled);
                let w = [r[0] + pos[0], r[1] + pos[1], r[2] + pos[2]];
                for k in 0..3 {
                    if w[k] < fused_min[k] {
                        fused_min[k] = w[k];
                    }
                    if w[k] > fused_max[k] {
                        fused_max[k] = w[k];
                    }
                }
            }
        }
        rows.push((part_id, frame, scale, hinge));
    }
    if !fused_min[0].is_finite() {
        fused_min = [0.0; 3];
        fused_max = [0.0; 3];
    }

    let mut payload_flags: u16 = 0;
    if did_degrade != 0 {
        payload_flags |= flags::DID_DEGRADE;
    }
    let body_off = PAYLOAD_HEADER_LEN;
    let rows_off = body_off + 28; // part_count u16 + flags u16 + bbox f32×6
    let trailer_off = if did_degrade != 0 {
        rows_off + rows.len() * SETUP_PART_ROW_LEN
    } else {
        0
    };

    let mut out = Vec::new();
    out.extend_from_slice(HBG1_MAGIC);
    out.push(KIND_SETUP);
    out.push(HBG1_VERSION);
    out.extend_from_slice(&payload_flags.to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes());
    out.extend_from_slice(&(trailer_off as u32).to_le_bytes());
    out.extend_from_slice(&(rows.len() as u16).to_le_bytes());
    let dir_flags: u16 = if rows.len() == 1 { 1 } else { 0 }; // bit0 single-part
    out.extend_from_slice(&dir_flags.to_le_bytes());
    for v in fused_min.iter().chain(fused_max.iter()) {
        out.extend_from_slice(&v.to_le_bytes());
    }
    for (did, (fp, fq), scale, (hp, hq)) in &rows {
        out.extend_from_slice(&did.to_le_bytes());
        for v in fp.iter().chain(fq.iter()) {
            out.extend_from_slice(&v.to_le_bytes());
        }
        for v in scale {
            out.extend_from_slice(&v.to_le_bytes());
        }
        for v in hp.iter().chain(hq.iter()) {
            out.extend_from_slice(&v.to_le_bytes());
        }
    }
    if did_degrade != 0 {
        out.extend_from_slice(&did_degrade.to_le_bytes());
    }
    Ok(out)
}

/// Quaternion (w,x,y,z) rotation of a vector — the same expansion as
/// lib.rs `quat_rotate` so assembled positions are bit-identical.
#[inline]
pub fn quat_rotate(q: [f32; 4], v: [f32; 3]) -> [f32; 3] {
    let (w, x, y, z) = (q[0], q[1], q[2], q[3]);
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

// ---------------------------------------------------------------------------
// ENV directory (kind 2) encoder
// ---------------------------------------------------------------------------

/// Encode one 0x0D Environment as a kind-2 ENV directory: every cellstruct,
/// sorted by id (each consuming EnvCell selects one via `cell_structure`).
pub fn encode_env_directory(env: &Environment) -> Result<Vec<u8>, String> {
    let mut ids: Vec<u32> = env.cells.keys().copied().collect();
    ids.sort_unstable();
    let mut blocks: Vec<(u32, Vec<u8>)> = Vec::with_capacity(ids.len());
    for id in ids {
        let block = encode_env_cellstruct(&env.cells[&id])?;
        blocks.push((id, block));
    }
    let dir_off = PAYLOAD_HEADER_LEN + 4; // count u16 + reserved u16
    let mut mesh_off = align4(dir_off + blocks.len() * 8);
    let mut offsets: Vec<u32> = Vec::with_capacity(blocks.len());
    for (_, b) in &blocks {
        offsets.push(mesh_off as u32);
        mesh_off = align4(mesh_off + b.len());
    }

    let mut out = Vec::with_capacity(mesh_off);
    out.extend_from_slice(HBG1_MAGIC);
    out.push(KIND_ENV);
    out.push(HBG1_VERSION);
    out.extend_from_slice(&0u16.to_le_bytes()); // flags (per-block flags live in blocks)
    out.extend_from_slice(&0u32.to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes()); // no trailer
    out.extend_from_slice(&(blocks.len() as u16).to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    for ((id, _), off) in blocks.iter().zip(&offsets) {
        out.extend_from_slice(&id.to_le_bytes());
        out.extend_from_slice(&off.to_le_bytes());
    }
    for ((_, b), off) in blocks.iter().zip(&offsets) {
        while out.len() < *off as usize {
            out.push(0);
        }
        out.extend_from_slice(b);
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Decoders
// ---------------------------------------------------------------------------

fn rd_u16(b: &[u8], off: usize) -> Result<u16, String> {
    b.get(off..off + 2)
        .map(|s| u16::from_le_bytes([s[0], s[1]]))
        .ok_or_else(|| format!("HBG1: short read u16 @{off}"))
}
fn rd_u32(b: &[u8], off: usize) -> Result<u32, String> {
    b.get(off..off + 4)
        .map(|s| u32::from_le_bytes([s[0], s[1], s[2], s[3]]))
        .ok_or_else(|| format!("HBG1: short read u32 @{off}"))
}
fn rd_f32(b: &[u8], off: usize) -> Result<f32, String> {
    Ok(f32::from_bits(rd_u32(b, off)?))
}

/// Parsed payload header (any kind).
#[derive(Debug, Clone, Copy)]
pub struct Hbg1Header {
    pub kind: u8,
    pub version: u8,
    pub flags: u16,
    pub trailer_off: u32,
}

pub fn parse_header(b: &[u8]) -> Result<Hbg1Header, String> {
    if b.len() < PAYLOAD_HEADER_LEN {
        return Err("HBG1: payload shorter than header".into());
    }
    if &b[0..4] != HBG1_MAGIC {
        return Err("HBG1: bad magic".into());
    }
    let h = Hbg1Header {
        kind: b[4],
        version: b[5],
        flags: rd_u16(b, 6)?,
        trailer_off: rd_u32(b, 12)?,
    };
    if h.version != HBG1_VERSION {
        return Err(format!("HBG1: unsupported version {}", h.version));
    }
    Ok(h)
}

/// One subset row.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Subset {
    pub surface_ref: u32,
    pub flags: u8,
    /// ENV back-face subsets: the paired positive slot (reserved bytes 0..2).
    pub pair_slot: u16,
    pub first_index: u32,
    pub index_count: u32,
}

/// Borrowed view over a kind-0 mesh block.
pub struct Hbg1Mesh<'a> {
    bytes: &'a [u8],
    pub header: Hbg1Header,
    pub vertex_count: usize,
    pub index_count: usize,
    pub subset_count: usize,
    pub bbox_min: [f32; 3],
    pub bbox_max: [f32; 3],
    stream_off: usize,
    pub idx_u32: bool,
    pub has_baked_light: bool,
    pub did_degrade: u32,
}

impl<'a> Hbg1Mesh<'a> {
    pub fn parse(b: &'a [u8]) -> Result<Self, String> {
        let header = parse_header(b)?;
        if header.kind != KIND_PART {
            return Err(format!("HBG1: expected kind-0 mesh, got {}", header.kind));
        }
        let mh = PAYLOAD_HEADER_LEN;
        let vertex_count = rd_u32(b, mh)? as usize;
        let index_count = rd_u32(b, mh + 4)? as usize;
        let subset_count = rd_u16(b, mh + 8)? as usize;
        let mut bbox_min = [0.0f32; 3];
        let mut bbox_max = [0.0f32; 3];
        for k in 0..3 {
            bbox_min[k] = rd_f32(b, mh + 12 + 4 * k)?;
            bbox_max[k] = rd_f32(b, mh + 24 + 4 * k)?;
        }
        let stream_off = rd_u32(b, mh + 36)? as usize;
        let idx_u32 = header.flags & flags::IDX_U32 != 0;
        let has_baked_light = header.flags & flags::BAKED_LIGHT != 0;
        let m = Hbg1Mesh {
            bytes: b,
            header,
            vertex_count,
            index_count,
            subset_count,
            bbox_min,
            bbox_max,
            stream_off,
            idx_u32,
            has_baked_light,
            did_degrade: 0,
        };
        // Bounds-check the full extent once.
        let end = m.subsets_off() + subset_count * SUBSET_ROW_LEN;
        if end > b.len() {
            return Err(format!(
                "HBG1: mesh extent {end} exceeds payload {}",
                b.len()
            ));
        }
        let did_degrade = if header.flags & flags::DID_DEGRADE != 0 {
            rd_u32(b, header.trailer_off as usize)?
        } else {
            0
        };
        Ok(Hbg1Mesh { did_degrade, ..m })
    }

    #[inline]
    pub fn positions_off(&self) -> usize {
        self.stream_off
    }
    #[inline]
    pub fn normals_off(&self) -> usize {
        self.stream_off + 12 * self.vertex_count
    }
    #[inline]
    pub fn uvs_off(&self) -> usize {
        self.normals_off() + 4 * self.vertex_count
    }
    #[inline]
    pub fn baked_off(&self) -> Option<usize> {
        if self.has_baked_light {
            Some(self.uvs_off() + 8 * self.vertex_count)
        } else {
            None
        }
    }
    #[inline]
    pub fn indices_off(&self) -> usize {
        self.uvs_off()
            + 8 * self.vertex_count
            + if self.has_baked_light { 4 * self.vertex_count } else { 0 }
    }
    #[inline]
    pub fn subsets_off(&self) -> usize {
        self.indices_off() + align4(if self.idx_u32 { 4 } else { 2 } * self.index_count)
    }

    #[inline]
    pub fn position(&self, v: usize) -> [f32; 3] {
        let o = self.positions_off() + 12 * v;
        [
            rd_f32(self.bytes, o).unwrap(),
            rd_f32(self.bytes, o + 4).unwrap(),
            rd_f32(self.bytes, o + 8).unwrap(),
        ]
    }

    /// Dequantized f32 normal.
    #[inline]
    pub fn normal(&self, v: usize) -> [f32; 3] {
        let o = self.normals_off() + 4 * v;
        [
            dequant_snorm8(self.bytes[o] as i8),
            dequant_snorm8(self.bytes[o + 1] as i8),
            dequant_snorm8(self.bytes[o + 2] as i8),
        ]
    }

    #[inline]
    pub fn uv(&self, v: usize) -> [f32; 2] {
        let o = self.uvs_off() + 8 * v;
        [rd_f32(self.bytes, o).unwrap(), rd_f32(self.bytes, o + 4).unwrap()]
    }

    #[inline]
    pub fn index(&self, i: usize) -> u32 {
        if self.idx_u32 {
            rd_u32(self.bytes, self.indices_off() + 4 * i).unwrap()
        } else {
            rd_u16(self.bytes, self.indices_off() + 2 * i).unwrap() as u32
        }
    }

    pub fn subset(&self, s: usize) -> Result<Subset, String> {
        let o = self.subsets_off() + s * SUBSET_ROW_LEN;
        Ok(Subset {
            surface_ref: rd_u32(self.bytes, o)?,
            flags: self.bytes[o + 4],
            pair_slot: rd_u16(self.bytes, o + 5)?,
            first_index: rd_u32(self.bytes, o + 8)?,
            index_count: rd_u32(self.bytes, o + 12)?,
        })
    }

    pub fn subsets(&self) -> Result<Vec<Subset>, String> {
        (0..self.subset_count).map(|s| self.subset(s)).collect()
    }
}

/// One kind-1 SETUP directory part row.
#[derive(Debug, Clone, Copy)]
pub struct SetupPartRow {
    pub part_did: u32,
    pub frame_pos: [f32; 3],
    /// (w, x, y, z)
    pub frame_quat: [f32; 4],
    pub scale: [f32; 3],
    pub hinge_pos: [f32; 3],
    pub hinge_quat: [f32; 4],
}

pub struct Hbg1Setup {
    pub parts: Vec<SetupPartRow>,
    pub single_part: bool,
    pub fused_bbox_min: [f32; 3],
    pub fused_bbox_max: [f32; 3],
    pub did_degrade: u32,
}

pub fn parse_setup(b: &[u8]) -> Result<Hbg1Setup, String> {
    let header = parse_header(b)?;
    if header.kind != KIND_SETUP {
        return Err(format!("HBG1: expected kind-1 setup, got {}", header.kind));
    }
    let o = PAYLOAD_HEADER_LEN;
    let part_count = rd_u16(b, o)? as usize;
    let dir_flags = rd_u16(b, o + 2)?;
    let mut bbox_min = [0.0f32; 3];
    let mut bbox_max = [0.0f32; 3];
    for k in 0..3 {
        bbox_min[k] = rd_f32(b, o + 4 + 4 * k)?;
        bbox_max[k] = rd_f32(b, o + 16 + 4 * k)?;
    }
    let rows_off = o + 28;
    let mut parts = Vec::with_capacity(part_count);
    for pi in 0..part_count {
        let r = rows_off + pi * SETUP_PART_ROW_LEN;
        let f = |k: usize| rd_f32(b, r + 4 + 4 * k);
        parts.push(SetupPartRow {
            part_did: rd_u32(b, r)?,
            frame_pos: [f(0)?, f(1)?, f(2)?],
            frame_quat: [f(3)?, f(4)?, f(5)?, f(6)?],
            scale: [f(7)?, f(8)?, f(9)?],
            hinge_pos: [f(10)?, f(11)?, f(12)?],
            hinge_quat: [f(13)?, f(14)?, f(15)?, f(16)?],
        });
    }
    let did_degrade = if header.flags & flags::DID_DEGRADE != 0 {
        rd_u32(b, header.trailer_off as usize)?
    } else {
        0
    };
    Ok(Hbg1Setup {
        parts,
        single_part: dir_flags & 1 != 0,
        fused_bbox_min: bbox_min,
        fused_bbox_max: bbox_max,
        did_degrade,
    })
}

pub struct Hbg1EnvDir<'a> {
    bytes: &'a [u8],
    /// (cellstruct_id, mesh_off) rows, in payload order (sorted by id).
    pub entries: Vec<(u32, u32)>,
}

impl<'a> Hbg1EnvDir<'a> {
    pub fn parse(b: &'a [u8]) -> Result<Self, String> {
        let header = parse_header(b)?;
        if header.kind != KIND_ENV {
            return Err(format!("HBG1: expected kind-2 env dir, got {}", header.kind));
        }
        let o = PAYLOAD_HEADER_LEN;
        let count = rd_u16(b, o)? as usize;
        let mut entries = Vec::with_capacity(count);
        for i in 0..count {
            let r = o + 4 + 8 * i;
            entries.push((rd_u32(b, r)?, rd_u32(b, r + 4)?));
        }
        Ok(Hbg1EnvDir { bytes: b, entries })
    }

    /// Mesh block for a cellstruct id (linear scan — ≤ tens of entries).
    pub fn mesh_for(&self, cellstruct_id: u32) -> Option<Result<Hbg1Mesh<'a>, String>> {
        let &(_, off) = self.entries.iter().find(|(id, _)| *id == cellstruct_id)?;
        Some(Hbg1Mesh::parse(&self.bytes[off as usize..]))
    }
}

// ---------------------------------------------------------------------------
// GEOM section codec (pack 2 D-02.7 row shape)
// ---------------------------------------------------------------------------

/// Build a GEOM section: `[count u32]` + rows
/// `[model_id u32][encoding u16][reserved u16][offset u32][size u32]` +
/// payload blob. Offsets are absolute within the section, 4-B aligned.
/// Entries are emitted sorted by model id (determinism).
pub fn build_geom_section(entries: &std::collections::BTreeMap<u32, Vec<u8>>) -> Vec<u8> {
    let header_len = 4 + entries.len() * 16;
    let mut off = align4(header_len);
    let mut out = Vec::new();
    out.extend_from_slice(&(entries.len() as u32).to_le_bytes());
    let mut offsets = Vec::with_capacity(entries.len());
    for payload in entries.values() {
        offsets.push(off);
        off = align4(off + payload.len());
    }
    for ((id, payload), po) in entries.iter().zip(&offsets) {
        out.extend_from_slice(&id.to_le_bytes());
        out.extend_from_slice(&ENCODING_HBG1.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&(*po as u32).to_le_bytes());
        out.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    }
    for (payload, po) in entries.values().zip(&offsets) {
        while out.len() < *po {
            out.push(0);
        }
        out.extend_from_slice(payload);
    }
    out
}

/// Parse a GEOM section into `(model_id, encoding, offset, size)` rows.
pub fn parse_geom_section(b: &[u8]) -> Result<Vec<(u32, u16, usize, usize)>, String> {
    let count = rd_u32(b, 0)? as usize;
    let mut rows = Vec::with_capacity(count);
    for i in 0..count {
        let r = 4 + 16 * i;
        let id = rd_u32(b, r)?;
        let enc = rd_u16(b, r + 4)?;
        let off = rd_u32(b, r + 8)? as usize;
        let size = rd_u32(b, r + 12)? as usize;
        if off + size > b.len() {
            return Err(format!(
                "GEOM: row 0x{id:08X} extent {}+{} exceeds section {}",
                off,
                size,
                b.len()
            ));
        }
        rows.push((id, enc, off, size));
    }
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graphics::{CVertexArray, SWVertex, Vec2Duv};
    use holtburger_common::{Quaternion, Vector3};

    fn v(x: f32, y: f32, z: f32, n: [f32; 3], uvs: &[(f32, f32)]) -> SWVertex {
        SWVertex {
            num_uvs: uvs.len() as u16,
            origin: Vector3 { x, y, z },
            normal: Vector3 { x: n[0], y: n[1], z: n[2] },
            uvs: uvs.iter().map(|&(u, vv)| Vec2Duv { u, v: vv }).collect(),
        }
    }

    fn quad_gfx() -> GfxObj {
        // One quad (2 tris) on surface[0] + one two-sided-distinct tri
        // (surfaces 0 front / 1 back).
        let mut vertices = HashMap::new();
        vertices.insert(0, v(0.0, 0.0, 0.0, [0.0, 0.0, 1.0], &[(0.0, 0.0)]));
        vertices.insert(1, v(1.0, 0.0, 0.0, [0.0, 0.0, 1.0], &[(1.0, 0.0)]));
        vertices.insert(2, v(1.0, 1.0, 0.0, [0.0, 0.0, 1.0], &[(1.0, 1.0)]));
        vertices.insert(3, v(0.0, 1.0, 0.0, [0.0, 0.0, 0.0], &[(0.0, 1.0)])); // degenerate normal → face fallback
        vertices.insert(4, v(0.0, 0.0, 1.0, [1.0, 0.0, 0.0], &[(0.5, 0.5), (0.25, 0.25)]));
        let mut polygons = HashMap::new();
        polygons.insert(
            7,
            Polygon {
                num_pts: 4,
                stippling: 0,
                sides_type: 1, // CullMode::None → doubleSided
                pos_surface: 0,
                neg_surface: -1,
                vertex_ids: vec![0, 1, 2, 3],
                pos_uv_indices: vec![0, 0, 0, 0],
                neg_uv_indices: vec![],
            },
        );
        polygons.insert(
            3,
            Polygon {
                num_pts: 3,
                stippling: 1,
                sides_type: 2, // Clockwise → back face candidate
                pos_surface: 0,
                neg_surface: 1,
                vertex_ids: vec![0, 1, 4],
                pos_uv_indices: vec![0, 0, 0],
                neg_uv_indices: vec![0, 0, 1],
            },
        );
        GfxObj {
            id: 0x0100_0001,
            flags: holtburger_common::properties::GfxObjFlags::HAS_DRAWING,
            surfaces: vec![0x0800_0010, 0x0800_0020],
            vertex_array: CVertexArray { vertex_type: 1, vertices },
            physics_polygons: HashMap::new(),
            physics_bsp: None,
            sort_center: Vector3::zero(),
            polygons,
            // A leaf drawing BSP so `pack()` keeps HAS_DRAWING (it strips the
            // flag — and the polygons — when drawing_bsp is None).
            drawing_bsp: Some(crate::physics::BspNode::Leaf(crate::physics::BspLeaf {
                index: 0,
                solid: 0,
                sphere: None,
                poly_ids: vec![],
            })),
            did_degrade: Some(0x1100_0001),
        }
    }

    #[test]
    fn gfx_part_roundtrip_and_shape() {
        let gfx = quad_gfx();
        let payload = encode_gfx_part(&gfx).expect("encode");
        // Deterministic.
        assert_eq!(payload, encode_gfx_part(&gfx).unwrap());
        let mesh = Hbg1Mesh::parse(&payload).expect("parse");
        // Poly 3 first (sorted pid order): front tri + distinct back tri;
        // poly 7: quad fan = 2 tris. Total 4 tris = 12 indices.
        assert_eq!(mesh.index_count, 12);
        assert_eq!(mesh.did_degrade, 0x1100_0001);
        let subs = mesh.subsets().unwrap();
        // Subsets: (surface 0x10, front, stippled), (surface 0x20, back),
        // (surface 0x10, dbl quad, unstippled) — 3 distinct.
        assert_eq!(subs.len(), 3);
        // Ranges disjoint + complete + ascending.
        let mut covered = 0;
        for s in &subs {
            assert_eq!(s.first_index, covered);
            covered += s.index_count;
        }
        assert_eq!(covered, mesh.index_count as u32);
        // First subset: poly 3's front face — stipple bit0 set (stippling 1 > 0)
        // AND bit1 (positive side reads stippling & 1); not doubleSided.
        assert_eq!(subs[0].surface_ref, 0x0800_0010);
        assert_eq!(
            subs[0].flags,
            subset_flags::STIPPLE_WRAP | subset_flags::STIPPLE_SIDE
        );
        // Back subset carries the back surface, no ENV flag on the model path.
        assert_eq!(subs[1].surface_ref, 0x0800_0020);
        assert_eq!(subs[1].flags & subset_flags::ENV_BACKFACE, 0);
        // Quad subset doubleSided (sides_type == 1).
        assert_eq!(subs[2].surface_ref, 0x0800_0010);
        assert_eq!(subs[2].flags, subset_flags::DOUBLE_SIDED);
        // Vertex dedup: quad shares v0/v1 with poly 3's front? Different
        // normals (authored z-up vs x-up on v4 only) — v0 IS shared between
        // poly 3 front (authored [0,0,1]) and quad (authored [0,0,1]) → dedup.
        assert!(mesh.vertex_count < 12, "dedup happened: {}", mesh.vertex_count);
        // Positions bit-exact.
        let i0 = mesh.index(0) as usize;
        assert_eq!(mesh.position(i0), [0.0, 0.0, 0.0]);
        // Degenerate-normal vertex (v3) got the face normal [0,0,1].
        // Find v3 by position (0,1,0).
        let v3 = (0..mesh.vertex_count)
            .find(|&i| mesh.position(i) == [0.0, 1.0, 0.0])
            .expect("v3 present");
        let n = mesh.normal(v3);
        assert!((n[2] - 1.0).abs() < 0.01, "face-normal fallback: {n:?}");
    }

    #[test]
    fn setup_directory_frames_scale_hinge() {
        use crate::file_type::setup_model::{PlacementType};
        use crate::graphics::Frame;
        // Fixture source carrying one part GfxObj.
        struct Fix(HashMap<u32, Vec<u8>>);
        impl ResourceSource for Fix {
            fn get_file_by_key(&self, key: ResourceKey<'_>) -> crate::Result<Vec<u8>> {
                self.0
                    .get(&key.file_id)
                    .cloned()
                    .ok_or(crate::DatError::NotFound(key.file_id))
            }
            fn get_metadata_by_key(&self, _key: ResourceKey<'_>) -> Option<crate::FileMetadata> {
                None
            }
            fn has_namespace(&self, namespace: &str) -> bool {
                namespace == EOR_PORTAL_NAMESPACE
            }
        }
        let gfx = quad_gfx();
        let mut gfx_bytes = Vec::new();
        gfx.pack(&mut Cursor::new(&mut gfx_bytes)).unwrap();

        let frame = |x: f32| Frame {
            origin: Vector3 { x, y: 2.0, z: 3.0 },
            orientation: Quaternion { w: 1.0, x: 0.0, y: 0.0, z: 0.0 },
        };
        let mut placement_frames = HashMap::new();
        // 0x65 (Resting) present → retail pose chain picks it; hinge chain
        // (0 → 1 → first) picks placement 0.
        placement_frames.insert(
            0x65,
            PlacementType {
                anim_frame: AnimationFrame { frames: vec![frame(65.0)], hooks: vec![] },
            },
        );
        placement_frames.insert(
            0,
            PlacementType {
                anim_frame: AnimationFrame { frames: vec![frame(0.5)], hooks: vec![] },
            },
        );
        let setup = SetupModel {
            id: 0x0200_0001,
            flags: 0,
            parts: vec![gfx.id],
            parent_index: vec![],
            default_scale: vec![Vector3 { x: 2.0, y: 2.0, z: 2.0 }],
            holding_locations: HashMap::new(),
            connection_points: HashMap::new(),
            placement_frames,
            cyl_spheres: vec![],
            spheres: vec![],
            height: 0.0,
            radius: 0.0,
            step_up: 0.0,
            step_down: 0.0,
            sorting_sphere: holtburger_common::Sphere {
                center: Vector3::zero(),
                radius: 0.0,
            },
            selection_sphere: holtburger_common::Sphere {
                center: Vector3::zero(),
                radius: 0.0,
            },
            lights: HashMap::new(),
            default_animation: None,
            default_script: None,
            default_motion_table: None,
            default_sound_table: None,
            default_script_table: None,
        };
        let src = Fix(HashMap::from([(gfx.id, gfx_bytes)]));
        let payload = encode_setup_directory(&src, &setup).expect("encode setup");
        assert_eq!(payload, encode_setup_directory(&src, &setup).unwrap());
        let dir = parse_setup(&payload).expect("parse setup");
        assert!(dir.single_part);
        assert_eq!(dir.parts.len(), 1);
        let row = &dir.parts[0];
        assert_eq!(row.part_did, 0x0100_0001);
        // Pose chain: no idle anim → retail placement 0x65.
        assert_eq!(row.frame_pos, [65.0, 2.0, 3.0]);
        // Hinge chain: 0 → 1 → first ⇒ placement 0.
        assert_eq!(row.hinge_pos, [0.5, 2.0, 3.0]);
        assert_eq!(row.scale, [2.0, 2.0, 2.0]);
        // Single-part degrade resolved from the part's chain.
        assert_eq!(dir.did_degrade, 0x1100_0001);
        // Fused bbox reflects scale ×2 + translate (+65, +2, +3).
        assert!(dir.fused_bbox_min[0] >= 64.9 && dir.fused_bbox_max[0] <= 67.1);
    }

    #[test]
    fn env_directory_slots_backface_and_light_stream() {
        let mut vertices = HashMap::new();
        vertices.insert(0, v(0.0, 0.0, 0.0, [0.0, 0.0, 0.0], &[(0.0, 0.0)]));
        vertices.insert(1, v(1.0, 0.0, 0.0, [0.0, 0.0, 0.0], &[(1.0, 0.0)]));
        vertices.insert(2, v(0.0, 1.0, 0.0, [0.0, 0.0, 0.0], &[(0.0, 1.0)]));
        let mut polygons = HashMap::new();
        polygons.insert(
            1,
            Polygon {
                num_pts: 3,
                stippling: 0,
                sides_type: 2,
                pos_surface: 3,
                neg_surface: 5,
                vertex_ids: vec![0, 1, 2],
                pos_uv_indices: vec![0, 0, 0],
                neg_uv_indices: vec![0, 0, 0],
            },
        );
        let cell = CellStruct {
            cell_struct_id: 0,
            vertex_array: CVertexArray { vertex_type: 1, vertices },
            polygons,
            portal_poly_ids: vec![],
            physics_polygons: HashMap::new(),
            cell_bsp: None,
            physics_bsp: None,
            drawing_bsp: None,
        };
        let env = Environment { id: 0x0D00_0001, cells: HashMap::from([(0u32, cell)]) };
        let payload = encode_env_directory(&env).expect("encode env");
        assert_eq!(payload, encode_env_directory(&env).unwrap());
        let dir = Hbg1EnvDir::parse(&payload).expect("parse env");
        assert_eq!(dir.entries.len(), 1);
        let mesh = dir.mesh_for(0).unwrap().expect("mesh");
        assert!(mesh.has_baked_light, "env blocks carry the zeroed light stream");
        let subs = mesh.subsets().unwrap();
        assert_eq!(subs.len(), 2);
        // Front subset: slot 3, doubleSided (env forces it), no backface flag.
        assert_eq!(subs[0].surface_ref, 3);
        assert_eq!(subs[0].flags, subset_flags::DOUBLE_SIDED);
        // Back subset: slot 5, backface flag, paired to slot 3.
        assert_eq!(subs[1].surface_ref, 5);
        assert!(subs[1].flags & subset_flags::ENV_BACKFACE != 0);
        assert_eq!(subs[1].pair_slot, 3);
        // Zero-filled baked-light stream present and sized 4×V. `baked_off`
        // is relative to the embedded mesh BLOCK, not the env payload.
        let block_off = dir.entries[0].1 as usize;
        let bo = block_off + mesh.baked_off().unwrap();
        assert!(payload[bo..bo + 4 * mesh.vertex_count].iter().all(|&x| x == 0));
    }

    #[test]
    fn geom_section_roundtrip() {
        let mut entries = std::collections::BTreeMap::new();
        entries.insert(0x0100_0001u32, vec![1u8, 2, 3]);
        entries.insert(0x0200_0002u32, vec![9u8; 7]);
        let sec = build_geom_section(&entries);
        assert_eq!(sec, build_geom_section(&entries));
        let rows = parse_geom_section(&sec).expect("parse");
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].0, 0x0100_0001);
        assert_eq!(rows[0].1, ENCODING_HBG1);
        assert_eq!(&sec[rows[0].2..rows[0].2 + rows[0].3], &[1, 2, 3]);
        assert_eq!(&sec[rows[1].2..rows[1].2 + rows[1].3], &[9u8; 7]);
        assert_eq!(rows[1].2 % 4, 0, "payloads 4-B aligned");
    }

    // -----------------------------------------------------------------
    // RELIEF-IN-BAKE
    // -----------------------------------------------------------------

    /// A 6 m cube with outward-wound faces: clears every `ModelGate` bar
    /// (bbox 6 m, median edge 6 m, area 216 m², 0 double-sided) and has 12
    /// convex 90° edges, so OP1 fires.
    fn big_box_gfx() -> GfxObj {
        let p: [[f32; 3]; 8] = [
            [0.0, 0.0, 0.0],
            [6.0, 0.0, 0.0],
            [6.0, 6.0, 0.0],
            [0.0, 6.0, 0.0],
            [0.0, 0.0, 6.0],
            [6.0, 0.0, 6.0],
            [6.0, 6.0, 6.0],
            [0.0, 6.0, 6.0],
        ];
        let mut vertices = HashMap::new();
        for (i, c) in p.iter().enumerate() {
            let d = [c[0] - 3.0, c[1] - 3.0, c[2] - 3.0];
            let l = (d[0] * d[0] + d[1] * d[1] + d[2] * d[2]).sqrt();
            vertices.insert(
                i as u16,
                v(
                    c[0],
                    c[1],
                    c[2],
                    [d[0] / l, d[1] / l, d[2] / l],
                    &[(c[0] / 6.0, c[1] / 6.0)],
                ),
            );
        }
        // Outward-wound quads; two materials so both surfaces are exercised.
        let faces: [([i16; 4], i16); 6] = [
            ([0, 3, 2, 1], 0), // z=0, outward -z
            ([4, 5, 6, 7], 0), // z=6, outward +z
            ([0, 1, 5, 4], 0), // y=0, outward -y
            ([1, 2, 6, 5], 1), // x=6, outward +x
            ([2, 3, 7, 6], 1), // y=6, outward +y
            ([3, 0, 4, 7], 1), // x=0, outward -x
        ];
        let mut polygons = HashMap::new();
        for (i, (ring, surf)) in faces.iter().enumerate() {
            polygons.insert(
                i as u16,
                Polygon {
                    num_pts: 4,
                    stippling: 0,
                    sides_type: 0, // Landblock — single-sided solid
                    pos_surface: *surf,
                    neg_surface: -1,
                    vertex_ids: ring.to_vec(),
                    pos_uv_indices: vec![0, 0, 0, 0],
                    neg_uv_indices: vec![],
                },
            );
        }
        GfxObj {
            id: 0x0100_0009,
            flags: holtburger_common::properties::GfxObjFlags::HAS_DRAWING,
            surfaces: vec![0x0800_0010, 0x0800_0020],
            vertex_array: CVertexArray { vertex_type: 1, vertices },
            physics_polygons: HashMap::new(),
            physics_bsp: None,
            sort_center: Vector3::zero(),
            polygons,
            drawing_bsp: Some(crate::physics::BspNode::Leaf(crate::physics::BspLeaf {
                index: 0,
                solid: 0,
                sphere: None,
                poly_ids: vec![],
            })),
            did_degrade: None,
        }
    }

    /// The invariant the consumer differ also asserts: relief is ADDITIVE.
    /// Same subset table (same surfaces, same flags, same order), every
    /// subset's base index prefix bit-identical, only appended triangles.
    fn assert_relief_is_additive(default: &[u8], variant: &[u8]) -> u32 {
        let d = Hbg1Mesh::parse(default).expect("default parses");
        let r = Hbg1Mesh::parse(variant).expect("variant parses");
        let ds = d.subsets().expect("default subsets");
        let rs = r.subsets().expect("variant subsets");
        assert_eq!(ds.len(), rs.len(), "relief must not add or drop subsets");
        let mut added = 0u32;
        for (a, b) in ds.iter().zip(rs.iter()) {
            assert_eq!(a.surface_ref, b.surface_ref, "subset material identity");
            assert_eq!(a.flags, b.flags, "subset flags");
            assert!(
                b.index_count >= a.index_count,
                "relief is additive per subset"
            );
            assert_eq!(
                (b.index_count - a.index_count) % 3,
                0,
                "added indices are whole triangles"
            );
            added += (b.index_count - a.index_count) / 3;
            for k in 0..a.index_count as usize {
                let dv = d.index(a.first_index as usize + k) as usize;
                let rv = r.index(b.first_index as usize + k) as usize;
                assert_eq!(d.position(dv), r.position(rv), "base position moved");
                assert_eq!(d.uv(dv), r.uv(rv), "base uv moved");
                assert_eq!(d.normal(dv), r.normal(rv), "base normal moved");
            }
        }
        added
    }

    #[test]
    fn relief_variant_appends_rails_and_never_moves_the_base() {
        let gfx = big_box_gfx();
        let default = encode_gfx_part(&gfx).expect("default encode");
        let variant =
            encode_gfx_part_relief(&gfx, &ReliefBake::default()).expect("relief encode");
        assert_ne!(default, variant, "the box must gain rails");
        let added = assert_relief_is_additive(&default, &variant);
        assert!(added > 0, "OP1 emitted no rail triangles on a 6 m cube");
        // Every rail triangle is 2 quads × 2 tris per railed edge, split over
        // the two parent faces — so the count is a multiple of 4.
        assert_eq!(added % 4, 0, "rails come in 4-triangle sets: {added}");
    }

    #[test]
    fn relief_encode_is_deterministic() {
        let gfx = big_box_gfx();
        let a = encode_gfx_part_relief(&gfx, &ReliefBake::default()).unwrap();
        let b = encode_gfx_part_relief(&gfx, &ReliefBake::default()).unwrap();
        assert_eq!(a, b, "re-encode must be byte-identical (D-02.6)");
    }

    #[test]
    fn relief_noop_profile_reproduces_the_default_bytes() {
        let gfx = big_box_gfx();
        let default = encode_gfx_part(&gfx).unwrap();
        // scale 0 = the A/B control arm: classification runs, nothing emits.
        let zero = encode_gfx_part_relief(&gfx, &ReliefBake::from_scale(0.0)).unwrap();
        assert_eq!(default, zero);
        // A level the bake cannot reproduce is a no-op, never a wrong answer.
        let leveled = ReliefBake { subdiv_level: 3, ..ReliefBake::default() };
        assert!(leveled.is_noop());
        assert_eq!(default, encode_gfx_part_relief(&gfx, &leveled).unwrap());
    }

    #[test]
    fn relief_gate_leaves_props_untouched() {
        // The quad fixture is a 1 m sheet — it must fail `ModelGate` (props,
        // items and creature parts never grow rails).
        let gfx = quad_gfx();
        let default = encode_gfx_part(&gfx).unwrap();
        let variant = encode_gfx_part_relief(&gfx, &ReliefBake::default()).unwrap();
        assert_eq!(default, variant, "a prop-scale model must be variant-free");
    }

    #[test]
    fn relief_variant_key_is_stable_and_config_sensitive() {
        let a = ReliefBake::default();
        let b = ReliefBake::from_scale(1.0);
        assert_eq!(a.variant_key(), b.variant_key());
        assert_ne!(a.variant_key(), ReliefBake::from_scale(0.5).variant_key());
    }
}
