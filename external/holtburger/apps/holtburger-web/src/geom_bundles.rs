//! T13 (ST3, `?geomBundles`) — HBG1 GeometryBundle assembly.
//!
//! SPEC §1.2 / pass 4 D-04.5 + S3: one bake unit → ONE JS-owned transferable
//! buffer + a small descriptor. The exports (`assemble_model_geometry`,
//! `assemble_envcell_geometry`) are SYNCHRONOUS over resident packs — GEOM
//! payloads ride the same packs as their records (pass 3 S1.4 residency), and
//! a missing payload marks the entry `missing` so the JS consumer falls back
//! to the runtime-decode path (encoding 0x0000 is the designed fallback state,
//! H-04.5) and counts it (`geomFallback`, S7).
//!
//! ## Bundle buffer layout (per mesh entry, all offsets 4-B aligned)
//!
//! `pos f32×3×V | normal f32×3×V | uv f32×2×V | [baked u8×3×V pad4 — env
//! cells only] | idx u16|u32×I pad4`
//!
//! DEVIATION from pass 4 S3's "offsets derived from the fixed S1 layout"
//! (recorded in the T13 report): the BUNDLE carries f32 normals and tight
//! u8×3 baked-light — the S1 snorm8/padded forms stay the WIRE format; the
//! assembly dequantizes so every consumer keeps today's attribute shapes
//! (`Float32Array` normals, tight `Uint8Array` light) with zero three.js
//! interop risk. Pool-owned quantized storage is the pass-7/ST9 revisit
//! (H-04.3).
//!
//! ## Fidelity notes (differ-pinned below)
//!
//! * 0x01 models and env cellstructs assemble BIT-IDENTICAL positions/uvs
//!   (payload bytes are the runtime's own f32s) and normals equal to
//!   `dequant(quant(runtime))` — the declared snorm8 quantization.
//! * 0x02 setups apply scale → rotate → translate with the SAME `quat_rotate`
//!   expansion the runtime uses ⇒ bit-identical positions; normals are
//!   `normalize(rotate(inv_scale(dequant(q))))` vs the runtime's
//!   `quant(normalize(rotate(inv_scale(authored))))` — equal to within one
//!   quantization step (shader-renormalized; E1 eye-gates the ON arm).
//! * env baked light runs the SAME `vertex_bake` port over the UNIQUE vertex
//!   streams (0.38× the de-indexed arithmetic, D-04.7); inputs differ from
//!   the runtime only by the normal quantization ⇒ per-channel deltas ≤ ~2.
//!
//! ## `?negFace` on model bundles (HBG1 v2 face marker, 2026-10-22)
//!
//! Until 2026-10-22 the model exports answered `missing` for EVERY model while
//! dat-parser-2 `?negFace` (default on since 10-19) was on: v1 payloads bake
//! the legacy reversed back tri unmarked and never bake NoPos polygons, so no
//! assembly could reproduce the runtime decode under the flag. That blocked
//! `?geomBundles` and with it the `?drawPools` chain (handoff
//! HANDOFF-gpu-resident-statics-2026-10-22 §5 F7(a)).
//!
//! A v2 PART payload (`hbg1::HBG1_VERSION_FACES`, module docs in
//! holtburger-dat `hbg1.rs`) marks the subsets that belong to ONE arm, and
//! [`FaceArm::drop_mask`] drops the other arm's subsets per part:
//!
//! | payload | `?negFace` on (default)                   | `?negFace=off`          |
//! |---------|-------------------------------------------|-------------------------|
//! | v1      | `missing` (runtime decode — today's rule) | all subsets (as before) |
//! | v2      | drop `MODEL_BACKFACE`                     | drop `NOPOS_SLOT0`      |
//!
//! plus: v2 + `?negFace` + `?perPolyCull=on` + `flags::NEG_FRONT_COPY` ⇒
//! `missing` (v2 carries no same-winding front-copy tris). A setup is
//! `missing` if ANY drawable part payload is (never a partially-filtered
//! building). After a drop the part's index ranges are re-packed and its
//! vertex stream COMPACTED to the vertices the kept subsets use, numbered by
//! first use (the encoder's own rule), so the bundle carries no orphan
//! back-face / NoPos vertices and its bbox matches that arm's geometry. The
//! descriptor counts the two `?negFace` misses (`faceUnmarked`,
//! `faceFrontCopy`) so the JS consumer can say WHY models fell back.
//!
//! Fidelity is the differ bar above (per-surface triangle multisets), now for
//! BOTH arms: `neg_face_v2_model_matches_runtime_on_both_arms` below, and for
//! a compacted multi-part setup through `transform_part`,
//! `neg_face_v2_setup_matches_runtime_on_both_arms` (2026-10-23).

#![allow(clippy::too_many_arguments)]

use holtburger_dat::ResourceSource;
use holtburger_dat::file_type::EnvCell;
use holtburger_dat::file_type::env_cell::surface_did_for_envcell_index;
use holtburger_dat::hbg1;

// ---------------------------------------------------------------------------
// Buffer writer
// ---------------------------------------------------------------------------

struct BundleWriter {
    buf: Vec<u8>,
}

impl BundleWriter {
    fn new() -> Self {
        BundleWriter { buf: Vec::new() }
    }
    fn align4(&mut self) {
        while self.buf.len() % 4 != 0 {
            self.buf.push(0);
        }
    }
    fn off(&self) -> usize {
        self.buf.len()
    }
    fn put_f32(&mut self, v: f32) {
        self.buf.extend_from_slice(&v.to_le_bytes());
    }
}

// ---------------------------------------------------------------------------
// `?negFace` arm (HBG1 v2 face marker — module docs)
// ---------------------------------------------------------------------------

/// The dat-parser-2 `?negFace` arm one model assembly serves. Read once per
/// batch from the same gates the runtime triangulator reads (lib.rs
/// `neg_face_retail_enabled` / `neg_face_per_poly_cull_enabled`; native tests
/// drive them with `set_neg_face_for_test`).
#[derive(Clone, Copy, Debug)]
struct FaceArm {
    /// `?negFace` on (the default): no reversed back tri, textured NoPos
    /// polygons drawn with UV slot 0.
    retail: bool,
    /// `?perPolyCull=on` — only matters together with `retail` (front copy).
    per_poly_cull: bool,
}

/// Why a model came back `missing` (descriptor census).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Miss {
    /// No resident GEOM payload for the model or one of its parts.
    NoPayload,
    /// `?negFace` on and a v1 (pre-marker) part payload: the dist predates
    /// HBG1 v2 — rebake GEOM.
    Unmarked,
    /// `?negFace` + `?perPolyCull=on` and a v2 part flagged
    /// `NEG_FRONT_COPY`: v2 carries no same-winding front-copy tris.
    FrontCopy,
}

impl FaceArm {
    fn current() -> Self {
        FaceArm {
            retail: crate::neg_face_retail_enabled(),
            per_poly_cull: crate::neg_face_per_poly_cull_enabled(),
        }
    }

    /// The subset-flag bits this arm DROPS from one kind-0 PART payload, or
    /// the reason the payload cannot serve this arm at all.
    fn drop_mask(self, mesh: &hbg1::Hbg1Mesh<'_>) -> Result<u8, Miss> {
        if !mesh.face_marked() {
            // v1: exact for the legacy arm only (back faces unmarked, NoPos
            // absent) — the pre-2026-10-22 rule, now per payload.
            return if self.retail { Err(Miss::Unmarked) } else { Ok(0) };
        }
        if !self.retail {
            return Ok(hbg1::subset_flags::NOPOS_SLOT0);
        }
        if self.per_poly_cull && mesh.header.flags & hbg1::flags::NEG_FRONT_COPY != 0 {
            return Err(Miss::FrontCopy);
        }
        Ok(hbg1::subset_flags::MODEL_BACKFACE)
    }
}

// ---------------------------------------------------------------------------
// Model assembly (kind 0 direct + kind 1 fused/per-part)
// ---------------------------------------------------------------------------

/// Assemble one batch of model ids into (buffer, descriptor). `geom` resolves
/// a model id to its HBG1 payload bytes (PackSource in the live path; the
/// encoder directly in tests). The `?negFace` arm is read once per batch
/// ([`FaceArm`]).
pub(crate) fn assemble_models(
    geom: &mut dyn FnMut(u32) -> Option<Vec<u8>>,
    model_ids: &[u32],
) -> Result<(Vec<u8>, serde_json::Value), String> {
    let arm = FaceArm::current();
    let mut w = BundleWriter::new();
    let mut models = Vec::with_capacity(model_ids.len());
    let mut assembled = 0u32;
    let mut missing = 0u32;
    let mut face_unmarked = 0u32;
    let mut face_front_copy = 0u32;
    for &id in model_ids {
        match assemble_one_model(&mut w, geom, id, arm) {
            Ok(Ok(entry)) => {
                assembled += 1;
                models.push(entry);
            }
            Ok(Err(miss)) => {
                missing += 1;
                match miss {
                    Miss::Unmarked => face_unmarked += 1,
                    Miss::FrontCopy => face_front_copy += 1,
                    Miss::NoPayload => {}
                }
                models.push(serde_json::json!({ "id": id, "missing": true }));
            }
            Err(e) => return Err(format!("assemble 0x{id:08X}: {e}")),
        }
    }
    let descriptor = serde_json::json!({
        "models": models,
        "assembled": assembled,
        "missing": missing,
        "bytes": w.buf.len(),
        // `?negFace` census (2026-10-22): which arm this batch served, and
        // how many of `missing` were face-marker misses rather than absent
        // payloads. Additive fields; older consumers ignore them.
        "negFaceRetail": arm.retail,
        "faceUnmarked": face_unmarked,
        "faceFrontCopy": face_front_copy,
    });
    Ok((w.buf, descriptor))
}

struct PartOut {
    part_index: usize,
    hinge: [f32; 7],
    vtx_base: u32,
    vtx_count: u32,
    idx_first: u32,
    idx_count: u32,
    subsets: Vec<(u32, u8, u32, u32)>, // (surface_ref, flags, first_index, index_count)
}

/// `Ok(Ok(entry))` = assembled; `Ok(Err(miss))` = `missing` (the JS consumer
/// takes the counted runtime-decode fallback); `Err` = malformed payload
/// (fails the batch, as before). Nothing is written to `w` before the last
/// `Miss` check, so a miss never leaves bytes behind.
fn assemble_one_model(
    w: &mut BundleWriter,
    geom: &mut dyn FnMut(u32) -> Option<Vec<u8>>,
    id: u32,
    arm: FaceArm,
) -> Result<Result<serde_json::Value, Miss>, String> {
    match (id >> 24) as u8 {
        0x01 => {
            let Some(payload) = geom(id) else { return Ok(Err(Miss::NoPayload)) };
            let mesh = hbg1::Hbg1Mesh::parse(&payload)?;
            let drop_mask = match arm.drop_mask(&mesh) {
                Ok(m) => m,
                Err(miss) => return Ok(Err(miss)),
            };
            let parts = vec![collect_part_source(&mesh, 0, drop_mask)?];
            Ok(Ok(write_model_entry(
                w,
                id,
                mesh.did_degrade,
                parts,
            )))
        }
        0x02 => {
            let Some(dir_payload) = geom(id) else { return Ok(Err(Miss::NoPayload)) };
            let dir = hbg1::parse_setup(&dir_payload)?;
            // Resolve every drawable part's payload FIRST — any missing 0x01
            // part payload downgrades the whole model to the runtime decode
            // (never a silently partial building). `?negFace`: one part that
            // cannot serve this arm downgrades the whole setup the same way,
            // and is caught AS IT ARRIVES (2026-10-23, review hbg1v2-2): on a
            // v1 dist under the default arm the first part answers
            // `Unmarked`, so the rest of the building's part payloads are
            // never copied out of the pack (before HBG1 v2 that arm read
            // nothing at all). Census only: a later part's `NoPayload` now
            // reads as the earlier part's face miss — `missing` either way
            // (and a malformed part fails the batch at its own fetch).
            let mut part_payloads: Vec<Option<(Vec<u8>, u8)>> =
                Vec::with_capacity(dir.parts.len());
            for row in &dir.parts {
                if (row.part_did >> 24) as u8 == 0x01 {
                    let Some(p) = geom(row.part_did) else {
                        return Ok(Err(Miss::NoPayload));
                    };
                    let drop_mask = match arm.drop_mask(&hbg1::Hbg1Mesh::parse(&p)?) {
                        Ok(m) => m,
                        Err(miss) => return Ok(Err(miss)),
                    };
                    part_payloads.push(Some((p, drop_mask)));
                } else {
                    // Non-0x01 part: the runtime walk skips it, slot preserved.
                    part_payloads.push(None);
                }
            }
            let mut parts: Vec<PartSource> = Vec::with_capacity(dir.parts.len());
            for (pi, (row, payload)) in
                dir.parts.iter().zip(part_payloads.iter()).enumerate()
            {
                match payload {
                    Some((p, drop_mask)) => {
                        let mesh = hbg1::Hbg1Mesh::parse(p)?;
                        let mut src = collect_part_source(&mesh, pi, *drop_mask)?;
                        transform_part(&mut src, row);
                        src.hinge = [
                            row.hinge_pos[0],
                            row.hinge_pos[1],
                            row.hinge_pos[2],
                            row.hinge_quat[0],
                            row.hinge_quat[1],
                            row.hinge_quat[2],
                            row.hinge_quat[3],
                        ];
                        parts.push(src);
                    }
                    None => parts.push(PartSource::empty(pi)),
                }
            }
            Ok(Ok(write_model_entry(w, id, dir.did_degrade, parts)))
        }
        // 0x0D goes through assemble_envcells; others: fallback.
        _ => Ok(Err(Miss::NoPayload)),
    }
}

/// One part's assembled vertex/index/subset data before serialization.
struct PartSource {
    part_index: usize,
    hinge: [f32; 7],
    pos: Vec<f32>,     // 3 × V
    normal: Vec<f32>,  // 3 × V (dequantized)
    uv: Vec<f32>,      // 2 × V
    indices: Vec<u32>, // part-local
    subsets: Vec<(u32, u8, u32, u32)>,
}

impl PartSource {
    fn empty(part_index: usize) -> Self {
        PartSource {
            part_index,
            hinge: [0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0],
            pos: Vec::new(),
            normal: Vec::new(),
            uv: Vec::new(),
            indices: Vec::new(),
            subsets: Vec::new(),
        }
    }
}

