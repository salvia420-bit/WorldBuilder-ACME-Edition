use binrw::{
    BinRead, BinWrite,
    io::{Read, Seek, Write},
};
use holtburger_common::{Quaternion, Vector3};
use std::collections::HashMap;

#[derive(BinRead, BinWrite, Debug, Clone, Default, PartialEq, serde::Serialize)]
#[br(little)]
#[bw(little)]
pub struct Frame {
    pub origin: Vector3,
    pub orientation: Quaternion,
}

#[derive(BinRead, BinWrite, Debug, Clone, serde::Serialize)]
#[br(little)]
#[bw(little)]
pub struct SWVertex {
    pub num_uvs: u16,
    pub origin: Vector3,
    pub normal: Vector3,
    #[br(count = num_uvs)]
    pub uvs: Vec<Vec2Duv>,
}

#[derive(BinRead, BinWrite, Debug, Clone, Copy, serde::Serialize)]
#[br(little)]
#[bw(little)]
pub struct Vec2Duv {
    pub u: f32,
    pub v: f32,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct CVertexArray {
    pub vertex_type: i32,
    pub vertices: HashMap<u16, SWVertex>,
}

impl CVertexArray {
    pub fn new() -> Self {
        Self {
            vertex_type: 1,
            vertices: HashMap::new(),
        }
    }
}

impl Default for CVertexArray {
    fn default() -> Self {
        Self::new()
    }
}

impl CVertexArray {
    /// Prune vertex data, keeping only origin points for physics.
    pub fn prune(&mut self, kept_ids: &std::collections::HashSet<u16>) {
        // 1. Remove vertices not used by physics
        self.vertices.retain(|id, _| kept_ids.contains(id));

        // 2. Strip visual bloat from remaining vertices
        for vertex in self.vertices.values_mut() {
            vertex.num_uvs = 0;
            vertex.uvs = Vec::new();
            vertex.normal = Vector3::zero();
        }
    }
}

impl BinRead for CVertexArray {
    type Args<'a> = ();

    fn read_options<R: Read + Seek>(
        reader: &mut R,
        _endian: binrw::Endian,
        _args: Self::Args<'_>,
    ) -> binrw::BinResult<Self> {
        let vertex_type = i32::read_le(reader)?;
        let num_vertices = u32::read_le(reader)?;
        let mut vertices = HashMap::new();

        if vertex_type == 1 {
            for _ in 0..num_vertices {
                let id = u16::read_le(reader)?;
                let vertex = SWVertex::read_le(reader)?;
                vertices.insert(id, vertex);
            }
        }

        Ok(CVertexArray {
            vertex_type,
            vertices,
        })
    }
}

impl BinWrite for CVertexArray {
    type Args<'a> = ();

    fn write_options<W: Write + Seek>(
        &self,
        writer: &mut W,
        _endian: binrw::Endian,
        _args: Self::Args<'_>,
    ) -> binrw::BinResult<()> {
        self.vertex_type.write_le(writer)?;
        (self.vertices.len() as u32).write_le(writer)?;

        if self.vertex_type == 1 {
            // Sort keys for deterministic output
            let mut keys: Vec<_> = self.vertices.keys().collect();
            keys.sort();
            for &id in keys {
                id.write_le(writer)?;
                self.vertices.get(&id).unwrap().write_le(writer)?;
            }
        }

        Ok(())
    }
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct Polygon {
    pub num_pts: u8,
    pub stippling: u8,
    pub sides_type: i32,
    pub pos_surface: i16,
    pub neg_surface: i16,
    pub vertex_ids: Vec<i16>,
    pub pos_uv_indices: Vec<u8>,
    pub neg_uv_indices: Vec<u8>,
}

impl BinRead for Polygon {
    type Args<'a> = ();

