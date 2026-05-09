//! Environment (`0x0D…`) — interior cell geometry referenced by
//! [`super::env_cell::EnvCell::environment_id`].
//!
//! An Environment record is a list of `CellStruct` entries. Each cell
//! is a chunk of mesh data: a vertex array, drawing polygons (the
//! triangles you see), portal poly indices (faces that connect to other
//! cells), physics polygons (collision-only triangles), and three BSP
//! trees (cell-classifier, drawing, physics). Phase 6 step C only
//! consumes drawing polygons + the vertex array — that's the geometry
//! the browser renders. Physics + BSP fields are parsed for wire-
//! compatibility (the BSP byte runs sit in the middle of the cell, so
//! we have to walk them to find the next cell), but the data is
//! discarded after parse since holtburger-web does swept-AABB collision
//! out of the building AABB index, not BSP intersection.
//!
//! Format reference: PhatSDK `external/GDL/PhatSDK/Environment.{h,cpp}`
//! (CEnvironment + CCellStruct) and DatReaderWriter
//! `EnvironmentTests.cs::CanReadEOREnvironments` for a parse-and-assert
//! example. ACE-side mirror at
//! `external/ACE/Source/ACE.Server/Physics/Common/CellStruct.cs`.

use crate::graphics::{CVertexArray, Polygon};
use crate::physics::{BspNode, BspType};
use binrw::{
    BinRead, BinResult,
    io::{Read, Seek, SeekFrom},
};
use std::collections::HashMap;

/// One cell within an [`Environment`]. `polygons` are the drawing
/// faces — that's what the renderer triangulates.
#[derive(Debug, Clone)]
pub struct CellStruct {
    pub cell_struct_id: u32,
    pub vertex_array: CVertexArray,
    pub polygons: HashMap<u16, Polygon>,
    /// Polygon ids (keys into `polygons`) that act as portals to
    /// other EnvCells. Phase D will diff these against the per-cell
    /// portal graph; Phase C just keeps them for shape parity.
    pub portal_poly_ids: Vec<u16>,
    pub physics_polygons: HashMap<u16, Polygon>,
    pub cell_bsp: Option<BspNode>,
    pub physics_bsp: Option<BspNode>,
    pub drawing_bsp: Option<BspNode>,
}

#[derive(Debug, Clone)]
pub struct Environment {
    pub id: u32,
    pub cells: HashMap<u32, CellStruct>,
}

impl Environment {
    pub fn unpack<R: Read + Seek>(reader: &mut R) -> BinResult<Self> {
        let id = u32::read_le(reader)?;
        let num_cells = u32::read_le(reader)?;

        let mut cells = HashMap::with_capacity(num_cells as usize);
        for _ in 0..num_cells {
            let cell = CellStruct::unpack(reader)?;
            cells.insert(cell.cell_struct_id, cell);
        }

        Ok(Environment { id, cells })
    }
}

impl CellStruct {
    pub fn unpack<R: Read + Seek>(reader: &mut R) -> BinResult<Self> {
        let cell_struct_id = u32::read_le(reader)?;

        let num_polygons = u32::read_le(reader)?;
        let num_physics_polygons = u32::read_le(reader)?;
        let num_portals = u32::read_le(reader)?;

        let vertex_array = CVertexArray::read_le(reader)?;

        // Drawing polygons in Environment cells use the same wire
        // shape as GfxObj's drawing polys: a `u16 poly_id` prefix
        // followed by a `Polygon` body. Mirrors `gfx_obj.rs`'s read.
        // PhatSDK's `Polygon::UnPack` reads poly_id as the first
        // `short`; the existing `Polygon::read_le` here intentionally
        // skips that — gfx_obj/env_cell hosts read it explicitly.
        let mut polygons = HashMap::with_capacity(num_polygons as usize);
        for _ in 0..num_polygons {
            let poly_id = u16::read_le(reader)?;
            let poly = Polygon::read_le(reader)?;
            polygons.insert(poly_id, poly);
        }

        let mut portal_poly_ids = Vec::with_capacity(num_portals as usize);
        for _ in 0..num_portals {
            portal_poly_ids.push(u16::read_le(reader)?);
        }

        // PhatSDK PACK_ALIGN() — 4-byte alignment after the variable
        // portal section before the cell BSP. Polygons themselves are
        // not packaligned in the EOR format (mirrors gfx_obj.rs's
        // tight read), but the cell's portal block may leave a 2-byte
        // odd-tail on `num_portals % 2 == 1`.
        align_to_4(reader)?;

        let cell_bsp = Some(BspNode::read(reader, BspType::Cell)?);

        let mut physics_polygons = HashMap::with_capacity(num_physics_polygons as usize);
        for _ in 0..num_physics_polygons {
            let poly_id = u16::read_le(reader)?;
            let poly = Polygon::read_le(reader)?;
            physics_polygons.insert(poly_id, poly);
        }

        let physics_bsp = Some(BspNode::read(reader, BspType::Physics)?);

        // Pre-TOD layout would PACK_ALIGN here; CFTOD/EOR doesn't.
        // PhatSDK guards the LastField branch behind
        // `!PHATSDK_USE_EXTENDED_CELL_DATA`. The retail (EOR) build is
        // !EXTENDED, so the LastField sentinel + optional drawing BSP
        // ARE present.
        let last_field = u32::read_le(reader)?;
        let drawing_bsp = if last_field != 0 {
            Some(BspNode::read(reader, BspType::Drawing)?)
        } else {
            None
        };

        align_to_4(reader)?;

        Ok(CellStruct {
            cell_struct_id,
            vertex_array,
            polygons,
            portal_poly_ids,
            physics_polygons,
            cell_bsp,
            physics_bsp,
            drawing_bsp,
        })
    }
}