/// One part's streams + subsets, minus every subset whose flags meet
/// `drop_mask` (the [`FaceArm::drop_mask`] answer; 0 = keep everything).
///
/// Nothing dropped (every v1 payload on the legacy arm, and any v2 payload
/// with nothing of the other arm in it): the payload is copied verbatim —
/// the pre-2026-10-22 assembly exactly. Something dropped: the kept subsets'
/// index ranges are re-packed contiguously IN PAYLOAD ORDER and the vertex
/// stream is compacted to the vertices they reference, numbered by first use
/// — the encoder's own numbering rule, so the part equals what a bake that
/// never emitted the dropped faces would hold (modulo the subset partition).
fn collect_part_source(
    mesh: &hbg1::Hbg1Mesh<'_>,
    part_index: usize,
    drop_mask: u8,
) -> Result<PartSource, String> {
    let all_subsets = mesh.subsets().unwrap_or_default();
    if drop_mask == 0 || !all_subsets.iter().any(|s| s.flags & drop_mask != 0) {
        let v = mesh.vertex_count;
        let mut pos = Vec::with_capacity(v * 3);
        let mut normal = Vec::with_capacity(v * 3);
        let mut uv = Vec::with_capacity(v * 2);
        for i in 0..v {
            let p = mesh.position(i);
            pos.extend_from_slice(&p);
            let n = mesh.normal(i);
            normal.extend_from_slice(&n);
            let t = mesh.uv(i);
            uv.extend_from_slice(&t);
        }
        let indices: Vec<u32> = (0..mesh.index_count).map(|i| mesh.index(i)).collect();
        let subsets = all_subsets
            .into_iter()
            .map(|s| (s.surface_ref, s.flags, s.first_index, s.index_count))
            .collect();
        return Ok(PartSource {
            part_index,
            hinge: [0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0],
            pos,
            normal,
            uv,
            indices,
            subsets,
        });
    }

    // Filtered + compacted.
    let mut remap: Vec<u32> = vec![u32::MAX; mesh.vertex_count];
    let mut order: Vec<usize> = Vec::new(); // new vertex number -> source vertex
    let mut indices: Vec<u32> = Vec::new();
    let mut subsets: Vec<(u32, u8, u32, u32)> = Vec::new();
    for s in all_subsets.iter().filter(|s| s.flags & drop_mask == 0) {
        let (first, count) = (s.first_index as usize, s.index_count as usize);
        if first + count > mesh.index_count {
            return Err(format!(
                "HBG1: subset range {first}+{count} exceeds {} indices",
                mesh.index_count
            ));
        }
        let new_first = indices.len() as u32;
        for k in 0..count {
            let src = mesh.index(first + k) as usize;
            let Some(slot) = remap.get_mut(src) else {
                return Err(format!(
                    "HBG1: index {src} out of range for {} vertices",
                    mesh.vertex_count
                ));
            };
            if *slot == u32::MAX {
                *slot = order.len() as u32;
                order.push(src);
            }
            indices.push(*slot);
        }
        subsets.push((s.surface_ref, s.flags, new_first, s.index_count));
    }
    let mut pos = Vec::with_capacity(order.len() * 3);
    let mut normal = Vec::with_capacity(order.len() * 3);
    let mut uv = Vec::with_capacity(order.len() * 2);
    for &i in &order {
        pos.extend_from_slice(&mesh.position(i));
        normal.extend_from_slice(&mesh.normal(i));
        uv.extend_from_slice(&mesh.uv(i));
    }
    Ok(PartSource {
        part_index,
        hinge: [0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0],
        pos,
        normal,
        uv,
        indices,
        subsets,
    })
}

/// Apply the setup part frame: `quat_rotate(rot, pos * scale) + offset` — the
/// runtime's exact operation order (`walk_setup_parts` scale pre-rotation,
/// `append_gfx_tris_with_tex_swaps` transform). Normals: inverse-scale →
/// rotate → normalize (the inverse-transpose rule for a diagonal scale, same
/// as the runtime's per-vertex handling).
fn transform_part(src: &mut PartSource, row: &hbg1::SetupPartRow) {
    let scale = row.scale;
    let non_unit = scale[0] != 1.0 || scale[1] != 1.0 || scale[2] != 1.0;
    let q = row.frame_quat;
    let identity_q = q == [1.0, 0.0, 0.0, 0.0];
    let t = row.frame_pos;
    for i in 0..src.pos.len() / 3 {
        let b = i * 3;
        let mut p = [src.pos[b], src.pos[b + 1], src.pos[b + 2]];
        if non_unit {
            p = [p[0] * scale[0], p[1] * scale[1], p[2] * scale[2]];
        }
        if !identity_q {
            p = hbg1::quat_rotate(q, p);
        }
        src.pos[b] = p[0] + t[0];
        src.pos[b + 1] = p[1] + t[1];
        src.pos[b + 2] = p[2] + t[2];

        let mut n = [src.normal[b], src.normal[b + 1], src.normal[b + 2]];
        if non_unit {
            if scale[0] != 0.0 {
                n[0] /= scale[0];
            }
            if scale[1] != 0.0 {
                n[1] /= scale[1];
            }
            if scale[2] != 0.0 {
                n[2] /= scale[2];
            }
        }
        if !identity_q {
            n = hbg1::quat_rotate(q, n);
        }
        if non_unit || !identity_q {
            let len2 = n[0] * n[0] + n[1] * n[1] + n[2] * n[2];
            if len2 > 1e-12 {
                let inv = 1.0 / len2.sqrt();
                n = [n[0] * inv, n[1] * inv, n[2] * inv];
            }
        }
        src.normal[b] = n[0];
        src.normal[b + 1] = n[1];
        src.normal[b + 2] = n[2];
    }
}

/// Serialize a model's parts into the bundle buffer: one contiguous vertex
/// region (parts in order), one index region (part indices rebased to
/// model-wide vertex numbers). Returns the descriptor entry.
fn write_model_entry(
    w: &mut BundleWriter,
    id: u32,
    did_degrade: u32,
    parts: Vec<PartSource>,
) -> serde_json::Value {
    let total_v: usize = parts.iter().map(|p| p.pos.len() / 3).sum();
    let total_i: usize = parts.iter().map(|p| p.indices.len()).sum();
    let idx_width: usize = if total_v > u16::MAX as usize { 4 } else { 2 };

    let mut bbox_min = [f32::INFINITY; 3];
    let mut bbox_max = [f32::NEG_INFINITY; 3];

    // pos
    w.align4();
    let pos_off = w.off();
    for p in &parts {
        for (k, &v) in p.pos.iter().enumerate() {
            w.put_f32(v);
            let c = k % 3;
            if v < bbox_min[c] {
                bbox_min[c] = v;
            }
            if v > bbox_max[c] {
                bbox_max[c] = v;
            }
        }
    }
    if !bbox_min[0].is_finite() {
        bbox_min = [0.0; 3];
        bbox_max = [0.0; 3];
    }
    // normal
    for p in &parts {
        for &v in &p.normal {
            w.put_f32(v);
        }
    }
    // uv
    for p in &parts {
        for &v in &p.uv {
            w.put_f32(v);
        }
    }
    // indices (model-wide rebase)
    let idx_off = w.off();
    let mut vtx_base = 0u32;
    for p in &parts {
        for &i in &p.indices {
            let g = i + vtx_base;
            if idx_width == 2 {
                w.buf.extend_from_slice(&(g as u16).to_le_bytes());
            } else {
                w.buf.extend_from_slice(&g.to_le_bytes());
            }
        }
        vtx_base += (p.pos.len() / 3) as u32;
    }
    w.align4();

    // Descriptor parts + fused subset union.
    let mut part_entries = Vec::with_capacity(parts.len());
    let mut fused_subsets = Vec::new();
    let mut out_parts: Vec<PartOut> = Vec::with_capacity(parts.len());
    {
        let mut vb = 0u32;
        let mut ib = 0u32;
        for p in &parts {
            let vc = (p.pos.len() / 3) as u32;
            let ic = p.indices.len() as u32;
            let subsets: Vec<(u32, u8, u32, u32)> = p
                .subsets
                .iter()
                .map(|&(sref, flags, first, count)| (sref, flags, first + ib, count))
                .collect();
            fused_subsets.extend(subsets.iter().copied());
            out_parts.push(PartOut {
                part_index: p.part_index,
                hinge: p.hinge,
                vtx_base: vb,
                vtx_count: vc,
                idx_first: ib,
                idx_count: ic,
                subsets,
            });
            vb += vc;
            ib += ic;
        }
    }
    for p in &out_parts {
        part_entries.push(serde_json::json!({
            "partIndex": p.part_index,
            "hinge": p.hinge,
            "vtxBase": p.vtx_base,
            "vtxCount": p.vtx_count,
            "idxFirst": p.idx_first,
            "idxCount": p.idx_count,
            "subsets": p
                .subsets
                .iter()
                .map(|&(sref, flags, first, count)| {
                    serde_json::json!({
                        "surfaceRef": sref,
                        "flags": flags,
                        "firstIndex": first,
                        "indexCount": count,
                    })
                })
                .collect::<Vec<_>>(),
        }));
    }

    serde_json::json!({
        "id": id,
        "didDegrade": did_degrade,
        "bbox": [bbox_min[0], bbox_min[1], bbox_min[2], bbox_max[0], bbox_max[1], bbox_max[2]],
        "vtx": { "off": pos_off, "count": total_v },
        "idx": { "off": idx_off, "count": total_i, "width": idx_width },
        "parts": part_entries,
        "fused": {
            "subsets": fused_subsets
                .iter()
                .map(|&(sref, flags, first, count)| {
                    serde_json::json!({
                        "surfaceRef": sref,
                        "flags": flags,
                        "firstIndex": first,
                        "indexCount": count,
                    })
                })
                .collect::<Vec<_>>(),
        },
    })
}

// ---------------------------------------------------------------------------
// EnvCell assembly (kind 2)
// ---------------------------------------------------------------------------

/// Assemble the requested cells of one landblock. `source` provides SYNC
/// record reads (EnvCell records + stab Setup light tables — resident by the
/// time the caller runs, pass 3 S1.4); `geom` resolves 0x0D env directory
/// payloads. Positions stay CELL-LOCAL (the JS consumer applies the cell
/// frame exactly as today); the per-cell slot→DID remap + back-face DID
/// comparison + vertex light bake run here (pass 4 D-04.7).
pub(crate) fn assemble_envcells<S: ResourceSource + ?Sized>(
    source: &S,
    geom: &mut dyn FnMut(u32) -> Option<Vec<u8>>,
    landblock_id: u32,
    cell_ids: &[u32],
) -> Result<(Vec<u8>, serde_json::Value), String> {
    use holtburger_dat::ResourceKey;
    let lb_high = landblock_id & 0xFFFF_0000;

    // Parse the requested cells' records (a miss marks that cell `missing`).
    let mut cells_parsed: Vec<Option<EnvCell>> = Vec::with_capacity(cell_ids.len());
    for &cid in cell_ids {
        let rec = source
            .get_file_by_key(ResourceKey::new("eor/cell", cid))
            .ok()
            .and_then(|b| EnvCell::unpack(&mut std::io::Cursor::new(&b)).ok());
        cells_parsed.push(rec);
    }

    // Light pool inputs: the requested cells plus any visible cells not in
    // the request (same-LB by construction; the runtime builds its map over
    // every fetched cell of the LB — callers pass all of them, this union is
    // the defensive completion).
    let mut light_cells: Vec<EnvCell> = cells_parsed.iter().flatten().cloned().collect();
    {
        let have: std::collections::HashSet<u16> =
            light_cells.iter().map(|c| (c.cell_id & 0xFFFF) as u16).collect();
        let mut want: Vec<u16> = Vec::new();
        for c in &light_cells {
            for &vis in &c.visible_cells {
                if !have.contains(&vis) && !want.contains(&vis) {
                    want.push(vis);
                }
            }
        }
        for vis in want {
            let fid = lb_high | vis as u32;
            if let Ok(b) = source.get_file_by_key(ResourceKey::new("eor/cell", fid))
                && let Ok(ec) = EnvCell::unpack(&mut std::io::Cursor::new(&b))
            {
                light_cells.push(ec);
            }
        }
    }
    let bake_lights_by_cell = crate::collect_landblock_bake_lights(source, &light_cells);

    let mut w = BundleWriter::new();
    let mut out_cells = Vec::with_capacity(cell_ids.len());
    let mut assembled = 0u32;
    let mut missing = 0u32;
    let mut env_payload_memo: std::collections::HashMap<u32, Option<Vec<u8>>> =
        std::collections::HashMap::new();
    let neg_face_retail = crate::neg_face_retail_enabled();

    for (i, &cid) in cell_ids.iter().enumerate() {
        let Some(envcell) = &cells_parsed[i] else {
            missing += 1;
            out_cells.push(serde_json::json!({ "cellId": cid, "missing": true }));
            continue;
        };
        let env_did = 0x0D00_0000 | envcell.environment_id as u32;
        let payload = env_payload_memo
            .entry(env_did)
            .or_insert_with(|| geom(env_did))
            .clone();
        let Some(payload) = payload else {
            missing += 1;
            out_cells.push(serde_json::json!({ "cellId": cid, "missing": true }));
            continue;
        };
        let dir = hbg1::Hbg1EnvDir::parse(&payload)?;
        let Some(mesh) = dir.mesh_for(envcell.cell_structure as u32) else {
            missing += 1;
            out_cells.push(serde_json::json!({ "cellId": cid, "missing": true }));
            continue;
        };
        let mesh = mesh?;

        // Slot → DID resolution + back-face subset drop (module docs; the
        // runtime's per-cell `emit_back_face` DID comparison, deferred to
        // load by the bake).
        let surfaces: Vec<u32> = envcell
            .surfaces
            .iter()
            .copied()
            .map(surface_did_for_envcell_index)
            .collect();
        let resolve = |slot: u32| -> u32 {
            if slot == hbg1::ENV_SLOT_NONE || slot as usize >= surfaces.len() {
                0
            } else {
                surfaces[slot as usize]
            }
        };
        let mut subsets_out: Vec<(u32, u8, u32, u32)> = Vec::new();
        for s in mesh.subsets()? {
            let did = resolve(s.surface_ref);
            if s.flags & hbg1::subset_flags::ENV_BACKFACE != 0 {
                // dat-parser-2 `?negFace=retail`: the reversed back face has
                // no retail counterpart; `append_environment_tris` drops it
                // under the same flag.
                if neg_face_retail {
                    continue;
                }
                let pos_did = resolve(if s.pair_slot == u16::MAX {
                    hbg1::ENV_SLOT_NONE
                } else {
                    s.pair_slot as u32
                });
                if did == 0 || did == pos_did {
                    continue; // the runtime would not have emitted this side
                }
            }
            subsets_out.push((did, s.flags, s.first_index, s.index_count));
        }

        // Streams.
        let v = mesh.vertex_count;
        w.align4();
        let pos_off = w.off();
        let mut positions = Vec::with_capacity(v * 3);
        let mut normals = Vec::with_capacity(v * 3);
        for vi in 0..v {
            let p = mesh.position(vi);
            positions.extend_from_slice(&p);
            let n = mesh.normal(vi);
            normals.extend_from_slice(&n);
        }
        for &p in &positions {
            w.put_f32(p);
        }
        for &n in &normals {
            w.put_f32(n);
        }
        for vi in 0..v {
            let t = mesh.uv(vi);
            w.put_f32(t[0]);
            w.put_f32(t[1]);
        }

        // Vertex light bake over the UNIQUE vertex streams (D-04.7): own +
        // visible cells' lights, converted to the cell frame, retail cap.
        let own_index = (envcell.cell_id & 0xFFFF) as u16;
        let mut sources: Vec<u16> = Vec::with_capacity(1 + envcell.visible_cells.len());
        sources.push(own_index);
        for &vis in &envcell.visible_cells {
            if vis != own_index && !sources.contains(&vis) {
                sources.push(vis);
            }
        }
        let mut candidates: Vec<crate::vertex_bake::PlacedLight> = Vec::new();
        for src_idx in &sources {
            if let Some(list) = bake_lights_by_cell.get(src_idx) {
                candidates.extend_from_slice(list);
            }
        }
        let cell_q = [
            envcell.position.orientation.w,
            envcell.position.orientation.x,
            envcell.position.orientation.y,
            envcell.position.orientation.z,
        ];
        let cell_origin = [
            envcell.position.origin.x,
            envcell.position.origin.y,
            envcell.position.origin.z,
        ];
        let pool = crate::vertex_bake::select_cell_pool(
            cell_origin,
            cell_q,
            &candidates,
            mesh.bbox_min,
            mesh.bbox_max,
        );
        if pool.dropped_by_cap > 0 {
            // No silent caps (the RND-04 rule). `log` is a wasm32-only dep
            // of this crate; the native test arm prints to stderr.
            #[cfg(target_arch = "wasm32")]
            log::warn!(
                "[geomBundles] cell 0x{cid:08X}: {} reaching static lights dropped by \
                 Render::max_static_lights",
                pool.dropped_by_cap
            );
            #[cfg(not(target_arch = "wasm32"))]
            eprintln!(
                "[geomBundles] cell 0x{cid:08X}: {} reaching static lights dropped by cap",
                pool.dropped_by_cap
            );
        }
        let baked =
            crate::vertex_bake::bake_vertex_colors(&positions, &normals, &pool.lights);
        let baked_off = w.off();
        w.buf.extend_from_slice(&baked);
        w.align4();

        // Indices (verbatim, cell meshes are self-indexed).
        let idx_off = w.off();
        let width = if mesh.idx_u32 { 4usize } else { 2usize };
        for ii in 0..mesh.index_count {
            let g = mesh.index(ii);
            if width == 2 {
                w.buf.extend_from_slice(&(g as u16).to_le_bytes());
            } else {
                w.buf.extend_from_slice(&g.to_le_bytes());
            }
        }
        w.align4();

        assembled += 1;
        out_cells.push(serde_json::json!({
            "cellId": cid,
            "vtx": { "off": pos_off, "count": v },
            "idx": { "off": idx_off, "count": mesh.index_count, "width": width },
            "baked": { "off": baked_off },
            "bbox": [
                mesh.bbox_min[0], mesh.bbox_min[1], mesh.bbox_min[2],
                mesh.bbox_max[0], mesh.bbox_max[1], mesh.bbox_max[2]
            ],
            "subsets": subsets_out
                .iter()
                .map(|&(did, flags, first, count)| {
                    serde_json::json!({
                        "surfaceDid": did,
                        "flags": flags,
                        "firstIndex": first,
                        "indexCount": count,
                    })
                })
                .collect::<Vec<_>>(),
        }));
    }

    let descriptor = serde_json::json!({
        "landblockId": landblock_id,
        "cells": out_cells,
        "assembled": assembled,
        "missing": missing,
        "bytes": w.buf.len(),
    });
    Ok((w.buf, descriptor))
}