    fn read_options<R: Read + Seek>(
        reader: &mut R,
        _endian: binrw::Endian,
        _args: Self::Args<'_>,
    ) -> binrw::BinResult<Self> {
        let num_pts = u8::read(reader)?;
        let stippling = u8::read(reader)?;
        let sides_type = i32::read_le(reader)?;
        let pos_surface = i16::read_le(reader)?;
        let neg_surface = i16::read_le(reader)?;

        let mut vertex_ids = Vec::with_capacity(num_pts as usize);
        for _ in 0..num_pts {
            vertex_ids.push(i16::read_le(reader)?);
        }

        // StipplingType flag values (per ACE.Entity.Enum.StipplingType):
        //   None=0x0, Positive=0x1, Negative=0x2, Both=0x3,
        //   NoPos=0x4, NoNeg=0x8, NoUVS=0x14.
        // CullMode (per ACE.Entity.Enum.CullMode):
        //   Landblock=0x0, None=0x1, Clockwise=0x2, CounterClockwise=0x3.
        // Pos UV indices read iff NoPos (0x4) is NOT set; Neg UV indices
        // read iff sides_type == Clockwise (0x2) AND NoNeg (0x8) NOT set.
        // Earlier port confused these with `Positive`/`Negative` (0x1/0x2)
        // and `CullMode::None` (0x1) respectively, which silently
        // mis-read every retail polygon whose Stippling bit 0x01 was set
        // (Positive flag) — falling through to a buffer-overrun later in
        // the GfxObj record.
        const NO_POS: u8 = 0x04;
        const NO_NEG: u8 = 0x08;
        const CULL_CLOCKWISE: i32 = 0x2;

        let mut pos_uv_indices = Vec::new();
        if (stippling & NO_POS) == 0 {
            for _ in 0..num_pts {
                pos_uv_indices.push(u8::read(reader)?);
            }
        }

        let mut neg_uv_indices = Vec::new();
        if sides_type == CULL_CLOCKWISE && (stippling & NO_NEG) == 0 {
            for _ in 0..num_pts {
                neg_uv_indices.push(u8::read(reader)?);
            }
        }

        Ok(Polygon {
            num_pts,
            stippling,
            sides_type,
            pos_surface,
            neg_surface,
            vertex_ids,
            pos_uv_indices,
            neg_uv_indices,
        })
    }
}

/// Which side of a [`Polygon`] a stipple query is about. `Positive` is the
/// front (`pos_surface`/`pos_uv_indices`) side, `Negative` the back.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PolygonSide {
    Positive,
    Negative,
}

impl Polygon {
    /// RND-33 — the texture-address mode retail derives from this polygon's
    /// `Stippling` byte, per `D3DPolyRender::SetSurface(CPolygon*, Sidedness,
    /// int)` (`acclient.c:455236`): the `stippled` argument it forwards is
    /// `stippling & 1` for the positive side and `stippling & 2` for the
    /// negative side. `D3DPolyRender::SetSurface(CSurface*, bool stippled, …)`
    /// (`acclient.c:454385`) then selects `TEXADDRESS_WRAP` when stippled and
    /// `TEXADDRESS_CLAMP` otherwise, on sampler stage 0 U **and** V.
    ///
    /// NOT the Surface type's `STIPPLED` bit (`acclient.h:5833`, 0x40000000) —
    /// that flag is derived state `SetSurface` writes back into
    /// `Render::curr_surface_type`, never a source.
    pub fn stipple_wraps(&self, side: PolygonSide) -> bool {
        let bit = match side {
            PolygonSide::Positive => 0x1,
            PolygonSide::Negative => 0x2,
        };
        (self.stippling & bit) != 0
    }

    /// RND-33 — the same question as [`Polygon::stipple_wraps`] but as the
    /// BATCHED mesh-buffer path asks it. `DrawMesh` (`acclient.c:454676`)
    /// passes `isStippledOrAlphaedMask[subsetNum] & 1`, and bit 0 of that mask
    /// is accumulated at `acclient.c:456003` as
    /// `mask[subset] |= (stippling > 0)` — the WHOLE byte, side-agnostic, so it
    /// also catches the `NoPos` (0x4) / `NoNeg` (0x8) UV-layout bits that
    /// `stipple_wraps` excludes. Kept distinct because the two retail paths do
    /// not agree and a consumer must pick deliberately.
    pub fn stipple_wraps_meshbuffer(&self) -> bool {
        self.stippling > 0
    }
}

impl BinWrite for Polygon {
    type Args<'a> = ();

    fn write_options<W: Write + Seek>(
        &self,
        writer: &mut W,
        _endian: binrw::Endian,
        _args: Self::Args<'_>,
    ) -> binrw::BinResult<()> {
        self.num_pts.write(writer)?;
        self.stippling.write(writer)?;
        self.sides_type.write_le(writer)?;
        self.pos_surface.write_le(writer)?;
        self.neg_surface.write_le(writer)?;

        for &id in &self.vertex_ids {
            id.write_le(writer)?;
        }

        // Mirror the read-side flag interpretation: NoPos=0x4, NoNeg=0x8,
        // CullMode::Clockwise=0x2.
        const NO_POS: u8 = 0x04;
        const NO_NEG: u8 = 0x08;
        const CULL_CLOCKWISE: i32 = 0x2;

        if (self.stippling & NO_POS) == 0 {
            for &idx in &self.pos_uv_indices {
                idx.write(writer)?;
            }
        }

        if self.sides_type == CULL_CLOCKWISE && (self.stippling & NO_NEG) == 0 {
            for &idx in &self.neg_uv_indices {
                idx.write(writer)?;
            }
        }

        Ok(())
    }
}