/// Advance `reader` to the next 4-byte boundary. Mirrors PhatSDK's
/// `PACK_ALIGN()` macro. The Environment / CellStruct format has two
/// alignment points (after the portal id list, after the optional
/// drawing BSP); calling at any other position is a no-op when the
/// cursor already sits on a 4-byte mark.
fn align_to_4<R: Read + Seek>(reader: &mut R) -> BinResult<()> {
    let pos = reader.stream_position()?;
    let pad = (4 - (pos % 4)) % 4;
    if pad != 0 {
        reader.seek(SeekFrom::Current(pad as i64))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graphics::{Polygon, Vec2Duv};
    use binrw::BinWrite;
    use holtburger_common::Vector3;
    use std::io::{Cursor, Write};

    /// Synthesize a minimal Environment with one cell containing a
    /// single triangle and two vertices, then round-trip it through
    /// `Environment::unpack`. Validates the layout end-to-end without a
    /// retail DAT.
    #[test]
    fn unpack_synthetic_single_cell_triangle() {
        let mut data: Vec<u8> = Vec::new();
        let mut writer = Cursor::new(&mut data);

        // Environment header.
        0x0D00_0001u32.write_le(&mut writer).unwrap();
        1u32.write_le(&mut writer).unwrap();

        // CellStruct header (4 + 4 + 4 + 4 = 16 bytes — already aligned).
        0u32.write_le(&mut writer).unwrap(); // cell_struct_id
        1u32.write_le(&mut writer).unwrap(); // num_polygons
        0u32.write_le(&mut writer).unwrap(); // num_physics_polygons
        0u32.write_le(&mut writer).unwrap(); // num_portals

        // VertexArray: type=1, 3 vertices (a triangle).
        1i32.write_le(&mut writer).unwrap(); // vertex_type
        3u32.write_le(&mut writer).unwrap(); // num_vertices
        for (vid, (x, y, z)) in [(0u16, (0.0f32, 0.0f32, 0.0f32)), (1, (1.0, 0.0, 0.0)), (2, (0.0, 1.0, 0.0))] {
            vid.write_le(&mut writer).unwrap();
            // SWVertex: num_uvs=1, origin, normal, uvs.
            1u16.write_le(&mut writer).unwrap();
            Vector3 { x, y, z }.write_le(&mut writer).unwrap();
            Vector3 { x: 0.0, y: 0.0, z: 1.0 }.write_le(&mut writer).unwrap();
            Vec2Duv { u: 0.0, v: 0.0 }.write_le(&mut writer).unwrap();
        }

        // One Polygon: 3 verts, no stippling, sides_type=Clockwise (2),
        // surfaces 0/-1, vertex_ids [0,1,2], pos_uv_indices [0,0,0].
        // Stippling=0 means NoPos NOT set → pos_uvs read; sides_type
        // Clockwise + NoNeg NOT set → neg_uvs read.
        let poly = Polygon {
            num_pts: 3,
            stippling: 0,
            sides_type: 2,
            pos_surface: 0,
            neg_surface: -1,
            vertex_ids: vec![0, 1, 2],
            pos_uv_indices: vec![0, 0, 0],
            neg_uv_indices: vec![0, 0, 0],
        };
        // Drawing polygons in Environment cells carry an explicit
        // `u16 poly_id` prefix (mirrors PhatSDK and gfx_obj.rs).
        0u16.write_le(&mut writer).unwrap();
        poly.write_le(&mut writer).unwrap();
        align_to_4(&mut writer).unwrap();

        // Cell BSP: a single LEAF (cell type, no extra fields).
        writer.write_all(b"FAEL").unwrap(); // "LEAF" reversed
        0i32.write_le(&mut writer).unwrap(); // index

        // Physics BSP: a single LEAF (physics type, with solid + sphere + poly_ids).
        writer.write_all(b"FAEL").unwrap();
        0i32.write_le(&mut writer).unwrap(); // index
        0i32.write_le(&mut writer).unwrap(); // solid
        0.0f32.write_le(&mut writer).unwrap(); // sphere center.x
        0.0f32.write_le(&mut writer).unwrap(); // sphere center.y
        0.0f32.write_le(&mut writer).unwrap(); // sphere center.z
        0.0f32.write_le(&mut writer).unwrap(); // sphere radius
        0u32.write_le(&mut writer).unwrap(); // num_polys

        // LastField = 0 → no drawing BSP.
        0u32.write_le(&mut writer).unwrap();
        align_to_4(&mut writer).unwrap();

        let mut cursor = Cursor::new(&data);
        let env = Environment::unpack(&mut cursor).unwrap();
        assert_eq!(env.id, 0x0D00_0001);
        assert_eq!(env.cells.len(), 1);
        let cell = &env.cells[&0];
        assert_eq!(cell.polygons.len(), 1);
        assert_eq!(cell.vertex_array.vertices.len(), 3);
        let v0 = &cell.vertex_array.vertices[&0];
        assert_eq!(v0.origin, Vector3 { x: 0.0, y: 0.0, z: 0.0 });
        let _ = v0.uvs[0]; // SWVertex round-trip carries UV.
        assert!(cell.cell_bsp.is_some());
        assert!(cell.physics_bsp.is_some());
        assert!(cell.drawing_bsp.is_none());
    }

    /// Skipped when `HOLTBURGER_PORTAL_DAT` is unset. Mirrors the
    /// canonical DatReaderWriter `EnvironmentTests::CanReadEOREnvironments`
    /// case: read `0x0D00062E`, verify exactly 1 cell with 8 vertices,
    /// 6 drawing polygons, 6 physics polygons, and the first vertex's
    /// origin matches `(4, -0.6, 1.8)`. Catches format-drift in the
    /// CellStruct unpack against retail bytes.
    #[test]
    fn unpack_eor_0x0d00062e_matches_dat_reader_writer() {
        use crate::DatDatabase;
        let Some(path) = crate::utils::get_portal_dat_path() else {
            return;
        };
        let dat = match DatDatabase::new(&path) {
            Ok(d) => d,
            Err(_) => return,
        };
        let bytes = match dat.get_file(0x0D00_062E) {
            Ok(b) => b,
            Err(_) => return,
        };
        let env = Environment::unpack(&mut Cursor::new(&bytes))
            .expect("EnvCell 0x0D00062E should unpack");
        assert_eq!(env.cells.len(), 1);
        let cell = &env.cells[&0];
        assert_eq!(cell.vertex_array.vertices.len(), 8);
        assert_eq!(cell.polygons.len(), 6);
        assert_eq!(cell.physics_polygons.len(), 6);
        let v0 = &cell.vertex_array.vertices[&0];
        assert_eq!(v0.origin, Vector3 { x: 4.0, y: -0.6, z: 1.8 });
    }

    /// Skipped when `HOLTBURGER_PORTAL_DAT` is unset. A second-row
    /// retail record check — same DIDs the DatReaderWriter
    /// `CanReadEORAndWriteIdentical` test uses. Confirms the parser
    /// handles records of varying shapes (different cell count, varying
    /// polygon counts, different vertex/portal ratios) without
    /// mis-reading any field. We don't assert specific counts here
    /// because the canonical DRW source doesn't pin them; the smoke
    /// of "no parse errors" is the contract.
    #[test]
    fn unpack_eor_misc_retail_environments() {
        use crate::DatDatabase;
        let Some(path) = crate::utils::get_portal_dat_path() else {
            return;
        };
        let dat = match DatDatabase::new(&path) {
            Ok(d) => d,
            Err(_) => return,
        };
        for &id in &[0x0D00_0098u32, 0x0D00_03B5, 0x0D00_0444] {
            let bytes = match dat.get_file(id) {
                Ok(b) => b,
                Err(_) => continue,
            };
            let env = Environment::unpack(&mut Cursor::new(&bytes))
                .unwrap_or_else(|e| panic!("Environment {id:#010X} unpack failed: {e}"));
            assert!(!env.cells.is_empty(), "no cells in env {id:#010X}");
        }
    }
}