// ---------------------------------------------------------------------------
// wasm exports
// ---------------------------------------------------------------------------

#[cfg(target_arch = "wasm32")]
mod exports {
    use wasm_bindgen::prelude::*;

    fn bundle_to_js(buffer: Vec<u8>, descriptor: serde_json::Value) -> JsValue {
        let obj = js_sys::Object::new();
        let arr = js_sys::Uint8Array::from(&buffer[..]);
        let _ = js_sys::Reflect::set(&obj, &JsValue::from_str("buffer"), &arr.into());
        let _ = js_sys::Reflect::set(
            &obj,
            &JsValue::from_str("descriptor"),
            &JsValue::from_str(&descriptor.to_string()),
        );
        obj.into()
    }

    /// `assemble_model_geometry(model_ids)` → `{buffer: Uint8Array,
    /// descriptor: string(JSON)}`. Sync over resident packs; models without
    /// a resident GEOM payload come back `missing` (JS runtime-decode
    /// fallback, counted).
    ///
    /// dat-parser-2 `?negFace` (default on since 2026-10-19): decided PER
    /// PAYLOAD since 2026-10-22 (module docs, `FaceArm`). A v2 (face-marked)
    /// payload assembles on both arms; a v1 payload — a dist baked before the
    /// marker — comes back `missing` while the flag is on (counted as
    /// `faceUnmarked` in the descriptor) and takes the runtime-decode
    /// fallback, which honours the flag. That v1 rule is the old blanket
    /// rule, so an old dist behaves exactly as before.
    #[wasm_bindgen]
    pub fn assemble_model_geometry(model_ids: &[u32]) -> Result<JsValue, JsValue> {
        let mut geom =
            |id: u32| -> Option<Vec<u8>> { crate::pack_source_glue::pack_geom_payload(id) };
        let (buffer, descriptor) = super::assemble_models(&mut geom, model_ids)
            .map_err(|e| JsValue::from_str(&e))?;
        Ok(bundle_to_js(buffer, descriptor))
    }

    /// RELIEF-IN-BAKE — `assemble_model_geometry_relief(model_ids)`: identical
    /// contract to [`assemble_model_geometry`], but each model is assembled
    /// from its baked RELIEF variant when the resident dist carries one,
    /// falling back to the relief-free default otherwise (that default IS the
    /// relief geometry for models the profile leaves alone).
    ///
    /// A separate export rather than a parameter on the existing one: the OFF
    /// arm's call site stays byte-identical, and a JS caller that never opts
    /// in cannot accidentally pass a truthy variant flag.
    #[wasm_bindgen]
    pub fn assemble_model_geometry_relief(model_ids: &[u32]) -> Result<JsValue, JsValue> {
        // `?negFace`: the same per-payload rule as `assemble_model_geometry`
        // (a v2 GEOMR row carries the same markers as its v2 GEOM row).
        let mut geom = |id: u32| -> Option<Vec<u8>> {
            crate::pack_source_glue::pack_geom_payload_relief(id)
        };
        let (buffer, descriptor) = super::assemble_models(&mut geom, model_ids)
            .map_err(|e| JsValue::from_str(&e))?;
        Ok(bundle_to_js(buffer, descriptor))
    }

    /// RELIEF-IN-BAKE diag: relief-variant rows in the resident packs. `0`
    /// means this dist was baked without `--geom-relief` — the arm arms but
    /// has nothing to serve, and every model reads its relief-free default.
    #[wasm_bindgen]
    pub fn geom_relief_rows_resident() -> usize {
        crate::pack_source_glue::pack_geom_relief_rows()
    }

    /// `assemble_envcell_geometry(landblock_id, cell_ids)` → same shape.
    /// Record reads go through the live composite source (pack-first, cached
    /// legacy fallback) — the caller runs AFTER `fetchEnvCellsInLandblock`
    /// so every input is resident.
    #[wasm_bindgen]
    pub fn assemble_envcell_geometry(
        landblock_id: u32,
        cell_ids: &[u32],
    ) -> Result<JsValue, JsValue> {
        let source = crate::global_source::try_global_source().ok_or_else(|| {
            JsValue::from_str("assemble_envcell_geometry: init_resource_source first")
        })?;
        let mut geom =
            |id: u32| -> Option<Vec<u8>> { crate::pack_source_glue::pack_geom_payload(id) };
        let (buffer, descriptor) =
            super::assemble_envcells(source.as_ref(), &mut geom, landblock_id, cell_ids)
                .map_err(|e| JsValue::from_str(&e))?;
        Ok(bundle_to_js(buffer, descriptor))
    }
}

