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
// Model assembly (kind 0 direct + kind 1 fused/per-part)
// ---------------------------------------------------------------------------

/// Assemble one batch of model ids into (buffer, descriptor). `geom` resolves
/// a model id to its HBG1 payload bytes (PackSource in the live path; the
/// encoder directly in tests).
pub(crate) fn assemble_models(
    geom: &mut dyn FnMut(u32) -> Option<Vec<u8>>,
    model_ids: &[u32],
) -> Result<(Vec<u8>, serde_json::Value), String> {
    let mut w = BundleWriter::new();
    let mut models = Vec::with_capacity(model_ids.len());
    let mut assembled = 0u32;
    let mut missing = 0u32;
    for &id in model_ids {
        match assemble_one_model(&mut w, geom, id) {
            Ok(Some(entry)) => {
                assembled += 1;
                models.push(entry);
            }
            Ok(None) => {
                missing += 1;
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

fn assemble_one_model(
    w: &mut BundleWriter,
    geom: &mut dyn FnMut(u32) -> Option<Vec<u8>>,
    id: u32,
) -> Result<Option<serde_json::Value>, String> {
    match (id >> 24) as u8 {
        0x01 => {
            let Some(payload) = geom(id) else { return Ok(None) };
            let mesh = hbg1::Hbg1Mesh::parse(&payload)?;
            let parts = vec![collect_part_source(&mesh, 0)];
            Ok(Some(write_model_entry(
                w,
                id,
                mesh.did_degrade,
                parts,
            )))
        }
        0x02 => {
            let Some(dir_payload) = geom(id) else { return Ok(None) };
            let dir = hbg1::parse_setup(&dir_payload)?;
            // Resolve every drawable part's payload FIRST — any missing 0x01
            // part payload downgrades the whole model to the runtime decode
            // (never a silently partial building).
            let mut part_payloads: Vec<Option<Vec<u8>>> =
                Vec::with_capacity(dir.parts.len());
            for row in &dir.parts {
                if (row.part_did >> 24) as u8 == 0x01 {
                    match geom(row.part_did) {
                        Some(p) => part_payloads.push(Some(p)),
                        None => return Ok(None),
                    }
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
                    Some(p) => {
                        let mesh = hbg1::Hbg1Mesh::parse(p)?;
                        let mut src = collect_part_source(&mesh, pi);
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
            Ok(Some(write_model_entry(w, id, dir.did_degrade, parts)))
        }
        _ => Ok(None), // 0x0D goes through assemble_envcells; others: fallback.
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

fn collect_part_source(mesh: &hbg1::Hbg1Mesh<'_>, part_index: usize) -> PartSource {
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
    let subsets = mesh
        .subsets()
        .unwrap_or_default()
        .into_iter()
        .map(|s| (s.surface_ref, s.flags, s.first_index, s.index_count))
        .collect();
    PartSource {
        part_index,
        hinge: [0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0],
        pos,
        normal,
        uv,
        indices,
        subsets,
    }
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
    #[wasm_bindgen]
    pub fn assemble_model_geometry(model_ids: &[u32]) -> Result<JsValue, JsValue> {
        let mut geom =
            |id: u32| -> Option<Vec<u8>> { crate::pack_source_glue::pack_geom_payload(id) };
        let (buffer, descriptor) = super::assemble_models(&mut geom, model_ids)
            .map_err(|e| JsValue::from_str(&e))?;
        Ok(bundle_to_js(buffer, descriptor))
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
}
