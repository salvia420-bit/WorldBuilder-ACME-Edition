//! `impl DatPack for GfxObj` — delegates to `GfxObj::pack` and enforces the
//! mesh invariants (E12 design §B.5 #1–6).
//!
//! GfxObj is the richest already-correct pack in `holtburger-dat` and
//! carries the most load-bearing invariants — chiefly the Polygon stippling
//! UV-omit gating, which a prior READER port confused (treating `0x01`/`0x02`
//! Positive/Negative AS the omit flags) and thereby caused retail buffer
//! overruns. The gold reference for the flag semantics lives in
//! `holtburger_dat::graphics` (`Polygon` read/write, ~lines 167-169 /
//! 219-221): the omit gating is ONLY NoPos = `0x04` / NoNeg = `0x08`
//! (with CullMode::Clockwise = `0x2`). The Positive/Negative bits
//! (`0x01`/`0x02`) are inert pass-through wire flags that do NOT affect UV
//! presence, so the guard MUST NOT reject them — rejecting them would break
//! byte round-trip for retail polygons that legitimately carry them.
//!
//! The guards run BEFORE the underlying `pack`, so a violation surfaces as
//! [`WriteError::InvariantViolation`] and no bytes are produced.

use std::io::Cursor;

use holtburger_common::properties::GfxObjFlags;
use holtburger_dat::DatFileType;
use holtburger_dat::file_type::GfxObj;
use holtburger_dat::graphics::Polygon;

use crate::error::{Result, WriteError};
use crate::DatPack;

/// `StipplingType` omit-pos flag (per `ACE.Entity.Enum.StipplingType`).
/// UV indices for the positive side are present iff this bit is CLEAR.
const NO_POS: u8 = 0x04;
/// `StipplingType` omit-neg flag. Negative-side UV indices are present iff
/// this bit is CLEAR *and* the polygon is two-sided (Clockwise).
const NO_NEG: u8 = 0x08;
/// `CullMode::Clockwise` (per `ACE.Entity.Enum.CullMode`) — the two-sided
/// mode that gates negative-side UV indices.
const CULL_CLOCKWISE: i32 = 0x2;

impl DatPack for GfxObj {
    fn pack(&self) -> Result<Vec<u8>> {
        // Fail closed: validate every invariant before producing any bytes.
        validate(self)?;

        let mut buf = Vec::new();
        let mut cursor = Cursor::new(&mut buf);
        GfxObj::pack(self, &mut cursor)?;
        Ok(buf)
    }

    fn type_id(&self) -> u32 {
        // GfxObj is the portal `Model` file type (0x01). NOTE: not 0x06 —
        // an earlier recon draft mislabeled this. Source of truth is the
        // `DatFileType` enum.
        DatFileType::Model as u32
    }

    fn id(&self) -> u32 {
        self.id
    }
}

/// Run the §B.5 mesh invariants. Returns `InvariantViolation` (never
/// panics) on the first failure.
fn validate(obj: &GfxObj) -> Result<()> {
    let type_id = DatFileType::Model as u32;
    let file_id = obj.id;

    // Invariant #6 — flag/data consistency. `GfxObj::pack` reconciles the
    // BSP-presence flags itself, but the guard rejects the contradictory
    // states up front so a malformed in-memory record never silently
    // round-trips with rewritten flags.
    let has_physics = obj.flags.intersects(GfxObjFlags::HAS_PHYSICS);
    if has_physics != obj.physics_bsp.is_some() {
        return Err(violation(
            type_id,
            file_id,
            format!(
                "HAS_PHYSICS flag ({has_physics}) disagrees with physics_bsp presence ({})",
                obj.physics_bsp.is_some()
            ),
        ));
    }
    if !has_physics && !obj.physics_polygons.is_empty() {
        return Err(violation(
            type_id,
            file_id,
            format!(
                "HAS_PHYSICS clear but {} physics polygons present",
                obj.physics_polygons.len()
            ),
        ));
    }

    let has_drawing = obj.flags.intersects(GfxObjFlags::HAS_DRAWING);
    if has_drawing != obj.drawing_bsp.is_some() {
        return Err(violation(
            type_id,
            file_id,
            format!(
                "HAS_DRAWING flag ({has_drawing}) disagrees with drawing_bsp presence ({})",
                obj.drawing_bsp.is_some()
            ),
        ));
    }
    if !has_drawing && !obj.polygons.is_empty() {
        return Err(violation(
            type_id,
            file_id,
            format!(
                "HAS_DRAWING clear but {} drawing polygons present",
                obj.polygons.len()
            ),
        ));
    }

    let has_degrade = obj.flags.intersects(GfxObjFlags::HAS_DID_DEGRADE);
    if has_degrade != obj.did_degrade.is_some() {
        return Err(violation(
            type_id,
            file_id,
            format!(
                "HAS_DID_DEGRADE flag ({has_degrade}) disagrees with did_degrade presence ({})",
                obj.did_degrade.is_some()
            ),
        ));
    }

    // Invariants #1-4 — per-Polygon mesh checks across both polygon maps.
    for (which, poly) in obj
        .physics_polygons
        .iter()
        .map(|(k, p)| (("physics", *k), p))
        .chain(obj.polygons.iter().map(|(k, p)| (("drawing", *k), p)))
    {
        validate_polygon(type_id, file_id, which, poly)?;
    }

    Ok(())
}