// ---------------------------------------------------------------------------
// Differ tests (H-04.6(d): bundle geometry vs runtime-decoded geometry)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use holtburger_dat::{DatError, FileMetadata, ResourceKey};
    use std::collections::HashMap;

    struct FixtureSource(HashMap<(String, u32), Vec<u8>>);
    impl ResourceSource for FixtureSource {
        fn get_file_by_key(&self, key: ResourceKey<'_>) -> holtburger_dat::Result<Vec<u8>> {
            self.0
                .get(&(key.namespace.to_string(), key.file_id))
                .cloned()
                .ok_or(DatError::NotFound(key.file_id))
        }
        fn get_metadata_by_key(&self, _key: ResourceKey<'_>) -> Option<FileMetadata> {
            None
        }
        fn has_namespace(&self, _namespace: &str) -> bool {
            true
        }
    }

    /// One de-indexed corner for comparison: quantization-normalized.
    #[derive(PartialEq, Eq, PartialOrd, Ord, Debug, Clone)]
    struct Corner {
        pos: [u32; 3], // f32 bits
        uv: [u32; 2],
        qn: [i8; 3],
    }

    fn qn3(n: [f32; 3]) -> [i8; 3] {
        [
            hbg1::quant_snorm8(n[0]),
            hbg1::quant_snorm8(n[1]),
            hbg1::quant_snorm8(n[2]),
        ]
    }

    /// Expand runtime `Tri`s into per-(surfaceDid) corner-triangle multisets
    /// with quantized normals (the declared comparison form).
    fn runtime_groups(tris: &[crate::Tri]) -> HashMap<u32, Vec<[Corner; 3]>> {
        let mut m: HashMap<u32, Vec<[Corner; 3]>> = HashMap::new();
        for t in tris {
            let mut tri: Vec<Corner> = Vec::with_capacity(3);
            for v in 0..3 {
                tri.push(Corner {
                    pos: [
                        t.pos[v][0].to_bits(),
                        t.pos[v][1].to_bits(),
                        t.pos[v][2].to_bits(),
                    ],
                    uv: [t.uv[v][0].to_bits(), t.uv[v][1].to_bits()],
                    qn: qn3(t.normals[v]),
                });
            }
            m.entry(t.surface_did).or_default().push([
                tri[0].clone(),
                tri[1].clone(),
                tri[2].clone(),
            ]);
        }
        m
    }

    /// Expand an assembled model-bundle entry into the same multiset form.
    fn bundle_groups(
        buffer: &[u8],
        entry: &serde_json::Value,
    ) -> HashMap<u32, Vec<[Corner; 3]>> {
        let vtx_off = entry["vtx"]["off"].as_u64().unwrap() as usize;
        let vtx_count = entry["vtx"]["count"].as_u64().unwrap() as usize;
        let idx_off = entry["idx"]["off"].as_u64().unwrap() as usize;
        let width = entry["idx"]["width"].as_u64().unwrap() as usize;
        let f32_at = |off: usize| -> f32 {
            f32::from_le_bytes(buffer[off..off + 4].try_into().unwrap())
        };
        let corner = |vi: usize| -> Corner {
            let p = vtx_off + vi * 12;
            let n = vtx_off + vtx_count * 12 + vi * 12;
            let t = vtx_off + vtx_count * 24 + vi * 8;
            Corner {
                pos: [
                    f32_at(p).to_bits(),
                    f32_at(p + 4).to_bits(),
                    f32_at(p + 8).to_bits(),
                ],
                uv: [f32_at(t).to_bits(), f32_at(t + 4).to_bits()],
                qn: qn3([f32_at(n), f32_at(n + 4), f32_at(n + 8)]),
            }
        };
        let index_at = |i: usize| -> usize {
            let o = idx_off + i * width;
            if width == 2 {
                u16::from_le_bytes(buffer[o..o + 2].try_into().unwrap()) as usize
            } else {
                u32::from_le_bytes(buffer[o..o + 4].try_into().unwrap()) as usize
            }
        };
        let mut m: HashMap<u32, Vec<[Corner; 3]>> = HashMap::new();
        for s in entry["fused"]["subsets"].as_array().unwrap() {
            let did = s["surfaceRef"].as_u64().unwrap() as u32;
            let first = s["firstIndex"].as_u64().unwrap() as usize;
            let count = s["indexCount"].as_u64().unwrap() as usize;
            for t in 0..count / 3 {
                let c0 = corner(index_at(first + t * 3));
                let c1 = corner(index_at(first + t * 3 + 1));
                let c2 = corner(index_at(first + t * 3 + 2));
                m.entry(did).or_default().push([c0, c1, c2]);
            }
        }
        m
    }

    fn assert_groups_equal(
        mut runtime: HashMap<u32, Vec<[Corner; 3]>>,
        mut bundle: HashMap<u32, Vec<[Corner; 3]>>,
        ctx: &str,
    ) {
        let mut r_keys: Vec<u32> = runtime.keys().copied().collect();
        let mut b_keys: Vec<u32> = bundle.keys().copied().collect();
        r_keys.sort_unstable();
        b_keys.sort_unstable();
        assert_eq!(r_keys, b_keys, "{ctx}: surface group sets differ");
        for k in r_keys {
            let mut r = runtime.remove(&k).unwrap();
            let mut b = bundle.remove(&k).unwrap();
            r.sort();
            b.sort();
            assert_eq!(r, b, "{ctx}: surface 0x{k:08X} triangle multiset differs");
        }
    }

    /// Fixture differ: HBG1-assembled 0x01 model == runtime triangulation
    /// (positions/uvs bit-exact, normals at the declared quantization).
    #[test]
    fn differ_gfx_model_matches_runtime_triangulation() {
        let gfx = hbg1_fixture_gfx();
        let mut bytes = Vec::new();
        gfx.pack(&mut std::io::Cursor::new(&mut bytes)).unwrap();
        let src = FixtureSource(HashMap::from([(
            ("eor/portal".to_string(), gfx.id),
            bytes,
        )]));

        // Runtime path.
        let tris = crate::triangulate_model(&src, gfx.id).expect("runtime triangulation");
        // Bundle path.
        let payload = hbg1::encode_gfx_part(&gfx).expect("encode");
        let mut geom = |id: u32| (id == gfx.id).then(|| payload.clone());
        let (buffer, descriptor) =
            assemble_models(&mut geom, &[gfx.id]).expect("assemble");
        let entry = &descriptor["models"][0];
        assert_eq!(entry["didDegrade"].as_u64().unwrap(), 0x1100_0001);
        assert_groups_equal(
            runtime_groups(&tris),
            bundle_groups(&buffer, entry),
            "gfx model",
        );
    }

    /// Fixture differ: setup with a placement frame + non-unit scale —
    /// positions bit-exact vs the runtime walk; normals within one
    /// quantization step (compared at 2/127 tolerance).
    #[test]
    fn differ_setup_matches_runtime_walk() {
        use holtburger_dat::file_type::SetupModel;
        let (setup, setup_bytes, gfx, gfx_bytes) = hbg1_fixture_setup();
        let src = FixtureSource(HashMap::from([
            (("eor/portal".to_string(), setup.id), setup_bytes),
            (("eor/portal".to_string(), gfx.id), gfx_bytes),
        ]));

        let tris = crate::triangulate_model(&src, setup.id).expect("runtime triangulation");
        assert!(!tris.is_empty());

        let setup_re = SetupModel::unpack(&mut std::io::Cursor::new(
            &src.0[&("eor/portal".to_string(), setup.id)],
        ))
        .unwrap();
        let dir_payload = hbg1::encode_setup_directory(&src, &setup_re).unwrap();
        let part_payload = hbg1::encode_gfx_part(&gfx).unwrap();
        let mut geom = |id: u32| -> Option<Vec<u8>> {
            if id == setup.id {
                Some(dir_payload.clone())
            } else if id == gfx.id {
                Some(part_payload.clone())
            } else {
                None
            }
        };
        let (buffer, descriptor) = assemble_models(&mut geom, &[setup.id]).unwrap();
        let entry = &descriptor["models"][0];

        // Positions bit-exact: compare position multisets per surface.
        let rt = runtime_groups(&tris);
        let bd = bundle_groups(&buffer, entry);
        let strip = |m: &HashMap<u32, Vec<[Corner; 3]>>| -> HashMap<u32, Vec<[[u32; 3]; 3]>> {
            m.iter()
                .map(|(k, v)| {
                    let mut tris: Vec<[[u32; 3]; 3]> = v
                        .iter()
                        .map(|t| [t[0].pos, t[1].pos, t[2].pos])
                        .collect();
                    tris.sort();
                    (*k, tris)
                })
                .collect()
        };
        assert_eq!(strip(&rt), strip(&bd), "setup positions must be bit-exact");
        // Normals within one quantization step.
        for (k, v) in &bd {
            let rv = &rt[k];
            let mut rq: Vec<[i8; 3]> = rv.iter().flat_map(|t| t.iter().map(|c| c.qn)).collect();
            let mut bq: Vec<[i8; 3]> = v.iter().flat_map(|t| t.iter().map(|c| c.qn)).collect();
            rq.sort_unstable();
            bq.sort_unstable();
            assert_eq!(rq.len(), bq.len());
            for (a, b) in rq.iter().zip(bq.iter()) {
                for c in 0..3 {
                    assert!(
                        (a[c] as i16 - b[c] as i16).abs() <= 2,
                        "setup normal drift > 2 quant steps: {a:?} vs {b:?}"
                    );
                }
            }
        }
        // Hinge row survives to the descriptor (buildings contract).
        let hinge = entry["parts"][0]["hinge"].as_array().unwrap();
        assert_eq!(hinge[0].as_f64().unwrap() as f32, 0.5);
    }

    /// Fixture differ: env cellstruct — assembled cell mesh matches
    /// `append_environment_tris` under the same surfaces list, including the
    /// per-cell back-face DID comparison, and the light bake runs over the
    /// unique verts.
    #[test]
    fn differ_envcell_matches_runtime_environment_path() {
        let env = hbg1_fixture_env();
        // Cell A: distinct pos/neg DIDs → back face kept.
        // Cell B: same DID both sides → back face dropped.
        let surfaces_a: Vec<u16> = vec![0x0010, 0x0020, 0x0030, 0x0040, 0x0050, 0x0060];
        let surfaces_b: Vec<u16> = vec![0x0010, 0x0020, 0x0030, 0x0010, 0x0050, 0x0010];
        for (label, surfaces_u16) in [("distinct", &surfaces_a), ("same", &surfaces_b)] {
            let surfaces: Vec<u32> = surfaces_u16
                .iter()
                .map(|&s| surface_did_for_envcell_index(s))
                .collect();
            let mut tris = Vec::new();
            crate::append_environment_tris(&mut tris, &env, &surfaces, 0);

            let payload = hbg1::encode_env_directory(&env).unwrap();
            let envcell = fixture_envcell(0x1234_0100, env.id, 0, surfaces_u16.clone());
            let mut cell_bytes = Vec::new();
            envcell.pack(&mut std::io::Cursor::new(&mut cell_bytes)).unwrap();
            let src = FixtureSource(HashMap::from([(
                ("eor/cell".to_string(), envcell.cell_id),
                cell_bytes,
            )]));
            let mut geom = |id: u32| (id == env.id).then(|| payload.clone());
            let (buffer, descriptor) =
                assemble_envcells(&src, &mut geom, 0x1234_0000, &[envcell.cell_id])
                    .unwrap();
            let cell = &descriptor["cells"][0];
            assert!(cell.get("missing").is_none(), "{label}: assembled");

            // Compare per-DID triangle multisets.
            let rt = runtime_groups(&tris);
            let mut bd: HashMap<u32, Vec<[Corner; 3]>> = HashMap::new();
            let vtx_off = cell["vtx"]["off"].as_u64().unwrap() as usize;
            let vtx_count = cell["vtx"]["count"].as_u64().unwrap() as usize;
            let idx_off = cell["idx"]["off"].as_u64().unwrap() as usize;
            let width = cell["idx"]["width"].as_u64().unwrap() as usize;
            let f32_at = |off: usize| -> f32 {
                f32::from_le_bytes(buffer[off..off + 4].try_into().unwrap())
            };
            let corner = |vi: usize| -> Corner {
                let p = vtx_off + vi * 12;
                let n = vtx_off + vtx_count * 12 + vi * 12;
                let t = vtx_off + vtx_count * 24 + vi * 8;
                Corner {
                    pos: [
                        f32_at(p).to_bits(),
                        f32_at(p + 4).to_bits(),
                        f32_at(p + 8).to_bits(),
                    ],
                    uv: [f32_at(t).to_bits(), f32_at(t + 4).to_bits()],
                    qn: qn3([f32_at(n), f32_at(n + 4), f32_at(n + 8)]),
                }
            };
            let index_at = |i: usize| -> usize {
                let o = idx_off + i * width;
                if width == 2 {
                    u16::from_le_bytes(buffer[o..o + 2].try_into().unwrap()) as usize
                } else {
                    u32::from_le_bytes(buffer[o..o + 4].try_into().unwrap()) as usize
                }
            };
            for s in cell["subsets"].as_array().unwrap() {
                let did = s["surfaceDid"].as_u64().unwrap() as u32;
                let first = s["firstIndex"].as_u64().unwrap() as usize;
                let count = s["indexCount"].as_u64().unwrap() as usize;
                for t in 0..count / 3 {
                    bd.entry(did).or_default().push([
                        corner(index_at(first + t * 3)),
                        corner(index_at(first + t * 3 + 1)),
                        corner(index_at(first + t * 3 + 2)),
                    ]);
                }
            }
            assert_groups_equal(rt, bd, &format!("envcell {label}"));
            // Baked-light stream present, sized 3×V (zeros — no lights in
            // the fixture; retail bakes black, emissive-add contributes 0).
            let baked_off = cell["baked"]["off"].as_u64().unwrap() as usize;
            assert!(
                buffer[baked_off..baked_off + vtx_count * 3].iter().all(|&b| b == 0),
                "no-light fixture bakes black"
            );
        }
    }

    /// dat-parser-2 `?negFace=retail`: the per-cell assembly drops every
    /// `ENV_BACKFACE` subset (kept by default for distinct pos/neg DIDs), and
    /// what remains matches `append_environment_tris` under the same flag.
    #[test]
    fn neg_face_retail_env_assembly_drops_backface_subsets() {
        struct FlagReset;
        impl Drop for FlagReset {
            fn drop(&mut self) {
                crate::set_neg_face_for_test(false, false);
            }
        }
        let _reset = FlagReset;
        let env = hbg1_fixture_env();
        // Distinct DIDs for the wall's pos slot 0 and neg slot 3.
        let surfaces_u16: Vec<u16> = vec![0x0010, 0x0020, 0x0030, 0x0040, 0x0050, 0x0060];
        let surfaces: Vec<u32> = surfaces_u16
            .iter()
            .map(|&s| surface_did_for_envcell_index(s))
            .collect();
        let payload = hbg1::encode_env_directory(&env).unwrap();
        let envcell = fixture_envcell(0x1234_0100, env.id, 0, surfaces_u16.clone());
        let mut cell_bytes = Vec::new();
        envcell.pack(&mut std::io::Cursor::new(&mut cell_bytes)).unwrap();
        let src = FixtureSource(HashMap::from([(
            ("eor/cell".to_string(), envcell.cell_id),
            cell_bytes,
        )]));
        // (subset rows, ENV_BACKFACE rows, triangles per surface DID).
        let assemble = |retail: bool| -> (usize, usize, HashMap<u32, usize>) {
            crate::set_neg_face_for_test(retail, false);
            let mut geom = |id: u32| (id == env.id).then(|| payload.clone());
            let (_buffer, descriptor) =
                assemble_envcells(&src, &mut geom, 0x1234_0000, &[envcell.cell_id]).unwrap();
            let subs = descriptor["cells"][0]["subsets"].as_array().unwrap().clone();
            let back = subs
                .iter()
                .filter(|s| {
                    ((s["flags"].as_u64().unwrap() as u8) & hbg1::subset_flags::ENV_BACKFACE) != 0
                })
                .count();
            let mut per_did: HashMap<u32, usize> = HashMap::new();
            for s in &subs {
                *per_did.entry(s["surfaceDid"].as_u64().unwrap() as u32).or_insert(0) +=
                    s["indexCount"].as_u64().unwrap() as usize / 3;
            }
            (subs.len(), back, per_did)
        };

        let (rows_default, back_default, _) = assemble(false);
        assert_eq!(back_default, 1, "default keeps the distinct-DID back subset");
        let (rows_retail, back_retail, per_did_retail) = assemble(true);
        assert_eq!(back_retail, 0, "retail drops every ENV_BACKFACE subset");
        assert_eq!(rows_retail, rows_default - 1);

        // Runtime under the same flag: no reversed tri, same per-DID counts.
        crate::set_neg_face_for_test(true, false);
        let mut tris = Vec::new();
        crate::append_environment_tris(&mut tris, &env, &surfaces, 0);
        assert!(tris.iter().all(|t| t.side_kind == crate::SideKind::Positive));
        let mut rt: HashMap<u32, usize> = HashMap::new();
        for t in &tris {
            *rt.entry(t.surface_did).or_insert(0) += 1;
        }
        assert_eq!(rt, per_did_retail);
    }

    // ---- `?negFace` on model bundles (HBG1 v2 face marker, 2026-10-22) ----

    /// Surface DIDs private to these tests: `SURFACE_TYPE_BITS` is a
    /// process-wide cache every test thread shares (lib.rs's own `?negFace`
    /// tests use 0x08DA_xxxx).
    const NF_TEX_A: u32 = 0x08DB_0001;
    const NF_TEX_B: u32 = 0x08DB_0002;
    const NF_SOLID: u32 = 0x08DB_0003;

    /// A Surface record body (surface.rs): `type | (texture, palette) or
    /// colour | translucency | luminosity | diffuse`.
    fn nf_surface_bytes(textured: bool) -> Vec<u8> {
        let mut b = Vec::new();
        if textured {
            b.extend_from_slice(&0x2u32.to_le_bytes()); // Base1Image
            b.extend_from_slice(&0x0500_0001u32.to_le_bytes());
            b.extend_from_slice(&0u32.to_le_bytes());
        } else {
            b.extend_from_slice(&0x1u32.to_le_bytes()); // Base1Solid
            b.extend_from_slice(&0xFF80_8080u32.to_le_bytes());
        }
        for f in [0.0f32, 0.0, 1.0] {
            b.extend_from_slice(&f.to_le_bytes());
        }
        b
    }

    /// Every polygon class the two `?negFace` arms treat differently:
    /// pid 1 (only with `front_copy_candidate`): SidesType-2, pos slot 1 /
    ///        neg slot 0 — a legacy back face AND a front-copy candidate;
    /// pid 3: SidesType-2, pos 0 / neg 1 — a legacy back face only;
    /// pid 4: NoPos on the textured slot 1, over vertex 4 which no other
    ///        poly uses (drawn under `?negFace` only);
    /// pid 6: NoPos on the solid slot 2 (never drawn);
    /// pid 8: a double-sided quad on slot 0 (drawn on both arms).
    fn nf_gfx(id: u32, front_copy_candidate: bool) -> holtburger_dat::file_type::GfxObj {
        use holtburger_common::{Vector3, properties::GfxObjFlags};
        use holtburger_dat::graphics::{CVertexArray, Polygon, SWVertex, Vec2Duv};
        use holtburger_dat::physics::{BspLeaf, BspNode};
        let v = |x: f32, y: f32, z: f32, n: [f32; 3], uvs: &[(f32, f32)]| SWVertex {
            num_uvs: uvs.len() as u16,
            origin: Vector3 { x, y, z },
            normal: Vector3 { x: n[0], y: n[1], z: n[2] },
            uvs: uvs.iter().map(|&(u, vv)| Vec2Duv { u, v: vv }).collect(),
        };
        let mut vertices = HashMap::new();
        vertices.insert(0, v(0.0, 0.0, 0.0, [0.0, 0.0, 1.0], &[(0.0, 0.0), (0.9, 0.9)]));
        vertices.insert(1, v(1.0, 0.0, 0.0, [0.0, 0.0, 1.0], &[(1.0, 0.0), (0.8, 0.1)]));
        vertices.insert(2, v(1.0, 1.0, 0.25, [0.3, 0.1, 0.9], &[(1.0, 1.0), (0.2, 0.7)]));
        vertices.insert(3, v(0.0, 1.0, 0.0, [0.0, 0.0, 0.0], &[(0.0, 1.0)]));
        // Used by the textured NoPos poly ONLY, so the legacy arm's drop of
        // that subset is visible as a compacted vertex.
        vertices.insert(4, v(0.5, 0.5, 0.5, [0.0, 0.0, 1.0], &[(0.3, 0.3), (0.6, 0.6)]));
        let poly = |stippling: u8,
                    sides_type: i32,
                    pos_surface: i16,
                    neg_surface: i16,
                    vertex_ids: Vec<i16>,
                    pos_uv_indices: Vec<u8>,
                    neg_uv_indices: Vec<u8>| Polygon {
            num_pts: vertex_ids.len() as u8,
            stippling,
            sides_type,
            pos_surface,
            neg_surface,
            vertex_ids,
            pos_uv_indices,
            neg_uv_indices,
        };
        let mut polygons = HashMap::new();
        if front_copy_candidate {
            polygons.insert(1, poly(0, 2, 1, 0, vec![0, 1, 2], vec![0, 0, 0], vec![1, 1, 1]));
        }
        polygons.insert(3, poly(1, 2, 0, 1, vec![0, 2, 3], vec![0, 0, 0], vec![1, 1, 0]));
        polygons.insert(4, poly(0x4, 0, 1, -1, vec![0, 2, 4], vec![], vec![]));
        polygons.insert(6, poly(0x4, 0, 2, -1, vec![0, 1, 3], vec![], vec![]));
        polygons.insert(8, poly(0, 1, 0, -1, vec![0, 1, 2, 3], vec![0, 0, 0, 0], vec![]));
        holtburger_dat::file_type::GfxObj {
            id,
            flags: GfxObjFlags::HAS_DRAWING,
            surfaces: vec![NF_TEX_A, NF_TEX_B, NF_SOLID],
            vertex_array: CVertexArray { vertex_type: 1, vertices },
            physics_polygons: HashMap::new(),
            physics_bsp: None,
            sort_center: Vector3::zero(),
            polygons,
            drawing_bsp: Some(BspNode::Leaf(BspLeaf {
                index: 0,
                solid: 0,
                sphere: None,
                poly_ids: vec![],
            })),
            did_degrade: None,
        }
    }

    /// (source carrying the GfxObj + its three Surface records, the GfxObj
    /// as the runtime will read it back).
    fn nf_source(
        gfx: &holtburger_dat::file_type::GfxObj,
    ) -> (FixtureSource, holtburger_dat::file_type::GfxObj) {
        let mut bytes = Vec::new();
        gfx.pack(&mut std::io::Cursor::new(&mut bytes)).unwrap();
        let re = holtburger_dat::file_type::GfxObj::unpack(&mut std::io::Cursor::new(&bytes))
            .expect("fixture round-trips");
        let src = FixtureSource(HashMap::from([
            (("eor/portal".to_string(), gfx.id), bytes),
            (("eor/portal".to_string(), NF_TEX_A), nf_surface_bytes(true)),
            (("eor/portal".to_string(), NF_TEX_B), nf_surface_bytes(true)),
            (("eor/portal".to_string(), NF_SOLID), nf_surface_bytes(false)),
        ]));
        (src, re)
    }

    /// Restores this thread's `?negFace` gates however the test exits.
    struct NegFaceReset;
    impl Drop for NegFaceReset {
        fn drop(&mut self) {
            crate::set_neg_face_for_test(false, false);
        }
    }

    /// The tentpole differ: ONE v2 payload, assembled under each `?negFace`
    /// arm, equals the runtime triangulator under that same arm (per-surface
    /// triangle multisets, positions/uvs bit-exact, normals at the declared
    /// quantization) — and the assembly compacts away the other arm's
    /// vertices.
    #[test]
    fn neg_face_v2_model_matches_runtime_on_both_arms() {
        let _reset = NegFaceReset;
        let gfx = nf_gfx(0x0100_DB01, false);
        let (src, gfx_re) = nf_source(&gfx);
        let payload =
            hbg1::encode_gfx_part_faces(&gfx_re, &|d: u32| hbg1::read_surface_type(&src, d))
                .expect("v2 encode");
        let mesh = hbg1::Hbg1Mesh::parse(&payload).unwrap();
        assert!(mesh.face_marked());
        let subs = mesh.subsets().unwrap();
        assert!(subs.iter().any(|s| s.flags & hbg1::subset_flags::MODEL_BACKFACE != 0));
        assert!(subs.iter().any(|s| s.flags & hbg1::subset_flags::NOPOS_SLOT0 != 0));

        for retail in [false, true] {
            crate::set_neg_face_for_test(retail, false);
            // Uncached: the triangulation memo is keyed by model id only and
            // would hand the second arm the first arm's triangles.
            let (tris, _complete) =
                crate::triangulate_model_uncached(&src, gfx.id, &[], &[], None)
                    .expect("runtime triangulation");
            let mut geom = |q: u32| (q == gfx.id).then(|| payload.clone());
            let (buffer, descriptor) = assemble_models(&mut geom, &[gfx.id]).unwrap();
            assert_eq!(descriptor["negFaceRetail"].as_bool(), Some(retail));
            let entry = &descriptor["models"][0];
            assert!(entry.get("missing").is_none(), "retail={retail}: assembled");
            assert_groups_equal(
                runtime_groups(&tris),
                bundle_groups(&buffer, entry),
                &format!("negFace retail={retail}"),
            );
            // The other arm's subsets are gone, not just empty.
            let flags: Vec<u8> = entry["fused"]["subsets"]
                .as_array()
                .unwrap()
                .iter()
                .map(|s| s["flags"].as_u64().unwrap() as u8)
                .collect();
            let gone = if retail {
                hbg1::subset_flags::MODEL_BACKFACE
            } else {
                hbg1::subset_flags::NOPOS_SLOT0
            };
            assert!(flags.iter().all(|f| f & gone == 0), "retail={retail}: {flags:?}");
            // Compaction: every vertex the entry carries is referenced.
            let vcount = entry["vtx"]["count"].as_u64().unwrap() as usize;
            assert!(vcount < mesh.vertex_count, "retail={retail}: compacted {vcount}");
            let idx_off = entry["idx"]["off"].as_u64().unwrap() as usize;
            let width = entry["idx"]["width"].as_u64().unwrap() as usize;
            let icount = entry["idx"]["count"].as_u64().unwrap() as usize;
            let mut used = vec![false; vcount];
            for i in 0..icount {
                let o = idx_off + i * width;
                let ix = if width == 2 {
                    u16::from_le_bytes(buffer[o..o + 2].try_into().unwrap()) as usize
                } else {
                    u32::from_le_bytes(buffer[o..o + 4].try_into().unwrap()) as usize
                };
                assert!(ix < vcount, "index {ix} >= {vcount}");
                used[ix] = true;
            }
            assert!(used.iter().all(|&u| u), "retail={retail}: orphan vertex");
        }
    }

    /// An old (v1) dist keeps today's behaviour exactly: `?negFace` on ⇒
    /// `missing`, counted as `faceUnmarked` (a setup over a v1 part too);
    /// `?negFace=off` ⇒ assembled.
    #[test]
    fn neg_face_v1_payload_is_missing_under_retail_only() {
        let _reset = NegFaceReset;
        let gfx = nf_gfx(0x0100_DB02, false);
        let v1 = hbg1::encode_gfx_part(&gfx).unwrap();
        let mut geom = |q: u32| (q == gfx.id).then(|| v1.clone());
        crate::set_neg_face_for_test(true, false);
        let (_b, d) = assemble_models(&mut geom, &[gfx.id]).unwrap();
        assert_eq!(d["models"][0]["missing"].as_bool(), Some(true));
        assert_eq!(d["faceUnmarked"].as_u64(), Some(1));
        assert_eq!(d["faceFrontCopy"].as_u64(), Some(0));
        crate::set_neg_face_for_test(false, false);
        let (_b, d) = assemble_models(&mut geom, &[gfx.id]).unwrap();
        assert!(d["models"][0].get("missing").is_none());
        assert_eq!(d["faceUnmarked"].as_u64(), Some(0));

        // Setup over a v1 part: the whole setup falls back under retail.
        let (setup, setup_bytes, part, part_bytes) = hbg1_fixture_setup();
        let src = FixtureSource(HashMap::from([
            (("eor/portal".to_string(), setup.id), setup_bytes),
            (("eor/portal".to_string(), part.id), part_bytes),
        ]));
        let setup_re = holtburger_dat::file_type::SetupModel::unpack(
            &mut std::io::Cursor::new(&src.0[&("eor/portal".to_string(), setup.id)]),
        )
        .unwrap();
        let dir_payload = hbg1::encode_setup_directory(&src, &setup_re).unwrap();
        let part_v1 = hbg1::encode_gfx_part(&part).unwrap();
        let part_v2 = hbg1::encode_gfx_part_faces(&part, &|_d: u32| Some(0x2u32)).unwrap();
        for (label, part_payload, want_missing) in
            [("v1", &part_v1, true), ("v2", &part_v2, false)]
        {
            crate::set_neg_face_for_test(true, false);
            let mut geom = |q: u32| -> Option<Vec<u8>> {
                if q == setup.id {
                    Some(dir_payload.clone())
                } else if q == part.id {
                    Some(part_payload.clone())
                } else {
                    None
                }
            };
            let (_b, d) = assemble_models(&mut geom, &[setup.id]).unwrap();
            assert_eq!(
                d["models"][0].get("missing").is_some(),
                want_missing,
                "setup over a {label} part under retail"
            );
            assert_eq!(d["faceUnmarked"].as_u64(), Some(want_missing as u64));
        }
    }

    /// `?negFace` + `?perPolyCull=on`: a v2 payload flagged NEG_FRONT_COPY
    /// falls back (counted `faceFrontCopy`); an unflagged one assembles and
    /// still equals the runtime (whose front-copy rule finds nothing to do).
    #[test]
    fn neg_face_front_copy_candidates_fall_back_only_under_per_poly_cull() {
        let _reset = NegFaceReset;
        for (id, candidate) in [(0x0100_DB03u32, true), (0x0100_DB04, false)] {
            let gfx = nf_gfx(id, candidate);
            let (src, gfx_re) = nf_source(&gfx);
            let payload =
                hbg1::encode_gfx_part_faces(&gfx_re, &|d: u32| hbg1::read_surface_type(&src, d))
                    .unwrap();
            let flagged = hbg1::Hbg1Mesh::parse(&payload).unwrap().header.flags
                & hbg1::flags::NEG_FRONT_COPY
                != 0;
            assert_eq!(flagged, candidate, "0x{id:08X}: NEG_FRONT_COPY");
            let mut geom = |q: u32| (q == id).then(|| payload.clone());

            // `?negFace` alone: always assembled (no front-copy rule there).
            crate::set_neg_face_for_test(true, false);
            let (_b, d) = assemble_models(&mut geom, &[id]).unwrap();
            assert!(d["models"][0].get("missing").is_none(), "0x{id:08X}: retail only");

            crate::set_neg_face_for_test(true, true);
            let (buffer, d) = assemble_models(&mut geom, &[id]).unwrap();
            assert_eq!(
                d["models"][0].get("missing").is_some(),
                candidate,
                "0x{id:08X}: retail + perPolyCull"
            );
            assert_eq!(d["faceFrontCopy"].as_u64(), Some(candidate as u64));
            if !candidate {
                let (tris, _) = crate::triangulate_model_uncached(&src, id, &[], &[], None)
                    .expect("runtime triangulation");
                assert_groups_equal(
                    runtime_groups(&tris),
                    bundle_groups(&buffer, &d["models"][0]),
                    "retail + perPolyCull, no candidate",
                );
            }
        }
    }

    /// The SETUP comparison bar (2026-10-23, review hbg1v2-1). Per surface,
    /// every runtime triangle must find a bundle triangle with bit-identical
    /// corner positions + uvs, winding included (the setup transform's exact
    /// half), whose quantized corner normals sit within `tol` steps (the
    /// re-normalize half: the bundle transforms a DEQUANTIZED normal, the
    /// runtime quantizes a transformed authored one — the 2-step bar of
    /// `differ_setup_matches_runtime_walk`). Matched greedily inside one
    /// position key, so two triangles that differ only by their normals never
    /// pair crosswise. `tol = i16::MAX` leaves positions + uvs only.
    fn assert_groups_close(
        runtime: &HashMap<u32, Vec<[Corner; 3]>>,
        bundle: &HashMap<u32, Vec<[Corner; 3]>>,
        tol: i16,
        ctx: &str,
    ) {
        let mut r_keys: Vec<u32> = runtime.keys().copied().collect();
        let mut b_keys: Vec<u32> = bundle.keys().copied().collect();
        r_keys.sort_unstable();
        b_keys.sort_unstable();
        assert_eq!(r_keys, b_keys, "{ctx}: surface group sets differ");
        type PosKey = [([u32; 3], [u32; 2]); 3];
        let pos_key = |t: &[Corner; 3]| -> PosKey {
            [(t[0].pos, t[0].uv), (t[1].pos, t[1].uv), (t[2].pos, t[2].uv)]
        };
        for k in r_keys {
            let (r, b) = (&runtime[&k], &bundle[&k]);
            assert_eq!(r.len(), b.len(), "{ctx}: surface 0x{k:08X} triangle count differs");
            let mut pool: HashMap<PosKey, Vec<[[i8; 3]; 3]>> = HashMap::new();
            for t in b {
                pool.entry(pos_key(t)).or_default().push([t[0].qn, t[1].qn, t[2].qn]);
            }
            for t in r {
                let Some(cands) = pool.get_mut(&pos_key(t)) else {
                    panic!("{ctx}: surface 0x{k:08X}: no bit-exact bundle twin for {t:?}");
                };
                let close = |q: &[[i8; 3]; 3]| {
                    (0..3).all(|c| {
                        (0..3).all(|a| (q[c][a] as i16 - t[c].qn[a] as i16).abs() <= tol)
                    })
                };
                let Some(at) = cands.iter().position(close) else {
                    panic!("{ctx}: surface 0x{k:08X}: normals of {t:?} drift > {tol} steps: {cands:?}");
                };
                cands.swap_remove(at);
            }
        }
    }

    /// The two-part setup the `?negFace` setup tests share (2026-10-23,
    /// review hbg1v2-1/-2). Part 0 = `nf_gfx` under a non-unit scale and a
    /// rotation about Z: its NoPos-only vertex goes on `?negFace=off` and its
    /// back-face vertices go on `?negFace`, so it COMPACTS on both arms.
    /// Part 1 = `hbg1_fixture_gfx` (a distinct-neg SidesType-2 poly, so a
    /// `MODEL_BACKFACE` subset) under unit scale and an oblique rotation:
    /// copied verbatim on `?negFace=off`, compacted on `?negFace` — either
    /// way its `vtxBase`/`idxFirst` sit behind a compacted part 0.
    /// `flags: 0x02` so `default_scale` survives the pack (`SetupModel::pack`
    /// writes it only under that bit), and placement key 0 resolves the same
    /// frames on the native runtime's legacy chain and the bake's retail one.
    ///
    /// Returns (source carrying the setup, both parts and the `nf_` Surface
    /// records; the setup and its parts as the runtime reads them back).
    fn nf_setup() -> (
        FixtureSource,
        holtburger_dat::file_type::SetupModel,
        Vec<holtburger_dat::file_type::GfxObj>,
    ) {
        use holtburger_common::{Quaternion, Sphere, Vector3};
        use holtburger_dat::file_type::setup_model::{AnimationFrame, PlacementType};
        use holtburger_dat::file_type::{GfxObj, SetupModel};
        use holtburger_dat::graphics::Frame;
        let parts = [nf_gfx(0x0100_DB10, false), hbg1_fixture_gfx()];
        let (a, b) = (30.0f32.to_radians() / 2.0, 50.0f32.to_radians() / 2.0);
        let frames = vec![
            Frame {
                origin: Vector3 { x: 0.5, y: -1.25, z: 2.0 },
                orientation: Quaternion { w: a.cos(), x: 0.0, y: 0.0, z: a.sin() },
            },
            Frame {
                origin: Vector3 { x: -2.0, y: 3.5, z: 0.75 },
                // Unit axis (1, 2, 2) / 3: every quaternion term is live.
                orientation: Quaternion {
                    w: b.cos(),
                    x: b.sin() / 3.0,
                    y: b.sin() * 2.0 / 3.0,
                    z: b.sin() * 2.0 / 3.0,
                },
            },
        ];
        let setup = SetupModel {
            id: 0x0200_DB10,
            flags: 0x02,
            parts: parts.iter().map(|g| g.id).collect(),
            parent_index: vec![],
            default_scale: vec![
                Vector3 { x: 1.5, y: 1.5, z: 2.0 },
                Vector3 { x: 1.0, y: 1.0, z: 1.0 },
            ],
            holding_locations: HashMap::new(),
            connection_points: HashMap::new(),
            placement_frames: HashMap::from([(
                0,
                PlacementType { anim_frame: AnimationFrame { frames, hooks: vec![] } },
            )]),
            cyl_spheres: vec![],
            spheres: vec![],
            height: 0.0,
            radius: 0.0,
            step_up: 0.0,
            step_down: 0.0,
            sorting_sphere: Sphere { center: Vector3::zero(), radius: 0.0 },
            selection_sphere: Sphere { center: Vector3::zero(), radius: 0.0 },
            lights: HashMap::new(),
            default_animation: None,
            default_script: None,
            default_motion_table: None,
            default_sound_table: None,
            default_script_table: None,
        };
        let mut records: HashMap<(String, u32), Vec<u8>> = HashMap::new();
        let mut setup_bytes = Vec::new();
        setup.pack(&mut std::io::Cursor::new(&mut setup_bytes)).unwrap();
        let setup_re = SetupModel::unpack(&mut std::io::Cursor::new(&setup_bytes))
            .expect("setup round-trips");
        assert_eq!(setup_re.default_scale.len(), 2, "default_scale survives the pack");
        records.insert(("eor/portal".to_string(), setup.id), setup_bytes);
        let mut parts_re = Vec::with_capacity(parts.len());
        for g in &parts {
            let mut bytes = Vec::new();
            g.pack(&mut std::io::Cursor::new(&mut bytes)).unwrap();
            parts_re.push(
                GfxObj::unpack(&mut std::io::Cursor::new(&bytes)).expect("part round-trips"),
            );
            records.insert(("eor/portal".to_string(), g.id), bytes);
        }
        for (did, textured) in [(NF_TEX_A, true), (NF_TEX_B, true), (NF_SOLID, false)] {
            records.insert(("eor/portal".to_string(), did), nf_surface_bytes(textured));
        }
        (FixtureSource(records), setup_re, parts_re)
    }

    /// The tentpole differ's SETUP leg (2026-10-23, review hbg1v2-1): a
    /// kind-1 assembly over v2 parts, under each `?negFace` arm, equals the
    /// runtime setup walk under that arm — so the filtered + compacted
    /// `collect_part_source` runs through `transform_part` (scale → rotate →
    /// renormalize on the COMPACTED streams) and the per-part rebase. Each
    /// part's descriptor range is also differed against the runtime's
    /// per-part walk: the JS hinge path draws parts by `vtxBase`/`idxFirst`.
    #[test]
    fn neg_face_v2_setup_matches_runtime_on_both_arms() {
        let _reset = NegFaceReset;
        let (src, setup, parts) = nf_setup();
        let dir_payload = hbg1::encode_setup_directory(&src, &setup).unwrap();
        let payloads: HashMap<u32, Vec<u8>> = parts
            .iter()
            .map(|g| {
                let p = hbg1::encode_gfx_part_faces(g, &|d: u32| hbg1::read_surface_type(&src, d))
                    .expect("v2 encode");
                (g.id, p)
            })
            .collect();
        let source_vertex_count = |pi: usize| -> usize {
            hbg1::Hbg1Mesh::parse(&payloads[&parts[pi].id]).unwrap().vertex_count
        };

        for retail in [false, true] {
            crate::set_neg_face_for_test(retail, false);
            let ctx = format!("setup negFace retail={retail}");
            let (tris, _complete) =
                crate::triangulate_model_uncached(&src, setup.id, &[], &[], None)
                    .expect("runtime setup walk");
            let per_part = crate::triangulate_setup_model_per_part(&src, setup.id, &[], &[])
                .expect("runtime per-part walk");
            let mut geom = |q: u32| -> Option<Vec<u8>> {
                if q == setup.id { Some(dir_payload.clone()) } else { payloads.get(&q).cloned() }
            };
            let (buffer, descriptor) = assemble_models(&mut geom, &[setup.id]).unwrap();
            assert_eq!(descriptor["negFaceRetail"].as_bool(), Some(retail));
            let entry = &descriptor["models"][0];
            assert!(entry.get("missing").is_none(), "{ctx}: assembled");
            assert_groups_close(
                &runtime_groups(&tris),
                &bundle_groups(&buffer, entry),
                2,
                &ctx,
            );
            // The other arm's subsets are gone, not just empty.
            let gone = if retail {
                hbg1::subset_flags::MODEL_BACKFACE
            } else {
                hbg1::subset_flags::NOPOS_SLOT0
            };
            for s in entry["fused"]["subsets"].as_array().unwrap() {
                assert_eq!((s["flags"].as_u64().unwrap() as u8) & gone, 0, "{ctx}: {s}");
            }

            // Per part: the ranges tile the model in part order, every index
            // stays inside its own part's vertex range, every vertex is used,
            // and the part's subsets alone equal the runtime's part bucket.
            let vcount = entry["vtx"]["count"].as_u64().unwrap() as usize;
            let idx_off = entry["idx"]["off"].as_u64().unwrap() as usize;
            let width = entry["idx"]["width"].as_u64().unwrap() as usize;
            let index_at = |i: usize| -> usize {
                let o = idx_off + i * width;
                if width == 2 {
                    u16::from_le_bytes(buffer[o..o + 2].try_into().unwrap()) as usize
                } else {
                    u32::from_le_bytes(buffer[o..o + 4].try_into().unwrap()) as usize
                }
            };
            let part_entries = entry["parts"].as_array().unwrap();
            assert_eq!(part_entries.len(), 2, "{ctx}: two parts");
            assert_eq!(per_part.len(), 2, "{ctx}: two runtime buckets");
            let (mut vb, mut ib) = (0usize, 0usize);
            let mut used = vec![false; vcount];
            for (pi, p) in part_entries.iter().enumerate() {
                let field = |k: &str| p[k].as_u64().unwrap() as usize;
                assert_eq!(field("partIndex"), pi, "{ctx}");
                assert_eq!((field("vtxBase"), field("idxFirst")), (vb, ib), "{ctx}: part {pi}");
                let (vc, ic) = (field("vtxCount"), field("idxCount"));
                for i in ib..ib + ic {
                    let ix = index_at(i);
                    assert!((vb..vb + vc).contains(&ix), "{ctx}: part {pi} index {ix}");
                    used[ix] = true;
                }
                for s in p["subsets"].as_array().unwrap() {
                    let first = s["firstIndex"].as_u64().unwrap() as usize;
                    let count = s["indexCount"].as_u64().unwrap() as usize;
                    assert!(first >= ib && first + count <= ib + ic, "{ctx}: part {pi}: {s}");
                }
                let mut part_entry = entry.clone();
                part_entry["fused"]["subsets"] = p["subsets"].clone();
                assert_groups_close(
                    &runtime_groups(&per_part[pi]),
                    &bundle_groups(&buffer, &part_entry),
                    2,
                    &format!("{ctx} part {pi}"),
                );
                // The branch this differ exists for: part 0 compacts on both
                // arms, part 1 only where its back face goes.
                let compacted = vc < source_vertex_count(pi);
                assert_eq!(compacted, pi == 0 || retail, "{ctx}: part {pi} {vc} vertices");
                vb += vc;
                ib += ic;
            }
            assert_eq!(vb, vcount, "{ctx}: parts tile the vertex region");
            assert_eq!(ib as u64, entry["idx"]["count"].as_u64().unwrap(), "{ctx}");
            assert!(used.iter().all(|&u| u), "{ctx}: orphan vertex");
        }
    }

    /// `?negFace` on over a v1 dist (every run before the GEOM rebake): a
    /// setup stops reading at its FIRST unmarked part instead of copying
    /// every part payload out of the pack first (review hbg1v2-2,
    /// 2026-10-23). `?negFace=off` still reads and assembles every part.
    #[test]
    fn neg_face_v1_setup_stops_at_first_unmarked_part() {
        let _reset = NegFaceReset;
        let (src, setup, parts) = nf_setup();
        let dir_payload = hbg1::encode_setup_directory(&src, &setup).unwrap();
        let v1: HashMap<u32, Vec<u8>> =
            parts.iter().map(|g| (g.id, hbg1::encode_gfx_part(g).unwrap())).collect();
        for (retail, want_reads) in [(true, 2usize), (false, 1 + parts.len())] {
            crate::set_neg_face_for_test(retail, false);
            let reads = std::cell::RefCell::new(Vec::new());
            let mut geom = |q: u32| -> Option<Vec<u8>> {
                reads.borrow_mut().push(q);
                if q == setup.id { Some(dir_payload.clone()) } else { v1.get(&q).cloned() }
            };
            let (_b, d) = assemble_models(&mut geom, &[setup.id]).unwrap();
            assert_eq!(d["models"][0].get("missing").is_some(), retail, "retail={retail}");
            assert_eq!(d["faceUnmarked"].as_u64(), Some(retail as u64), "retail={retail}");
            assert_eq!(reads.borrow().len(), want_reads, "retail={retail}: {:?}", reads.borrow());
        }
    }

    /// REAL-DAT differ (H-04.6(d) at corpus scale; #[ignore] — needs
    /// ~/ac_base_dats). Every sampled 0x01 GfxObj must assemble to the
    /// runtime triangulation exactly (positions/uvs bit-exact, normals at
    /// quantization); setups pin positions bit-exact.
    #[test]
    #[ignore]
    fn differ_real_dats_models() {
        use holtburger_dat::DatDatabase;
        let home = std::env::var("HOME").unwrap();
        let portal_path = format!("{home}/ac_base_dats/client_portal.dat");
        let portal = DatDatabase::new(&portal_path).expect("open portal dat");
        struct DatSrc(DatDatabase);
        impl ResourceSource for DatSrc {
            fn get_file_by_key(&self, key: ResourceKey<'_>) -> holtburger_dat::Result<Vec<u8>> {
                self.0.get_file(key.file_id)
            }
            fn get_metadata_by_key(&self, _key: ResourceKey<'_>) -> Option<FileMetadata> {
                None
            }
            fn has_namespace(&self, ns: &str) -> bool {
                ns == "eor/portal"
            }
        }
        let ids: Vec<u32> = portal.files.keys().copied().collect();
        let src = DatSrc(portal);

        let mut gfx_checked = 0usize;
        let mut setup_checked = 0usize;
        for &id in &ids {
            let prefix = (id >> 24) as u8;
            if prefix == 0x01 && gfx_checked < 300 {
                let bytes = src.0.get_file(id).unwrap();
                let Ok(gfx) = holtburger_dat::file_type::GfxObj::unpack(
                    &mut std::io::Cursor::new(&bytes),
                ) else {
                    continue;
                };
                let tris = crate::triangulate_model(&src, id).unwrap_or_default();
                let payload = hbg1::encode_gfx_part(&gfx).expect("encode");
                let mut geom = |q: u32| (q == id).then(|| payload.clone());
                let (buffer, descriptor) = assemble_models(&mut geom, &[id]).unwrap();
                let entry = &descriptor["models"][0];
                assert_groups_equal(
                    runtime_groups(&tris),
                    bundle_groups(&buffer, entry),
                    &format!("gfx 0x{id:08X}"),
                );
                gfx_checked += 1;
            } else if prefix == 0x02 && setup_checked < 150 {
                let bytes = src.0.get_file(id).unwrap();
                let Ok(setup) = holtburger_dat::file_type::SetupModel::unpack(
                    &mut std::io::Cursor::new(&bytes),
                ) else {
                    continue;
                };
                let Ok(dir_payload) = hbg1::encode_setup_directory(&src, &setup) else {
                    continue;
                };
                let mut part_payloads: HashMap<u32, Vec<u8>> = HashMap::new();
                let mut all_parts = true;
                for &p in &setup.parts {
                    if (p >> 24) as u8 != 0x01 {
                        continue;
                    }
                    match src.0.get_file(p).ok().and_then(|b| {
                        holtburger_dat::file_type::GfxObj::unpack(
                            &mut std::io::Cursor::new(&b),
                        )
                        .ok()
                    }) {
                        Some(g) => {
                            part_payloads.insert(p, hbg1::encode_gfx_part(&g).unwrap());
                        }
                        None => all_parts = false,
                    }
                }
                if !all_parts {
                    continue;
                }
                // Drive the RUNTIME walk with the directory-resolved pose:
                // native builds hardcode `placement_id_flag() == false`
                // (legacy 0 → 1 → first) while the live wasm default is the
                // retail chain (0x65 → 0 → first) the bake mirrors — so a
                // bare `triangulate_model` here compares the wrong chain.
                // The transform path (scale → rotate → translate, appender)
                // stays independently exercised; chain SEMANTICS are pinned
                // by the fixture differ + hbg1 unit tests.
                let dir = hbg1::parse_setup(&dir_payload).unwrap();
                let pose = holtburger_dat::file_type::setup_model::AnimationFrame {
                    frames: dir
                        .parts
                        .iter()
                        .map(|r| holtburger_dat::graphics::Frame {
                            origin: holtburger_common::Vector3 {
                                x: r.frame_pos[0],
                                y: r.frame_pos[1],
                                z: r.frame_pos[2],
                            },
                            orientation: holtburger_common::Quaternion {
                                w: r.frame_quat[0],
                                x: r.frame_quat[1],
                                y: r.frame_quat[2],
                                z: r.frame_quat[3],
                            },
                        })
                        .collect(),
                    hooks: vec![],
                };
                let mut tris = Vec::new();
                if crate::triangulate_setup_model_at_frame(
                    &src,
                    id,
                    &[],
                    &[],
                    None,
                    Some(&pose),
                    &mut tris,
                )
                .is_none()
                {
                    continue;
                }
                let mut geom = |q: u32| -> Option<Vec<u8>> {
                    if q == id {
                        Some(dir_payload.clone())
                    } else {
                        part_payloads.get(&q).cloned()
                    }
                };
                let (buffer, descriptor) = assemble_models(&mut geom, &[id]).unwrap();
                let entry = &descriptor["models"][0];
                if entry.get("missing").is_some() {
                    continue;
                }
                // Positions bit-exact per surface (normals tolerance covered
                // by the fixture differ; setups here pin the transform path
                // at corpus scale).
                let rt = runtime_groups(&tris);
                let bd = bundle_groups(&buffer, entry);
                let strip =
                    |m: &HashMap<u32, Vec<[Corner; 3]>>| -> HashMap<u32, Vec<[[u32; 3]; 3]>> {
                        m.iter()
                            .map(|(k, v)| {
                                let mut tris: Vec<[[u32; 3]; 3]> = v
                                    .iter()
                                    .map(|t| [t[0].pos, t[1].pos, t[2].pos])
                                    .collect();
                                tris.sort();
                                (*k, tris)
                            })
                            .collect()
                    };
                assert_eq!(
                    strip(&rt),
                    strip(&bd),
                    "setup 0x{id:08X}: positions must be bit-exact"
                );
                setup_checked += 1;
            }
        }
        println!("real-DAT differ: {gfx_checked} GfxObjs exact, {setup_checked} setups position-exact");
        assert!(gfx_checked >= 200, "want ≥200 GfxObjs, got {gfx_checked}");
        assert!(setup_checked >= 100, "want ≥100 setups, got {setup_checked}");
    }

    /// REAL-DAT `?negFace` differ (2026-10-22; #[ignore] — needs
    /// ~/ac_base_dats). Encodes EVERY 0x01 GfxObj as HBG1 v2 with surface
    /// types read from the portal DAT (what the bake does), censuses the
    /// markers, and for up to 400 models that carry one (plus 100 that carry
    /// none) asserts the assembled bundle equals the runtime triangulation
    /// under BOTH `?negFace` arms; then does the same for 0x02 setups over v2
    /// parts (every setup using a marked GfxObj, up to 200, plus 150 plain —
    /// 2026-10-23, the setup leg). Run it BY NAME: the relief differs flip
    /// process-wide relief atomics that would add rails to the runtime side.
    /// The two census lines are the [M] input for
    /// docs/HBG1-negface-marker-2026-10-22.md.
    #[test]
    #[ignore]
    fn differ_real_dats_models_neg_face_v2() {
        use holtburger_dat::DatDatabase;
        let _reset = NegFaceReset;
        let home = std::env::var("HOME").unwrap();
        let portal = DatDatabase::new(&format!("{home}/ac_base_dats/client_portal.dat"))
            .expect("open portal dat");
        struct DatSrc(DatDatabase);
        impl ResourceSource for DatSrc {
            fn get_file_by_key(&self, key: ResourceKey<'_>) -> holtburger_dat::Result<Vec<u8>> {
                self.0.get_file(key.file_id)
            }
            fn get_metadata_by_key(&self, _key: ResourceKey<'_>) -> Option<FileMetadata> {
                None
            }
            fn has_namespace(&self, ns: &str) -> bool {
                ns == "eor/portal"
            }
        }
        let mut ids: Vec<u32> =
            portal.files.keys().copied().filter(|id| (id >> 24) == 0x01).collect();
        ids.sort_unstable();
        let mut setup_ids: Vec<u32> =
            portal.files.keys().copied().filter(|id| (id >> 24) == 0x02).collect();
        setup_ids.sort_unstable();
        let src = DatSrc(portal);
        let (mut encoded, mut with_back, mut with_nopos, mut with_front_copy) =
            (0usize, 0usize, 0usize, 0usize);
        let (mut marked_checked, mut plain_checked, mut with_marked) = (0usize, 0usize, 0usize);
        // Every marked GfxObj id, for the setup leg's sample below.
        let mut marked_ids: std::collections::HashSet<u32> = std::collections::HashSet::new();
        for &id in &ids {
            let bytes = src.0.get_file(id).unwrap();
            let Ok(gfx) =
                holtburger_dat::file_type::GfxObj::unpack(&mut std::io::Cursor::new(&bytes))
            else {
                continue;
            };
            let payload =
                hbg1::encode_gfx_part_faces(&gfx, &|d: u32| hbg1::read_surface_type(&src, d))
                    .expect("v2 encode");
            encoded += 1;
            let mesh = hbg1::Hbg1Mesh::parse(&payload).unwrap();
            let subs = mesh.subsets().unwrap();
            let back = subs.iter().any(|s| s.flags & hbg1::subset_flags::MODEL_BACKFACE != 0);
            let nopos = subs.iter().any(|s| s.flags & hbg1::subset_flags::NOPOS_SLOT0 != 0);
            with_back += back as usize;
            with_nopos += nopos as usize;
            with_front_copy += (mesh.header.flags & hbg1::flags::NEG_FRONT_COPY != 0) as usize;
            let marked = back || nopos;
            with_marked += marked as usize;
            if marked {
                marked_ids.insert(id);
            }
            if (marked && marked_checked >= 400) || (!marked && plain_checked >= 100) {
                continue;
            }
            for retail in [false, true] {
                crate::set_neg_face_for_test(retail, false);
                let tris = crate::triangulate_model_uncached(&src, id, &[], &[], None)
                    .map(|(t, _complete)| t)
                    .unwrap_or_default();
                let mut geom = |q: u32| (q == id).then(|| payload.clone());
                let (buffer, descriptor) = assemble_models(&mut geom, &[id]).unwrap();
                let entry = &descriptor["models"][0];
                assert!(entry.get("missing").is_none(), "gfx 0x{id:08X} retail={retail}");
                assert_groups_equal(
                    runtime_groups(&tris),
                    bundle_groups(&buffer, entry),
                    &format!("gfx 0x{id:08X} retail={retail}"),
                );
            }
            if marked {
                marked_checked += 1;
            } else {
                plain_checked += 1;
            }
        }
        println!(
            "real-DAT negFace v2: {encoded} GfxObjs encoded | MODEL_BACKFACE {with_back} | \
             NOPOS_SLOT0 {with_nopos} | NEG_FRONT_COPY {with_front_copy} | exact on both arms: \
             {marked_checked} marked + {plain_checked} plain"
        );
        // 2026-10-22 first run [M]: the whole base portal.dat has only 32 marked GfxObjs
        // (MODEL_BACKFACE 2, NOPOS_SLOT0 30), not the >= 50 first guessed — so pin "every
        // marked GfxObj (up to the 400 cap) was checked exact on both arms" instead.
        assert!(with_marked > 0, "no marked GfxObj in the corpus");
        assert_eq!(marked_checked, with_marked.min(400), "every marked GfxObj checked");
        assert!(plain_checked >= 50, "want >= 50 plain GfxObjs, got {plain_checked}");

        // SETUP leg (2026-10-23, review hbg1v2-1): the 0x02 path runs the same
        // filtered + compacted parts through `transform_part` and the per-part
        // rebase. Every setup that uses a marked GfxObj (up to 200) plus the
        // first 150 plain ones, both arms, against the runtime walk posed by
        // the directory (native builds resolve the legacy placement chain —
        // see `differ_real_dats_models`). Positions + uvs bit-exact; normals
        // at the 2-step setup bar only when every part is unit-scale — a
        // skewed `default_scale` magnifies one quantization step past any
        // fixed bar (`neg_face_v2_setup_matches_runtime_on_both_arms` pins a
        // scaled part's normals instead).
        let (mut setup_marked, mut setup_plain, mut setup_scaled) = (0usize, 0usize, 0usize);
        for &id in &setup_ids {
            let Ok(bytes) = src.0.get_file(id) else { continue };
            let Ok(setup) = holtburger_dat::file_type::SetupModel::unpack(
                &mut std::io::Cursor::new(&bytes),
            ) else {
                continue;
            };
            let marked = setup.parts.iter().any(|p| marked_ids.contains(p));
            if (marked && setup_marked >= 200) || (!marked && setup_plain >= 150) {
                continue;
            }
            let Ok(dir_payload) = hbg1::encode_setup_directory(&src, &setup) else {
                continue;
            };
            let mut part_payloads: HashMap<u32, Vec<u8>> = HashMap::new();
            let mut all_parts = true;
            for &p in &setup.parts {
                if (p >> 24) as u8 != 0x01 || part_payloads.contains_key(&p) {
                    continue;
                }
                match src.0.get_file(p).ok().and_then(|b| {
                    holtburger_dat::file_type::GfxObj::unpack(&mut std::io::Cursor::new(&b)).ok()
                }) {
                    Some(g) => {
                        let payload =
                            hbg1::encode_gfx_part_faces(&g, &|d: u32| hbg1::read_surface_type(&src, d))
                                .expect("v2 encode");
                        part_payloads.insert(p, payload);
                    }
                    None => all_parts = false,
                }
            }
            if !all_parts {
                continue;
            }
            let dir = hbg1::parse_setup(&dir_payload).unwrap();
            let pose = holtburger_dat::file_type::setup_model::AnimationFrame {
                frames: dir
                    .parts
                    .iter()
                    .map(|r| holtburger_dat::graphics::Frame {
                        origin: holtburger_common::Vector3 {
                            x: r.frame_pos[0],
                            y: r.frame_pos[1],
                            z: r.frame_pos[2],
                        },
                        orientation: holtburger_common::Quaternion {
                            w: r.frame_quat[0],
                            x: r.frame_quat[1],
                            y: r.frame_quat[2],
                            z: r.frame_quat[3],
                        },
                    })
                    .collect(),
                hooks: vec![],
            };
            let unit_scale = dir.parts.iter().all(|r| r.scale == [1.0, 1.0, 1.0]);
            let tol = if unit_scale { 2 } else { i16::MAX };
            for retail in [false, true] {
                crate::set_neg_face_for_test(retail, false);
                let ctx = format!("setup 0x{id:08X} retail={retail}");
                let mut tris = Vec::new();
                crate::triangulate_setup_model_at_frame(
                    &src,
                    id,
                    &[],
                    &[],
                    None,
                    Some(&pose),
                    &mut tris,
                )
                .expect("runtime setup walk");
                let mut geom = |q: u32| -> Option<Vec<u8>> {
                    if q == id { Some(dir_payload.clone()) } else { part_payloads.get(&q).cloned() }
                };
                let (buffer, descriptor) = assemble_models(&mut geom, &[id]).unwrap();
                let entry = &descriptor["models"][0];
                assert!(entry.get("missing").is_none(), "{ctx}: assembled");
                assert_groups_close(
                    &runtime_groups(&tris),
                    &bundle_groups(&buffer, entry),
                    tol,
                    &ctx,
                );
            }
            setup_scaled += (!unit_scale) as usize;
            if marked {
                setup_marked += 1;
            } else {
                setup_plain += 1;
            }
        }
        println!(
            "real-DAT negFace v2 setups: exact on both arms: {setup_marked} using a marked \
             GfxObj + {setup_plain} plain ({setup_scaled} scaled: positions + uvs only)"
        );
        assert!(setup_plain >= 100, "want >= 100 plain setups, got {setup_plain}");
    }

    /// REAL-DAT ENVCELL differ (2026-08-10, filed off the R9 290 eye run's
    /// fractured-interiors finding: the fixture differ above covers one
    /// synthetic cellstruct; this runs the same comparison over every real
    /// envcell of the two landblocks in the report — 0x0163 Holtburg Redoubt
    /// and 0xA900 building interiors). `#[ignore]` — needs ~/ac_base_dats.
    #[test]
    #[ignore]
    fn differ_real_dats_envcells() {
        use holtburger_dat::DatDatabase;
        let home = std::env::var("HOME").unwrap();
        let portal =
            DatDatabase::new(&format!("{home}/ac_base_dats/client_portal.dat")).expect("portal");
        let celldat =
            DatDatabase::new(&format!("{home}/ac_base_dats/client_cell_1.dat")).expect("cell");
        struct CellSrc(DatDatabase);
        impl ResourceSource for CellSrc {
            fn get_file_by_key(&self, key: ResourceKey<'_>) -> holtburger_dat::Result<Vec<u8>> {
                self.0.get_file(key.file_id)
            }
            fn get_metadata_by_key(&self, _key: ResourceKey<'_>) -> Option<FileMetadata> {
                None
            }
            fn has_namespace(&self, ns: &str) -> bool {
                ns == "eor/cell"
            }
        }
        let lbs: [u32; 2] = [0x0163, 0xA900];
        let all_ids: Vec<u32> = celldat.files.keys().copied().collect();
        let src = CellSrc(celldat);
        let mut total_checked = 0usize;
        for &lb in &lbs {
            let mut ids: Vec<u32> = all_ids
                .iter()
                .copied()
                .filter(|id| (id >> 16) == lb && (id & 0xFFFF) >= 0x0100 && (id & 0xFFFF) < 0xFFFE)
                .collect();
            ids.sort_unstable();
            if ids.is_empty() {
                // Outdoor blocks own no interior cells (the eye-report compass
                // shows the OUTDOOR block id, not the interior's) — skip, the
                // dungeon LB is the load-bearing leg.
                println!("LB 0x{lb:04X}: no envcells in cell dat — skipped");
                continue;
            }
            let mut geom = |env_did: u32| -> Option<Vec<u8>> {
                let bytes = portal.get_file(env_did).ok()?;
                let env = holtburger_dat::file_type::Environment::unpack(
                    &mut std::io::Cursor::new(&bytes),
                )
                .ok()?;
                hbg1::encode_env_directory(&env).ok()
            };
            let (buffer, descriptor) =
                assemble_envcells(&src, &mut geom, lb << 16, &ids).unwrap();
            let cells = descriptor["cells"].as_array().unwrap();
            let mut missing = 0usize;
            for (i, cell) in cells.iter().enumerate() {
                let cid = ids[i];
                if cell.get("missing").is_some() {
                    missing += 1;
                    continue;
                }
                // Runtime path: same records, the shipped triangulator.
                let cbytes = src.0.get_file(cid).unwrap();
                let envcell =
                    EnvCell::unpack(&mut std::io::Cursor::new(&cbytes)).unwrap();
                let env_bytes = portal
                    .get_file(0x0D00_0000 | envcell.environment_id as u32)
                    .unwrap();
                let env = holtburger_dat::file_type::Environment::unpack(
                    &mut std::io::Cursor::new(&env_bytes),
                )
                .unwrap();
                let surfaces: Vec<u32> = envcell
                    .surfaces
                    .iter()
                    .copied()
                    .map(surface_did_for_envcell_index)
                    .collect();
                let mut tris = Vec::new();
                crate::append_environment_tris(
                    &mut tris,
                    &env,
                    &surfaces,
                    envcell.cell_structure,
                );
                let rt = runtime_groups(&tris);
                // Bundle path: env entries carry `subsets`/`surfaceDid`
                // (models use `fused.subsets`/`surfaceRef`).
                let vtx_off = cell["vtx"]["off"].as_u64().unwrap() as usize;
                let vtx_count = cell["vtx"]["count"].as_u64().unwrap() as usize;
                let idx_off = cell["idx"]["off"].as_u64().unwrap() as usize;
                let width = cell["idx"]["width"].as_u64().unwrap() as usize;
                let f32_at = |off: usize| -> f32 {
                    f32::from_le_bytes(buffer[off..off + 4].try_into().unwrap())
                };
                let corner = |vi: usize| -> Corner {
                    let p = vtx_off + vi * 12;
                    let n = vtx_off + vtx_count * 12 + vi * 12;
                    let t = vtx_off + vtx_count * 24 + vi * 8;
                    Corner {
                        pos: [
                            f32_at(p).to_bits(),
                            f32_at(p + 4).to_bits(),
                            f32_at(p + 8).to_bits(),
                        ],
                        uv: [f32_at(t).to_bits(), f32_at(t + 4).to_bits()],
                        qn: qn3([f32_at(n), f32_at(n + 4), f32_at(n + 8)]),
                    }
                };
                let index_at = |i: usize| -> usize {
                    let o = idx_off + i * width;
                    if width == 2 {
                        u16::from_le_bytes(buffer[o..o + 2].try_into().unwrap()) as usize
                    } else {
                        u32::from_le_bytes(buffer[o..o + 4].try_into().unwrap()) as usize
                    }
                };
                let mut bd: HashMap<u32, Vec<[Corner; 3]>> = HashMap::new();
                for s in cell["subsets"].as_array().unwrap() {
                    let did = s["surfaceDid"].as_u64().unwrap() as u32;
                    let first = s["firstIndex"].as_u64().unwrap() as usize;
                    let count = s["indexCount"].as_u64().unwrap() as usize;
                    for t in 0..count / 3 {
                        bd.entry(did).or_default().push([
                            corner(index_at(first + t * 3)),
                            corner(index_at(first + t * 3 + 1)),
                            corner(index_at(first + t * 3 + 2)),
                        ]);
                    }
                }
                assert_groups_equal(rt, bd, &format!("envcell 0x{cid:08X}"));
                total_checked += 1;
            }
            println!(
                "LB 0x{lb:04X}: {} envcells exact, {missing} missing",
                cells.len() - missing
            );
            assert_eq!(missing, 0, "LB 0x{lb:04X}: {missing} cells came back missing");
        }
        assert!(total_checked > 100, "want >100 envcells, got {total_checked}");
    }

    /// DEPLOYED-PACK GEOM differ (2026-08-10, fracture root-cause hunt):
    /// every 0x0D env HBG1 payload in the deployed pack dist must byte-match
    /// a fresh `encode_env_directory` of the same record from the base DATs.
    /// A mismatch = the bake binary's emitter drifted from HEAD's parser.
    /// `#[ignore]` — needs ~/ac_base_dats + the dist (HB_PACKS_DIR overrides).
    #[test]
    #[ignore]
    fn differ_deployed_pack_geom_env() {
        use holtburger_dat::DatDatabase;
        use holtburger_resource_http::pack::{HbpPack, section_kind};
        let home = std::env::var("HOME").unwrap();
        let portal =
            DatDatabase::new(&format!("{home}/ac_base_dats/client_portal.dat")).expect("portal");
        let packs_dir = std::env::var("HB_PACKS_DIR").unwrap_or_else(|_| {
            "/mnt/wbterminal2/holtburger-dist-hires-bc7m-xu7t2/packs".to_string()
        });
        fn walk(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
            if let Ok(rd) = std::fs::read_dir(dir) {
                for e in rd.flatten() {
                    let p = e.path();
                    if p.is_dir() {
                        walk(&p, out);
                    } else {
                        out.push(p);
                    }
                }
            }
        }
        let mut files = Vec::new();
        walk(std::path::Path::new(&packs_dir), &mut files);
        assert!(!files.is_empty(), "no pack files under {packs_dir}");
        let mut geom_env: HashMap<u32, Vec<u8>> = HashMap::new();
        let mut pack_files = 0usize;
        let mut geom_packs = 0usize;
        for f in &files {
            let Ok(bytes) = std::fs::read(f) else { continue };
            let Ok(pack) = HbpPack::parse(bytes) else { continue };
            pack_files += 1;
            let Ok(Some(payload)) = pack.section_raw(section_kind::GEOM) else { continue };
            geom_packs += 1;
            for (id, enc, off, size) in hbg1::parse_geom_section(&payload).unwrap() {
                if enc != hbg1::ENCODING_HBG1 || (id >> 24) != 0x0D {
                    continue;
                }
                geom_env
                    .entry(id)
                    .or_insert_with(|| payload[off..off + size].to_vec());
            }
        }
        println!(
            "packs {pack_files}, geom-carrying {geom_packs}, distinct env payloads {}",
            geom_env.len()
        );
        let (mut checked, mut mismatches, mut src_missing) = (0usize, 0usize, 0usize);
        let mut dids: Vec<u32> = geom_env.keys().copied().collect();
        dids.sort_unstable();
        for did in dids {
            let pack_bytes = &geom_env[&did];
            let Ok(src_bytes) = portal.get_file(did) else {
                src_missing += 1;
                continue;
            };
            let env = holtburger_dat::file_type::Environment::unpack(
                &mut std::io::Cursor::new(&src_bytes),
            )
            .expect("env parse");
            let fresh = hbg1::encode_env_directory(&env).expect("fresh encode");
            checked += 1;
            if &fresh != pack_bytes {
                mismatches += 1;
                if mismatches <= 5 {
                    let first = pack_bytes
                        .iter()
                        .zip(fresh.iter())
                        .position(|(a, b)| a != b);
                    println!(
                        "MISMATCH 0x{did:08X}: pack {} B vs fresh {} B, first diff byte {:?}",
                        pack_bytes.len(),
                        fresh.len(),
                        first
                    );
                }
            }
        }
        println!("checked {checked} env payloads: {mismatches} mismatches, {src_missing} not in base portal.dat");
        assert!(checked > 500, "expected a real env corpus, got {checked}");
        assert_eq!(mismatches, 0, "{mismatches} deployed env GEOM payloads drift from HEAD's encoder");
    }

    // ---- fixtures --------------------------------------------------------

    fn hbg1_fixture_gfx() -> holtburger_dat::file_type::GfxObj {
        use holtburger_common::{Vector3, properties::GfxObjFlags};
        use holtburger_dat::graphics::{CVertexArray, Polygon, SWVertex, Vec2Duv};
        use holtburger_dat::physics::{BspLeaf, BspNode};
        let v = |x: f32, y: f32, z: f32, n: [f32; 3], uvs: &[(f32, f32)]| SWVertex {
            num_uvs: uvs.len() as u16,
            origin: Vector3 { x, y, z },
            normal: Vector3 { x: n[0], y: n[1], z: n[2] },
            uvs: uvs.iter().map(|&(u, vv)| Vec2Duv { u, v: vv }).collect(),
        };
        let mut vertices = HashMap::new();
        vertices.insert(0, v(0.0, 0.0, 0.0, [0.0, 0.0, 1.0], &[(0.0, 0.0)]));
        vertices.insert(1, v(1.0, 0.0, 0.0, [0.0, 0.0, 1.0], &[(1.0, 0.0)]));
        vertices.insert(2, v(1.0, 1.0, 0.25, [0.3, 0.1, 0.9], &[(1.0, 1.0)]));
        vertices.insert(3, v(0.0, 1.0, 0.0, [0.0, 0.0, 0.0], &[(0.0, 1.0)]));
        vertices.insert(4, v(0.5, 0.5, 1.0, [1.0, 0.0, 0.0], &[(0.5, 0.5), (0.25, 0.75)]));
        let mut polygons = HashMap::new();
        polygons.insert(
            2,
            Polygon {
                num_pts: 4,
                stippling: 0,
                sides_type: 1,
                pos_surface: 0,
                neg_surface: -1,
                vertex_ids: vec![0, 1, 2, 3],
                pos_uv_indices: vec![0, 0, 0, 0],
                neg_uv_indices: vec![],
            },
        );
        polygons.insert(
            5,
            Polygon {
                num_pts: 3,
                stippling: 1,
                sides_type: 2,
                pos_surface: 0,
                neg_surface: 1,
                vertex_ids: vec![0, 1, 4],
                pos_uv_indices: vec![0, 0, 0],
                neg_uv_indices: vec![0, 0, 1],
            },
        );
        holtburger_dat::file_type::GfxObj {
            id: 0x0100_4001,
            flags: GfxObjFlags::HAS_DRAWING | GfxObjFlags::HAS_DID_DEGRADE,
            surfaces: vec![0x0800_0111, 0x0800_0222],
            vertex_array: CVertexArray { vertex_type: 1, vertices },
            physics_polygons: HashMap::new(),
            physics_bsp: None,
            sort_center: Vector3::zero(),
            polygons,
            drawing_bsp: Some(BspNode::Leaf(BspLeaf {
                index: 0,
                solid: 0,
                sphere: None,
                poly_ids: vec![],
            })),
            did_degrade: Some(0x1100_0001),
        }
    }

    fn hbg1_fixture_setup() -> (
        holtburger_dat::file_type::SetupModel,
        Vec<u8>,
        holtburger_dat::file_type::GfxObj,
        Vec<u8>,
    ) {
        use holtburger_common::{Quaternion, Sphere, Vector3};
        use holtburger_dat::file_type::SetupModel;
        use holtburger_dat::file_type::setup_model::{AnimationFrame, PlacementType};
        use holtburger_dat::graphics::Frame;
        let gfx = hbg1_fixture_gfx();
        let mut gfx_bytes = Vec::new();
        gfx.pack(&mut std::io::Cursor::new(&mut gfx_bytes)).unwrap();

        // A non-trivial frame: translate + rotate ~30° around Z.
        let ang = 30.0f32.to_radians() / 2.0;
        let frame = Frame {
            origin: Vector3 { x: 0.5, y: -1.25, z: 2.0 },
            orientation: Quaternion { w: ang.cos(), x: 0.0, y: 0.0, z: ang.sin() },
        };
        let mut placement_frames = HashMap::new();
        placement_frames.insert(
            0x65,
            PlacementType {
                anim_frame: AnimationFrame { frames: vec![frame], hooks: vec![] },
            },
        );
        let setup = SetupModel {
            id: 0x0200_4001,
            flags: 0,
            parts: vec![gfx.id],
            parent_index: vec![],
            default_scale: vec![Vector3 { x: 1.5, y: 1.5, z: 2.0 }],
            holding_locations: HashMap::new(),
            connection_points: HashMap::new(),
            placement_frames,
            cyl_spheres: vec![],
            spheres: vec![],
            height: 0.0,
            radius: 0.0,
            step_up: 0.0,
            step_down: 0.0,
            sorting_sphere: Sphere { center: Vector3::zero(), radius: 0.0 },
            selection_sphere: Sphere { center: Vector3::zero(), radius: 0.0 },
            lights: HashMap::new(),
            default_animation: None,
            default_script: None,
            default_motion_table: None,
            default_sound_table: None,
            default_script_table: None,
        };
        let mut setup_bytes = Vec::new();
        setup.pack(&mut std::io::Cursor::new(&mut setup_bytes)).unwrap();
        (setup, setup_bytes, gfx, gfx_bytes)
    }

    fn hbg1_fixture_env() -> holtburger_dat::file_type::Environment {
        use holtburger_common::Vector3;
        use holtburger_dat::file_type::Environment;
        use holtburger_dat::file_type::environment::CellStruct;
        use holtburger_dat::graphics::{CVertexArray, Polygon, SWVertex, Vec2Duv};
        let v = |x: f32, y: f32, z: f32, uvs: &[(f32, f32)]| SWVertex {
            num_uvs: uvs.len() as u16,
            origin: Vector3 { x, y, z },
            normal: Vector3::zero(),
            uvs: uvs.iter().map(|&(u, vv)| Vec2Duv { u, v: vv }).collect(),
        };
        let mut vertices = HashMap::new();
        vertices.insert(0, v(0.0, 0.0, 0.0, &[(0.0, 0.0)]));
        vertices.insert(1, v(3.0, 0.0, 0.0, &[(1.0, 0.0)]));
        vertices.insert(2, v(3.0, 3.0, 0.0, &[(1.0, 1.0)]));
        vertices.insert(3, v(0.0, 0.0, 2.5, &[(0.0, 1.0), (0.5, 0.5)]));
        let mut polygons = HashMap::new();
        // Floor tri, slot 2.
        polygons.insert(
            1,
            Polygon {
                num_pts: 3,
                stippling: 0,
                sides_type: 0,
                pos_surface: 2,
                neg_surface: -1,
                vertex_ids: vec![0, 1, 2],
                pos_uv_indices: vec![0, 0, 0],
                neg_uv_indices: vec![],
            },
        );
        // Wall with distinct-slot back face: pos slot 0, neg slot 3.
        polygons.insert(
            4,
            Polygon {
                num_pts: 3,
                stippling: 0,
                sides_type: 2,
                pos_surface: 0,
                neg_surface: 3,
                vertex_ids: vec![0, 1, 3],
                pos_uv_indices: vec![0, 0, 0],
                neg_uv_indices: vec![0, 0, 1],
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
        Environment { id: 0x0D00_4001, cells: HashMap::from([(0u32, cell)]) }
    }

    fn fixture_envcell(
        cell_id: u32,
        env_did: u32,
        cell_structure: u16,
        surfaces: Vec<u16>,
    ) -> EnvCell {
        use holtburger_common::{Quaternion, Vector3};
        use holtburger_dat::graphics::Frame;
        EnvCell {
            id: cell_id,
            flags: 0,
            cell_id,
            surfaces,
            environment_id: (env_did & 0xFFFF) as u16,
            cell_structure,
            position: Frame {
                origin: Vector3 { x: 24.0, y: 48.0, z: 0.0 },
                orientation: Quaternion { w: 1.0, x: 0.0, y: 0.0, z: 0.0 },
            },
            portals: vec![],
            visible_cells: vec![],
            static_objects: vec![],
            restriction_obj: None,
        }
    }

    // -----------------------------------------------------------------
    // RELIEF-IN-BAKE — the consumer-side relief differ
    // -----------------------------------------------------------------

    /// Set/clear the wasm-instance relief config from a NATIVE test.
    /// `set_gfx_relief` itself is `#[cfg(target_arch = "wasm32")]`, but the
    /// three atomics it writes are crate-private statics reachable from here,
    /// and `gfx_relief_config()` is compiled under `test` — so a native differ
    /// can drive the exact same code path the browser drives.
    fn set_relief_for_test(on: bool, level: u32, scale: f32) {
        use std::sync::atomic::Ordering::Relaxed;
        crate::GFX_RELIEF_ON.store(on, Relaxed);
        crate::GFX_RELIEF_LEVEL.store(level, Relaxed);
        crate::GFX_RELIEF_SCALE.store(scale.to_bits(), Relaxed);
        let _ = crate::model_tri_cache_clear_all();
    }

    /// Fixture differ: with relief ON at the shipped preset level, the BAKED
    /// relief variant assembles to exactly what the RUNTIME triangulator
    /// emits — same surfaces, same triangle multiset. This is the property
    /// that lets the bundles arm stop force-disabling relief.
    ///
    /// Uses the same box the runtime rails accept (`ModelGate`: ≥ 4 m bbox,
    /// ≥ 0.60 m median edge, ≥ 50 m² area, ≤ 25 % double-sided).
    #[test]
    fn differ_relief_variant_matches_runtime_relief() {
        let gfx = relief_box_gfx();
        let mut bytes = Vec::new();
        gfx.pack(&mut std::io::Cursor::new(&mut bytes)).unwrap();
        let src = FixtureSource(HashMap::from([(
            ("eor/portal".to_string(), gfx.id),
            bytes,
        )]));

        // Relief-free control: variant encode with a no-op profile is the
        // default, and the default still matches the relief-OFF runtime.
        set_relief_for_test(false, 0, 0.0);
        let flat_tris = crate::triangulate_model(&src, gfx.id).unwrap_or_default();
        let flat_payload = hbg1::encode_gfx_part(&gfx).expect("default encode");
        {
            let mut geom = |q: u32| (q == gfx.id).then(|| flat_payload.clone());
            let (buffer, descriptor) = assemble_models(&mut geom, &[gfx.id]).unwrap();
            assert_groups_equal(
                runtime_groups(&flat_tris),
                bundle_groups(&buffer, &descriptor["models"][0]),
                "relief OFF control",
            );
        }

        // Relief ON at the preset level (subdivLevel 0, scale 1.0).
        set_relief_for_test(true, 0, 1.0);
        let relief_tris = crate::triangulate_model(&src, gfx.id).unwrap_or_default();
        set_relief_for_test(false, 0, 0.0);
        assert!(
            relief_tris.len() > flat_tris.len(),
            "the runtime must add rails on this box ({} -> {})",
            flat_tris.len(),
            relief_tris.len()
        );
        let relief_payload =
            hbg1::encode_gfx_part_relief(&gfx, &hbg1::ReliefBake::from_scale(1.0))
                .expect("relief encode");
        assert_ne!(relief_payload, flat_payload, "variant must differ");
        let mut geom = |q: u32| (q == gfx.id).then(|| relief_payload.clone());
        let (buffer, descriptor) = assemble_models(&mut geom, &[gfx.id]).unwrap();
        assert_groups_equal(
            runtime_groups(&relief_tris),
            bundle_groups(&buffer, &descriptor["models"][0]),
            "relief ON: baked variant vs runtime relief",
        );

        // …and the relief delta is exactly the rails: same surfaces, strictly
        // more triangles, every relief-free triangle still present.
        let flat_g = runtime_groups(&flat_tris);
        let relief_g = runtime_groups(&relief_tris);
        let mut keys: Vec<u32> = flat_g.keys().copied().collect();
        keys.sort_unstable();
        let mut rkeys: Vec<u32> = relief_g.keys().copied().collect();
        rkeys.sort_unstable();
        assert_eq!(keys, rkeys, "relief must not invent or drop a material");
        for k in keys {
            let f = &flat_g[&k];
            let r = &relief_g[&k];
            assert!(r.len() >= f.len(), "surface 0x{k:08X} lost triangles");
            for t in f {
                assert!(r.contains(t), "surface 0x{k:08X}: a base triangle moved");
            }
        }
    }

    /// A 6 m two-material box: clears `ModelGate` and has 12 convex 90°
    /// edges, so OP1 fires. (Sibling of the codec's `big_box_gfx`; kept local
    /// because these two crates' fixtures are independently maintained.)
    fn relief_box_gfx() -> holtburger_dat::file_type::GfxObj {
        use holtburger_common::{Quaternion, Vector3};
        use holtburger_dat::graphics::{CVertexArray, Polygon, SWVertex, Vec2Duv};
        let corners: [[f32; 3]; 8] = [
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
        for (i, c) in corners.iter().enumerate() {
            let d = [c[0] - 3.0, c[1] - 3.0, c[2] - 3.0];
            let l = (d[0] * d[0] + d[1] * d[1] + d[2] * d[2]).sqrt();
            vertices.insert(
                i as u16,
                SWVertex {
                    num_uvs: 1,
                    origin: Vector3 { x: c[0], y: c[1], z: c[2] },
                    normal: Vector3 { x: d[0] / l, y: d[1] / l, z: d[2] / l },
                    uvs: vec![Vec2Duv { u: c[0] / 6.0, v: c[1] / 6.0 }],
                },
            );
        }
        let faces: [([i16; 4], i16); 6] = [
            ([0, 3, 2, 1], 0),
            ([4, 5, 6, 7], 0),
            ([0, 1, 5, 4], 0),
            ([1, 2, 6, 5], 1),
            ([2, 3, 7, 6], 1),
            ([3, 0, 4, 7], 1),
        ];
        let mut polygons = HashMap::new();
        for (i, (ring, surf)) in faces.iter().enumerate() {
            polygons.insert(
                i as u16,
                Polygon {
                    num_pts: 4,
                    stippling: 0,
                    sides_type: 0,
                    pos_surface: *surf,
                    neg_surface: -1,
                    vertex_ids: ring.to_vec(),
                    pos_uv_indices: vec![0, 0, 0, 0],
                    neg_uv_indices: vec![],
                },
            );
        }
        holtburger_dat::file_type::GfxObj {
            id: 0x0100_0777,
            flags: holtburger_common::properties::GfxObjFlags::HAS_DRAWING,
            surfaces: vec![0x0800_0010, 0x0800_0020],
            vertex_array: CVertexArray { vertex_type: 1, vertices },
            physics_polygons: HashMap::new(),
            physics_bsp: None,
            sort_center: Vector3::zero(),
            polygons,
            drawing_bsp: Some(holtburger_dat::physics::BspNode::Leaf(
                holtburger_dat::physics::BspLeaf {
                    index: 0,
                    solid: 0,
                    sphere: None,
                    poly_ids: vec![],
                },
            )),
            did_degrade: None,
        }
    }

    /// Real-DAT relief differ (`--ignored`, needs ~/ac_base_dats). Every
    /// sampled 0x01 GfxObj's BAKED relief variant must assemble to exactly
    /// the runtime's relief triangulation.
    ///
    /// MUST run with `--test-threads=1`: it drives the crate-global relief
    /// atomics, which every other triangulation test reads.
    #[test]
    #[ignore]
    fn differ_real_dats_relief_variants() {
        use holtburger_dat::DatDatabase;
        let home = std::env::var("HOME").unwrap();
        let portal = DatDatabase::new(&format!("{home}/ac_base_dats/client_portal.dat"))
            .expect("open portal dat");
        struct DatSrc(DatDatabase);
        impl ResourceSource for DatSrc {
            fn get_file_by_key(&self, key: ResourceKey<'_>) -> holtburger_dat::Result<Vec<u8>> {
                self.0.get_file(key.file_id)
            }
            fn get_metadata_by_key(&self, _key: ResourceKey<'_>) -> Option<FileMetadata> {
                None
            }
            fn has_namespace(&self, ns: &str) -> bool {
                ns == "eor/portal"
            }
        }
        let ids: Vec<u32> = portal.files.keys().copied().collect();
        let src = DatSrc(portal);
        let profile = hbg1::ReliefBake::from_scale(1.0);

        let mut checked = 0usize;
        let mut railed = 0usize;
        let mut added_tris = 0usize;
        for &id in &ids {
            if (id >> 24) as u8 != 0x01 || checked >= 120 {
                continue;
            }
            let Ok(bytes) = src.0.get_file(id) else { continue };
            let Ok(gfx) = holtburger_dat::file_type::GfxObj::unpack(
                &mut std::io::Cursor::new(&bytes),
            ) else {
                continue;
            };
            let flat = hbg1::encode_gfx_part(&gfx).expect("default encode");
            let variant = hbg1::encode_gfx_part_relief(&gfx, &profile).expect("relief encode");
            set_relief_for_test(true, 0, 1.0);
            let tris = crate::triangulate_model(&src, id).unwrap_or_default();
            set_relief_for_test(false, 0, 0.0);
            let flat_tris = crate::triangulate_model(&src, id).unwrap_or_default();
            if variant != flat {
                railed += 1;
                added_tris += tris.len().saturating_sub(flat_tris.len());
            }
            let payload = if variant != flat { &variant } else { &flat };
            let mut geom = |q: u32| (q == id).then(|| payload.clone());
            let (buffer, descriptor) = assemble_models(&mut geom, &[id]).unwrap();
            assert_groups_equal(
                runtime_groups(&tris),
                bundle_groups(&buffer, &descriptor["models"][0]),
                &format!("relief gfx 0x{id:08X}"),
            );
            checked += 1;
        }
        println!(
            "relief differ: {checked} GfxObjs EXACT vs runtime relief; \
             {railed} carry a variant row (+{added_tris} tris)"
        );
        assert!(checked >= 100, "relief differ needs ≥ 100 models (got {checked})");
        assert!(railed > 0, "no sampled model gained rails — check ModelGate");
    }
}