/// §B.5 #1-4 for a single polygon. `which` is `(map, polygon_key)` for
/// error attribution.
fn validate_polygon(
    type_id: u32,
    file_id: u32,
    which: (&str, u16),
    poly: &Polygon,
) -> Result<()> {
    let (map, key) = which;
    let num_pts = poly.num_pts as usize;

    // #1 — Stippling flags: the UV-omit SEMANTICS are gated ONLY on NoPos
    // (0x04) / NoNeg (0x08), exactly mirroring `Polygon` read/write in
    // `holtburger_dat::graphics`. The Positive/Negative bits (0x01/0x02) are
    // inert pass-through wire flags (StipplingType: Positive=0x1,
    // Negative=0x2, Both=0x3 are first-class VALID values) that do NOT affect
    // UV presence; the reader/writer write `stippling` verbatim. The prior
    // buffer-overrun was a READER bug (treating 0x01/0x02 AS the omit flags),
    // already fixed in `graphics.rs`. We must NOT reject records carrying
    // 0x01/0x02 — doing so would break `pack(unpack(x))` byte round-trip for
    // every retail polygon that legitimately sets them. The load-bearing
    // guard is the 0x04/0x08-gated UV-count checks below.

    // #4 — Topology: num_pts must equal the vertex count.
    if poly.vertex_ids.len() != num_pts {
        return Err(violation(
            type_id,
            file_id,
            format!(
                "{map} polygon {key}: num_pts {num_pts} != vertex_ids.len() {}",
                poly.vertex_ids.len()
            ),
        ));
    }

    // #2/#3 — UV count gating.
    let no_pos = (poly.stippling & NO_POS) != 0;
    if no_pos {
        // NoPos set → pos UV array MUST be empty (it is not written).
        if !poly.pos_uv_indices.is_empty() {
            return Err(violation(
                type_id,
                file_id,
                format!(
                    "{map} polygon {key}: NoPos set but pos_uv_indices.len() = {} (must be 0)",
                    poly.pos_uv_indices.len()
                ),
            ));
        }
    } else if poly.pos_uv_indices.len() != num_pts {
        // NoPos clear → exactly num_pts pos UV indices.
        return Err(violation(
            type_id,
            file_id,
            format!(
                "{map} polygon {key}: NoPos clear but pos_uv_indices.len() {} != num_pts {num_pts}",
                poly.pos_uv_indices.len()
            ),
        ));
    }

    // Negative-side UVs are written ONLY when the polygon is two-sided
    // (sides_type == Clockwise 0x2) AND NoNeg is clear. Under any other
    // condition the array MUST be empty.
    let neg_emitted = poly.sides_type == CULL_CLOCKWISE && (poly.stippling & NO_NEG) == 0;
    if neg_emitted {
        if poly.neg_uv_indices.len() != num_pts {
            return Err(violation(
                type_id,
                file_id,
                format!(
                    "{map} polygon {key}: neg UVs emitted but neg_uv_indices.len() {} != num_pts {num_pts}",
                    poly.neg_uv_indices.len()
                ),
            ));
        }
    } else if !poly.neg_uv_indices.is_empty() {
        return Err(violation(
            type_id,
            file_id,
            format!(
                "{map} polygon {key}: neg UVs not emitted (sides_type=0x{:X}, NoNeg={}) \
                 but neg_uv_indices.len() = {} (must be 0)",
                poly.sides_type,
                (poly.stippling & NO_NEG) != 0,
                poly.neg_uv_indices.len()
            ),
        ));
    }

    Ok(())
}

fn violation(type_id: u32, file_id: u32, reason: String) -> WriteError {
    WriteError::InvariantViolation {
        type_id,
        file_id,
        reason,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use holtburger_common::Vector3;
    use holtburger_dat::graphics::{CVertexArray, SWVertex, Vec2Duv};
    use std::collections::HashMap;
    use std::io::Cursor;

    /// Build a structurally valid GfxObj with one drawing polygon. The
    /// polygon is one-sided (sides_type = 1, NOT Clockwise) so neg UVs are
    /// never emitted and `neg_uv_indices` is empty.
    fn valid_gfx_obj() -> GfxObj {
        let mut vertices = HashMap::new();
        vertices.insert(
            0u16,
            SWVertex {
                num_uvs: 1,
                origin: Vector3::zero(),
                normal: Vector3::zero(),
                uvs: vec![Vec2Duv { u: 0.0, v: 0.0 }],
            },
        );
        vertices.insert(
            1u16,
            SWVertex {
                num_uvs: 1,
                origin: Vector3::zero(),
                normal: Vector3::zero(),
                uvs: vec![Vec2Duv { u: 1.0, v: 0.0 }],
            },
        );
        vertices.insert(
            2u16,
            SWVertex {
                num_uvs: 1,
                origin: Vector3::zero(),
                normal: Vector3::zero(),
                uvs: vec![Vec2Duv { u: 0.0, v: 1.0 }],
            },
        );

        let mut polygons = HashMap::new();
        polygons.insert(
            0u16,
            Polygon {
                num_pts: 3,
                stippling: 0,
                sides_type: 1, // one-sided → no neg UVs
                pos_surface: 0,
                neg_surface: -1,
                vertex_ids: vec![0, 1, 2],
                pos_uv_indices: vec![0, 0, 0],
                neg_uv_indices: vec![],
            },
        );

        GfxObj {
            id: 0x0100_0042,
            // HAS_DRAWING required because drawing_bsp is Some below; no
            // physics, no degrade → flags must match presence.
            flags: GfxObjFlags::HAS_DRAWING,
            surfaces: vec![0x0800_0001, 0x0800_0002],
            vertex_array: CVertexArray {
                vertex_type: 1,
                vertices,
            },
            physics_polygons: HashMap::new(),
            physics_bsp: None,
            sort_center: Vector3::zero(),
            polygons,
            // A leaf-portal BSP node is needed so HAS_DRAWING is consistent.
            // `Polygon::read/write` and BSP round-trip are exercised by the
            // holtburger-dat tests; here we keep drawing_bsp None and clear
            // HAS_DRAWING instead so this fixture stays self-contained.
            drawing_bsp: None,
            did_degrade: None,
        }
    }

    /// The fixture above sets HAS_DRAWING but leaves drawing_bsp None, which
    /// the flag/presence guard rejects. The round-trip fixture therefore
    /// uses a no-drawing variant (flags cleared, polygon map empty) so it
    /// stays self-contained without constructing a BSP tree.
    fn valid_empty_gfx_obj() -> GfxObj {
        GfxObj {
            id: 0x0100_0043,
            flags: GfxObjFlags::NONE,
            surfaces: vec![0x0800_0001, 0x0800_0002, 0x0800_0003],
            vertex_array: CVertexArray {
                vertex_type: 1,
                vertices: HashMap::new(),
            },
            physics_polygons: HashMap::new(),
            physics_bsp: None,
            sort_center: Vector3::new(1.0, 2.0, 3.0),
            polygons: HashMap::new(),
            drawing_bsp: None,
            did_degrade: None,
        }
    }

    #[test]
    fn gfx_obj_pack_round_trips_byte_and_structurally_equal() {
        let obj = valid_empty_gfx_obj();

        // DatPack::pack → bytes (guarded path).
        let bytes = DatPack::pack(&obj).expect("valid GfxObj must pack");

        // Re-unpack and assert structural equality on every field.
        let mut cursor = Cursor::new(bytes.clone());
        let reparsed = GfxObj::unpack(&mut cursor).expect("packed bytes must re-unpack");

        assert_eq!(reparsed.id, obj.id);
        assert_eq!(reparsed.flags, obj.flags);
        assert_eq!(reparsed.surfaces, obj.surfaces);
        assert_eq!(reparsed.vertex_array.vertex_type, obj.vertex_array.vertex_type);
        assert_eq!(reparsed.vertex_array.vertices.len(), obj.vertex_array.vertices.len());
        assert_eq!(reparsed.physics_polygons.len(), 0);
        assert_eq!(reparsed.polygons.len(), 0);
        assert_eq!(reparsed.did_degrade, obj.did_degrade);

        // Byte equality: packing the re-parsed record yields the same bytes.
        let bytes2 = DatPack::pack(&reparsed).expect("re-parsed GfxObj must pack");
        assert_eq!(bytes, bytes2, "GfxObj pack must be byte-for-byte idempotent");

        assert_eq!(DatPack::type_id(&obj), DatFileType::Model as u32);
        assert_eq!(DatPack::id(&obj), 0x0100_0043);
    }

    #[test]
    fn negative_has_drawing_flag_without_bsp_is_rejected() {
        // The fixture sets HAS_DRAWING but leaves drawing_bsp None, so the
        // flag/BSP-presence guard must REJECT it (fail closed, no panic).
        // (Renamed from the misleading `gfx_obj_with_valid_textured_polygon_packs`,
        // which asserted rejection, not a successful pack.)
        let obj = valid_gfx_obj();
        let err = DatPack::pack(&obj).expect_err("HAS_DRAWING without BSP must be rejected");
        match err {
            WriteError::InvariantViolation { reason, .. } => {
                assert!(reason.contains("HAS_DRAWING"), "unexpected reason: {reason}");
            }
            other => panic!("expected InvariantViolation, got {other:?}"),
        }
    }

    #[test]
    fn gfx_obj_with_textured_polygon_and_bsp_round_trips() {
        use holtburger_dat::physics::{BspLeaf, BspNode};

        // The load-bearing GAUGE surface: a GfxObj that ACTUALLY carries a
        // UV-bearing drawing polygon + a drawing BSP, made flag-consistent so
        // the guard passes. Proves the UV-gating ACCEPT path packs and
        // re-unpacks byte-identically (covers the gap where the only
        // UV-bearing fixture was previously fed solely to a negative test).
        let mut vertices = HashMap::new();
        for (id, u, v) in [(0u16, 0.0, 0.0), (1, 1.0, 0.0), (2, 0.0, 1.0)] {
            vertices.insert(
                id,
                SWVertex {
                    num_uvs: 1,
                    origin: Vector3::zero(),
                    normal: Vector3::zero(),
                    uvs: vec![Vec2Duv { u, v }],
                },
            );
        }

        let mut polygons = HashMap::new();
        polygons.insert(
            0u16,
            Polygon {
                num_pts: 3,
                stippling: 0,  // NoPos/NoNeg clear → pos UVs present, no neg UVs
                sides_type: 1, // one-sided (not Clockwise) → no neg UVs
                pos_surface: 0,
                neg_surface: -1,
                vertex_ids: vec![0, 1, 2],
                pos_uv_indices: vec![0, 0, 0],
                neg_uv_indices: vec![],
            },
        );

        // A minimal Drawing-type leaf: round-trips as just the LEAF tag +
        // index (solid/sphere/poly_ids are only written for Physics trees).
        let drawing_bsp = Some(BspNode::Leaf(BspLeaf {
            index: 0,
            solid: 0,
            sphere: None,
            poly_ids: vec![],
        }));

        let obj = GfxObj {
            id: 0x0100_0099,
            flags: GfxObjFlags::HAS_DRAWING, // consistent with drawing_bsp Some
            surfaces: vec![0x0800_0001],
            vertex_array: CVertexArray {
                vertex_type: 1,
                vertices,
            },
            physics_polygons: HashMap::new(),
            physics_bsp: None,
            sort_center: Vector3::zero(),
            polygons,
            drawing_bsp,
            did_degrade: None,
        };

        // Guarded pack must SUCCEED on this populated, UV-bearing record.
        let bytes = DatPack::pack(&obj).expect("valid textured GfxObj must pack");

        // Re-unpack and assert the mesh survived.
        let mut cursor = Cursor::new(bytes.clone());
        let reparsed = GfxObj::unpack(&mut cursor).expect("packed bytes must re-unpack");
        assert_eq!(reparsed.polygons.len(), 1);
        let rp = reparsed.polygons.get(&0).expect("polygon 0 must survive");
        assert_eq!(rp.num_pts, 3);
        assert_eq!(rp.stippling, 0);
        assert_eq!(rp.vertex_ids, vec![0, 1, 2]);
        assert_eq!(rp.pos_uv_indices, vec![0, 0, 0]);
        assert!(rp.neg_uv_indices.is_empty());
        assert!(reparsed.drawing_bsp.is_some());

        // Byte idempotence through the guarded path.
        let bytes2 = DatPack::pack(&reparsed).expect("re-parsed GfxObj must pack");
        assert_eq!(
            bytes, bytes2,
            "textured GfxObj pack must be byte-for-byte idempotent"
        );
    }

    #[test]
    fn positive_inert_stippling_bits_are_accepted_not_rejected() {
        // The Positive (0x01) / Negative (0x02) / Both (0x03) stippling bits
        // are inert pass-through wire flags — they do NOT gate UV presence
        // (only NoPos 0x04 / NoNeg 0x08 do). The reader/writer in
        // holtburger_dat::graphics emit `stippling` verbatim, so a retail
        // polygon carrying these bits MUST pass the guard, or `pack(unpack(x))`
        // would fail to round-trip. (Regression guard for the prior version
        // that wrongly rejected 0x01/0x02.)
        for stippling in [0x01u8, 0x02, 0x03] {
            let poly = Polygon {
                num_pts: 3,
                stippling,
                sides_type: 1, // one-sided → no neg UVs
                pos_surface: 0,
                neg_surface: -1,
                vertex_ids: vec![0, 1, 2],
                pos_uv_indices: vec![0, 0, 0], // NoPos clear → present
                neg_uv_indices: vec![],
            };
            validate_polygon(DatFileType::Model as u32, 0x0100_0001, ("drawing", 0), &poly)
                .unwrap_or_else(|e| {
                    panic!("inert stippling 0x{stippling:02X} must be accepted, got {e:?}")
                });
        }

        // Combined with the real omit flags it must still be accepted, with
        // the omit semantics gated only on 0x04/0x08. NoPos (0x04) | Positive
        // (0x01): pos UVs omitted (empty), Positive bit inert.
        let poly = Polygon {
            num_pts: 3,
            stippling: NO_POS | 0x01,
            sides_type: 1,
            pos_surface: 0,
            neg_surface: -1,
            vertex_ids: vec![0, 1, 2],
            pos_uv_indices: vec![], // NoPos set → must be empty
            neg_uv_indices: vec![],
        };
        validate_polygon(DatFileType::Model as u32, 0x0100_0001, ("drawing", 0), &poly)
            .expect("NoPos|Positive with empty pos UVs must be accepted");
    }

    #[test]
    fn negative_uv_count_mismatch_is_rejected_not_panicked() {
        // NoPos clear but pos_uv_indices.len() != num_pts → InvariantViolation.
        let poly = Polygon {
            num_pts: 3,
            stippling: 0,
            sides_type: 1,
            pos_surface: 0,
            neg_surface: -1,
            vertex_ids: vec![0, 1, 2],
            pos_uv_indices: vec![0, 0], // WRONG: 2 != 3
            neg_uv_indices: vec![],
        };
        let err = validate_polygon(DatFileType::Model as u32, 0x0100_0001, ("drawing", 0), &poly)
            .expect_err("UV count mismatch must be rejected");
        assert!(matches!(err, WriteError::InvariantViolation { .. }));
    }

    #[test]
    fn negative_neg_uvs_under_non_clockwise_sides_type_is_rejected() {
        // neg_uv_indices populated but sides_type is NOT Clockwise (0x2) →
        // neg UVs are not emitted, so a non-empty array must be rejected.
        let poly = Polygon {
            num_pts: 3,
            stippling: 0,
            sides_type: 1, // one-sided, NOT Clockwise
            pos_surface: 0,
            neg_surface: 0,
            vertex_ids: vec![0, 1, 2],
            pos_uv_indices: vec![0, 0, 0],
            neg_uv_indices: vec![0, 0, 0], // WRONG under one-sided
        };
        let err = validate_polygon(DatFileType::Model as u32, 0x0100_0001, ("drawing", 0), &poly)
            .expect_err("neg UVs under non-Clockwise sides_type must be rejected");
        match err {
            WriteError::InvariantViolation { reason, .. } => {
                assert!(reason.contains("neg UVs not emitted"), "reason: {reason}");
            }
            other => panic!("expected InvariantViolation, got {other:?}"),
        }
    }

    #[test]
    fn negative_topology_mismatch_is_rejected() {
        let poly = Polygon {
            num_pts: 4,
            stippling: NO_POS,
            sides_type: 1,
            pos_surface: 0,
            neg_surface: 0,
            vertex_ids: vec![0, 1, 2], // WRONG: 3 != 4
            pos_uv_indices: vec![],
            neg_uv_indices: vec![],
        };
        let err = validate_polygon(DatFileType::Model as u32, 0x0100_0001, ("drawing", 0), &poly)
            .expect_err("topology mismatch must be rejected");
        match err {
            WriteError::InvariantViolation { reason, .. } => {
                assert!(reason.contains("num_pts"), "reason: {reason}");
            }
            other => panic!("expected InvariantViolation, got {other:?}"),
        }
    }
}
