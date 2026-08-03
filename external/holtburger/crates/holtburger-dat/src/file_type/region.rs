//! Region DBObj (`0x13000000`..`0x1300FFFF`) — defines the realm's terrain
//! envelope, skybox, sounds, ambient scenes, and in-world clock.
//!
//! Schema reference: `external/DatReaderWriter/DatReaderWriter/dats.xml:3847-3877`
//! for the outer `Region` shape, `dats.xml:2807-2855` for the SkyDesc cluster,
//! `dats.xml:2769-2806` for `LandDefs`/`GameTime`, and `dats.xml:2883-2941` for
//! `TerrainDesc`/`RegionMisc`. Cross-checked against the C++ UnPack methods in
//! `external/GDL/PhatSDK/SkyDesc.cpp:32-237`.
//!
//! Workstream A of the parametric-skybox push: this is the upstream blocker
//! that lets `holtburger-web` walk Region 1's SkyInfo → DayGroup → SkyObject
//! chain to discover the GfxObj DIDs for the celestial billboards.
//!
//! ## PartsMask
//!
//! Per `dats.xml:157-162`:
//!
//! - `HasSoundInfo  = 0x01`
//! - `HasSceneInfo  = 0x02`
//! - `HasSkyInfo    = 0x10`
//! - `HasRegionMisc = 0x200`
//!
//! The four optional sub-records appear *in the wire order*
//! `[SkyInfo, SoundInfo, SceneInfo, TerrainInfo, RegionMisc]` *not* in mask-bit
//! order — `SkyInfo` (bit `0x10`) is emitted FIRST even though its bit value is
//! higher than `SoundInfo`'s (`0x01`). Each is gated on its specific bit and
//! `TerrainInfo` is unconditional. This matches `Region::unpack`/`Region::pack`
//! and PhatSDK `RegionDesc.cpp:268-306`.

use crate::file_type::game_time::GameTime;
use crate::utils::{align_boundary, read_pstring_char};
use binrw::{
    BinRead, BinResult,
    io::{Read, Seek},
};

/// Write a `PStringBase<char>` into `out` — the exact inverse of
/// [`crate::utils::read_pstring_char`] (the primitive every Region/GameTime
/// string is read with). Wire format per `acclient.c:296509-296568`:
///
/// ```text
///   u16 length                  (if length >= 0xFFFF, write 0xFFFF then u32 length)
///   length × Windows-1252 bytes
///   pad with 0x00 to the next 4-byte boundary
/// ```
///
/// The 4-byte align-pad is computed from `out.len()` (the absolute stream
/// offset, since a whole-record pack always starts the buffer at offset 0).
/// This MUST match the reader's `align_boundary(4)` so the cursor lands on
/// the same offset after a round-trip — an off-by-4 here silently corrupts
/// every subsequent field. `read_pstring_char` strips trailing NULs on the
/// way in, so this is a lossless inverse *iff the source string carried no
/// trailing NUL* — retail Region/GameTime strings carry none, so the
/// encode → pad path reproduces the original bytes exactly. (A NUL-bearing
/// fixture would re-pack with a shorter `len`; the current parser cannot
/// represent one anyway.)
pub(crate) fn write_pstring_char(out: &mut Vec<u8>, s: &str) {
    let (bytes, _, _) = encoding_rs::WINDOWS_1252.encode(s);
    let len = bytes.len();
    if len < 0xFFFF {
        out.extend_from_slice(&(len as u16).to_le_bytes());
    } else {
        // 0xFFFF u16 sentinel → extended u32 length (mirrors the reader's
        // `if len_u16 == 0xFFFF { read u32 }` escape).
        out.extend_from_slice(&0xFFFFu16.to_le_bytes());
        out.extend_from_slice(&(len as u32).to_le_bytes());
    }
    out.extend_from_slice(&bytes);
    // Pad to the next 4-byte boundary (reader does align_boundary(4)).
    while out.len() % 4 != 0 {
        out.push(0);
    }
}

/// `PartsMask & HasSoundInfo` — Region carries `SoundDesc`.
pub const PARTS_MASK_HAS_SOUND_INFO: u32 = 0x0000_0001;
/// `PartsMask & HasSceneInfo` — Region carries `SceneDesc`.
pub const PARTS_MASK_HAS_SCENE_INFO: u32 = 0x0000_0002;
/// `PartsMask & HasSkyInfo` — Region carries `SkyDesc`. Load-bearing for
/// the parametric-skybox pipeline.
pub const PARTS_MASK_HAS_SKY_INFO: u32 = 0x0000_0010;
/// `PartsMask & HasRegionMisc` — Region carries `RegionMisc` after
/// `TerrainInfo`.
pub const PARTS_MASK_HAS_REGION_MISC: u32 = 0x0000_0200;

/// AC's terrain bounds + grid sizing (LandDefs). All eight scalar fields plus
/// a 256-entry land-height lookup table. `SkyHeight` here is the *terrain*
/// fog cap, **not** the skybox dome — the skybox is in `SkyDesc`.
#[derive(Debug, Clone, serde::Serialize)]
pub struct LandDefs {
    pub num_block_length: i32,
    pub num_block_width: i32,
    pub square_length: f32,
    pub l_block_length: i32,
    pub vertex_per_cell: i32,
    pub max_obj_height: f32,
    pub sky_height: f32,
    pub road_width: f32,
    pub land_height_table: Vec<f32>,
}

impl LandDefs {
    pub fn unpack<R: Read + Seek>(reader: &mut R) -> BinResult<Self> {
        let num_block_length = i32::read_le(reader)?;
        let num_block_width = i32::read_le(reader)?;
        let square_length = f32::read_le(reader)?;
        let l_block_length = i32::read_le(reader)?;
        let vertex_per_cell = i32::read_le(reader)?;
        let max_obj_height = f32::read_le(reader)?;
        let sky_height = f32::read_le(reader)?;
        let road_width = f32::read_le(reader)?;

        let mut land_height_table = Vec::with_capacity(256);
        for _ in 0..256 {
            land_height_table.push(f32::read_le(reader)?);
        }

        Ok(LandDefs {
            num_block_length,
            num_block_width,
            square_length,
            l_block_length,
            vertex_per_cell,
            max_obj_height,
            sky_height,
            road_width,
            land_height_table,
        })
    }

    /// Reverse of [`LandDefs::unpack`] — the eight scalar fields in their
    /// exact read order (i32/f32 mixed per the struct), followed by all 256
    /// `f32` land-height-table entries. No alignment is involved (every field
    /// is a 4-byte payload).
    pub fn pack(&self, out: &mut Vec<u8>) {
        out.extend_from_slice(&self.num_block_length.to_le_bytes());
        out.extend_from_slice(&self.num_block_width.to_le_bytes());
        out.extend_from_slice(&self.square_length.to_le_bytes());
        out.extend_from_slice(&self.l_block_length.to_le_bytes());
        out.extend_from_slice(&self.vertex_per_cell.to_le_bytes());
        out.extend_from_slice(&self.max_obj_height.to_le_bytes());
        out.extend_from_slice(&self.sky_height.to_le_bytes());
        out.extend_from_slice(&self.road_width.to_le_bytes());
        for h in &self.land_height_table {
            out.extend_from_slice(&h.to_le_bytes());
        }
    }
}

/// Top-level skybox descriptor — owns N DayGroups (one is active per in-world
/// day; selector hashes `current_day`/`current_year` against `num_day_groups`).
#[derive(Debug, Clone, serde::Serialize)]
pub struct SkyDesc {
    /// Seconds-per-tick for SkyObject motion (default 3.0 per PhatSDK).
    pub tick_size: f64,
    /// Seconds-per-tick for SkyTimeOfDay light interpolation (default 20.0).
    pub light_tick_size: f64,
    pub day_groups: Vec<DayGroup>,
}

impl SkyDesc {
    pub fn unpack<R: Read + Seek>(reader: &mut R) -> BinResult<Self> {
        let tick_size = f64::read_le(reader)?;
        let light_tick_size = f64::read_le(reader)?;
        // PhatSDK SkyDesc.cpp:37 calls `pReader->ReadAlign()` here. The
        // doubles above are 8-byte payloads which leave the cursor 4-byte
        // aligned already (8 is a multiple of 4), so the align is a no-op
        // on typical inputs — but we mirror it for parity in case a
        // future schema revision lands here mid-stream at an odd offset.
        align_boundary(reader, 4)?;

        // Rust review 2026-08-03 (F6): every `with_capacity(N as usize)` in this
        // file reserved straight off an unvalidated wire u32. Region 0x13000000
        // is parsed at BOOT on every client, so a corrupt/hostile shard could
        // abort the module before login with a multi-GB reservation. Each of the
        // 14 sites now routes through `utils::safe_capacity` with a 4-byte
        // minimum element size (every sub-struct here begins with at least a u32
        // or a length-prefixed string). The loops still iterate the real wire
        // count and still fail cleanly at EOF via `?` — parse semantics unchanged.
        let num_day_groups = u32::read_le(reader)?;
        let mut day_groups =
            Vec::with_capacity(crate::utils::safe_capacity(reader, num_day_groups as usize, 4)?);
        for _ in 0..num_day_groups {
            day_groups.push(DayGroup::unpack(reader)?);
        }

        Ok(SkyDesc {
            tick_size,
            light_tick_size,
            day_groups,
        })
    }

    /// Reverse of [`SkyDesc::unpack`] — `f64 tick_size`, `f64
    /// light_tick_size`, the `align_boundary(4)` pad (a no-op after 16 bytes
    /// of doubles, mirrored for parity with PhatSDK SkyDesc.cpp:37), `u32
    /// num_day_groups`, then that many [`DayGroup`].
    pub fn pack(&self, out: &mut Vec<u8>) {
        out.extend_from_slice(&self.tick_size.to_le_bytes());
        out.extend_from_slice(&self.light_tick_size.to_le_bytes());
        // PhatSDK SkyDesc.cpp:37 ReadAlign — mirror align_boundary(4).
        while out.len() % 4 != 0 {
            out.push(0);
        }
        out.extend_from_slice(&(self.day_groups.len() as u32).to_le_bytes());
        for dg in &self.day_groups {
            dg.pack(out);
        }
    }
}

/// One in-world day archetype (e.g. "Clear", "Cloudy", "Rainy"). Owns its
/// celestial fleet (`sky_objects`) + lighting keyframes (`sky_time`).
#[derive(Debug, Clone, serde::Serialize)]
pub struct DayGroup {
    /// Per-day random weight. Used by `SkyDesc::CalcPresentDayGroup`'s LCG
    /// hash (see PhatSDK `SkyDesc.cpp:52-71`).
    pub chance_of_occur: f32,
    pub day_name: String,
    pub sky_objects: Vec<SkyObject>,
    pub sky_time: Vec<SkyTimeOfDay>,
}

impl DayGroup {
    pub fn unpack<R: Read + Seek>(reader: &mut R) -> BinResult<Self> {
        let chance_of_occur = f32::read_le(reader)?;
        let day_name = read_pstring_char(reader)?;

        // PhatSDK SkyDesc.cpp:117-125 — SkyObjects come BEFORE SkyTime
        // (counter-intuitive, but matches both the schema and the C++
        // UnPack). The order matters because each SkyTimeOfDay's
        // SkyObjectReplace entries are back-referenced to a SkyObject
        // index from this array.
        let num_sky_objects = u32::read_le(reader)?;
        let mut sky_objects =
            Vec::with_capacity(crate::utils::safe_capacity(reader, num_sky_objects as usize, 4)?);
        for _ in 0..num_sky_objects {
            sky_objects.push(SkyObject::unpack(reader)?);
        }

        let num_sky_time = u32::read_le(reader)?;
        let mut sky_time =
            Vec::with_capacity(crate::utils::safe_capacity(reader, num_sky_time as usize, 4)?);
        for _ in 0..num_sky_time {
            sky_time.push(SkyTimeOfDay::unpack(reader)?);
        }

        Ok(DayGroup {
            chance_of_occur,
            day_name,
            sky_objects,
            sky_time,
        })
    }

    /// Reverse of [`DayGroup::unpack`] — `f32 chance_of_occur`, the 4-aligned
    /// PStringBase<char> `day_name`, `u32 num_sky_objects` + that many
    /// [`SkyObject`] (BEFORE the sky-time list, per PhatSDK
    /// SkyDesc.cpp:117-125), then `u32 num_sky_time` + that many
    /// [`SkyTimeOfDay`].
    pub fn pack(&self, out: &mut Vec<u8>) {
        out.extend_from_slice(&self.chance_of_occur.to_le_bytes());
        write_pstring_char(out, &self.day_name);

        out.extend_from_slice(&(self.sky_objects.len() as u32).to_le_bytes());
        for so in &self.sky_objects {
            so.pack(out);
        }

        out.extend_from_slice(&(self.sky_time.len() as u32).to_le_bytes());
        for st in &self.sky_time {
            st.pack(out);
        }
    }
}

/// A persistent celestial billboard (sun, moon, milky way, etc) that arcs
/// across the dome each day. `default_gfx_object_id` is the `0x01xxxxxx` GfxObj
/// DID — feed it into `crate::file_type::gfx_obj::GfxObj` to extract the
/// mesh + textures.
#[derive(Debug, Clone, serde::Serialize)]
pub struct SkyObject {
    /// Day-fraction (`0.0..1.0`) at which this object appears on the horizon.
    pub begin_time: f32,
    /// Day-fraction at which it dips below the opposite horizon.
    pub end_time: f32,
    /// Heading (radians) where the object rises.
    pub begin_angle: f32,
    /// Heading where the object sets.
    pub end_angle: f32,
    /// Per-tick UV scroll velocity (e.g. for cloud-band textures).
    pub tex_velocity_x: f32,
    pub tex_velocity_y: f32,
    /// `0x01xxxxxx` GfxObj DID — the visual mesh + texture for this object.
    pub default_gfx_object_id: u32,
    /// `0x33xxxxxx` PhysicsScript DID — optional script (e.g. spawn glow).
    pub default_pes_object_id: u32,
    /// Bit-flags for object behavior (rotation, etc).
    pub properties: u32,
}

impl SkyObject {
    pub fn unpack<R: Read + Seek>(reader: &mut R) -> BinResult<Self> {
        let begin_time = f32::read_le(reader)?;
        let end_time = f32::read_le(reader)?;
        let begin_angle = f32::read_le(reader)?;
        let end_angle = f32::read_le(reader)?;
        let tex_velocity_x = f32::read_le(reader)?;
        let tex_velocity_y = f32::read_le(reader)?;
        let default_gfx_object_id = u32::read_le(reader)?;
        let default_pes_object_id = u32::read_le(reader)?;
        let properties = u32::read_le(reader)?;
        // PhatSDK SkyDesc.cpp:190 — `pReader->ReadAlign()` after the trio
        // of DWORDs. All fields above are 4-byte payloads so we're aligned
        // already; mirror the call for parity.
        align_boundary(reader, 4)?;

        Ok(SkyObject {
            begin_time,
            end_time,
            begin_angle,
            end_angle,
            tex_velocity_x,
            tex_velocity_y,
            default_gfx_object_id,
            default_pes_object_id,
            properties,
        })
    }

    /// Reverse of [`SkyObject::unpack`] — the nine dwords in read order (six
    /// `f32` then three `u32`), then the `align_boundary(4)` pad (no-op after
    /// 36 bytes; mirrored for parity with PhatSDK SkyDesc.cpp:190).
    pub fn pack(&self, out: &mut Vec<u8>) {
        out.extend_from_slice(&self.begin_time.to_le_bytes());
        out.extend_from_slice(&self.end_time.to_le_bytes());
        out.extend_from_slice(&self.begin_angle.to_le_bytes());
        out.extend_from_slice(&self.end_angle.to_le_bytes());
        out.extend_from_slice(&self.tex_velocity_x.to_le_bytes());
        out.extend_from_slice(&self.tex_velocity_y.to_le_bytes());
        out.extend_from_slice(&self.default_gfx_object_id.to_le_bytes());
        out.extend_from_slice(&self.default_pes_object_id.to_le_bytes());
        out.extend_from_slice(&self.properties.to_le_bytes());
        // PhatSDK SkyDesc.cpp:190 ReadAlign — mirror align_boundary(4).
        while out.len() % 4 != 0 {
            out.push(0);
        }
    }
}

/// One lighting keyframe in a `DayGroup`'s 24-hour cycle. AC interpolates
/// directional + ambient color/brightness + fog between consecutive entries.
#[derive(Debug, Clone, serde::Serialize)]
pub struct SkyTimeOfDay {
    /// Day-fraction (`0.0..1.0`) at which these light values apply.
    pub begin: f32,
    pub dir_bright: f32,
    pub dir_heading: f32,
    pub dir_pitch: f32,
    /// ColorARGB — 0xAARRGGBB byte order. Decode to `[u8; 4]` downstream.
    pub dir_color: u32,
    pub amb_bright: f32,
    pub amb_color: u32,
    pub min_world_fog: f32,
    pub max_world_fog: f32,
    pub world_fog_color: u32,
    /// Fog mode enum (encoded as `uint`, not bool).
    pub world_fog: u32,
    pub sky_obj_replace: Vec<SkyObjectReplace>,
}

impl SkyTimeOfDay {
    pub fn unpack<R: Read + Seek>(reader: &mut R) -> BinResult<Self> {
        let begin = f32::read_le(reader)?;
        let dir_bright = f32::read_le(reader)?;
        let dir_heading = f32::read_le(reader)?;
        let dir_pitch = f32::read_le(reader)?;
        let dir_color = u32::read_le(reader)?;
        let amb_bright = f32::read_le(reader)?;
        let amb_color = u32::read_le(reader)?;
        let min_world_fog = f32::read_le(reader)?;
        let max_world_fog = f32::read_le(reader)?;
        let world_fog_color = u32::read_le(reader)?;
        let world_fog = u32::read_le(reader)?;
        // PhatSDK SkyDesc.cpp:224 — `pReader->ReadAlign()` before count.
        align_boundary(reader, 4)?;

        let num_replace = u32::read_le(reader)?;
        let mut sky_obj_replace =
            Vec::with_capacity(crate::utils::safe_capacity(reader, num_replace as usize, 4)?);
        for _ in 0..num_replace {
            sky_obj_replace.push(SkyObjectReplace::unpack(reader)?);
        }

        Ok(SkyTimeOfDay {
            begin,
            dir_bright,
            dir_heading,
            dir_pitch,
            dir_color,
            amb_bright,
            amb_color,
            min_world_fog,
            max_world_fog,
            world_fog_color,
            world_fog,
            sky_obj_replace,
        })
    }

    /// Reverse of [`SkyTimeOfDay::unpack`] — the eleven fields in read order
    /// (`begin`, `dir_bright`, `dir_heading`, `dir_pitch` as `f32`; `dir_color`
    /// as `u32`; `amb_bright` `f32`; `amb_color` `u32`; `min_world_fog`,
    /// `max_world_fog` `f32`; `world_fog_color`, `world_fog` `u32`), then the
    /// `align_boundary(4)` pad (no-op after 44 bytes; mirrored for parity with
    /// PhatSDK SkyDesc.cpp:224), then `u32 num_replace` + that many
    /// [`SkyObjectReplace`].
    pub fn pack(&self, out: &mut Vec<u8>) {
        out.extend_from_slice(&self.begin.to_le_bytes());
        out.extend_from_slice(&self.dir_bright.to_le_bytes());
        out.extend_from_slice(&self.dir_heading.to_le_bytes());
        out.extend_from_slice(&self.dir_pitch.to_le_bytes());
        out.extend_from_slice(&self.dir_color.to_le_bytes());
        out.extend_from_slice(&self.amb_bright.to_le_bytes());
        out.extend_from_slice(&self.amb_color.to_le_bytes());
        out.extend_from_slice(&self.min_world_fog.to_le_bytes());
        out.extend_from_slice(&self.max_world_fog.to_le_bytes());
        out.extend_from_slice(&self.world_fog_color.to_le_bytes());
        out.extend_from_slice(&self.world_fog.to_le_bytes());
        // PhatSDK SkyDesc.cpp:224 ReadAlign before the count — mirror it.
        while out.len() % 4 != 0 {
            out.push(0);
        }
        out.extend_from_slice(&(self.sky_obj_replace.len() as u32).to_le_bytes());
        for r in &self.sky_obj_replace {
            r.pack(out);
        }
    }
}

/// Per-keyframe override that swaps a `SkyObject`'s gfx mesh + color params.
/// `object_index` indexes into the owning `DayGroup.sky_objects` array.
#[derive(Debug, Clone, serde::Serialize)]
pub struct SkyObjectReplace {
    pub object_index: u32,
    /// `0x01xxxxxx` GfxObj DID — replaces the parent SkyObject's mesh for
    /// this keyframe.
    pub gfx_obj_id: u32,
    pub rotate: f32,
    pub transparent: f32,
    pub luminosity: f32,
    pub max_bright: f32,
}

impl SkyObjectReplace {
    pub fn unpack<R: Read + Seek>(reader: &mut R) -> BinResult<Self> {
        let object_index = u32::read_le(reader)?;
        let gfx_obj_id = u32::read_le(reader)?;
        let rotate = f32::read_le(reader)?;
        let transparent = f32::read_le(reader)?;
        let luminosity = f32::read_le(reader)?;
        let max_bright = f32::read_le(reader)?;
        // PhatSDK SkyDesc.cpp:161 — `pReader->ReadAlign()` after final f32.
        align_boundary(reader, 4)?;

        Ok(SkyObjectReplace {
            object_index,
            gfx_obj_id,
            rotate,
            transparent,
            luminosity,
            max_bright,
        })
    }

    /// Reverse of [`SkyObjectReplace::unpack`] — the six dwords in read order
    /// (`object_index`, `gfx_obj_id` as `u32`; `rotate`, `transparent`,
    /// `luminosity`, `max_bright` as `f32`), then the `align_boundary(4)` pad
    /// (no-op after 24 bytes; mirrored for parity with PhatSDK
    /// SkyDesc.cpp:161).
    pub fn pack(&self, out: &mut Vec<u8>) {
        out.extend_from_slice(&self.object_index.to_le_bytes());
        out.extend_from_slice(&self.gfx_obj_id.to_le_bytes());
        out.extend_from_slice(&self.rotate.to_le_bytes());
        out.extend_from_slice(&self.transparent.to_le_bytes());
        out.extend_from_slice(&self.luminosity.to_le_bytes());
        out.extend_from_slice(&self.max_bright.to_le_bytes());
        // PhatSDK SkyDesc.cpp:161 ReadAlign — mirror align_boundary(4).
        while out.len() % 4 != 0 {
            out.push(0);
        }
    }
}

/// Ambient sound bank reference (one STB entry).
///
/// Note: PhatSDK's `AmbientSoundDesc` struct (`SoundDesc.h:5-13`) has a
/// sixth field `int is_continuous` that is **derived client-side, not
/// read from the wire**. `SoundDesc.cpp`'s UnPack does:
///
/// ```cpp
/// sound->stype       = (SoundType) pReader->Read<int>();
/// sound->volume      = pReader->Read<float>();
/// sound->base_chance = pReader->Read<float>();
/// sound->is_continuous = sound->base_chance == 0.0f;   // ← DERIVED
/// sound->min_rate    = pReader->Read<float>();
/// sound->max_rate    = pReader->Read<float>();
/// ```
///
/// Semantically `is_continuous` means "loop forever; start once and
/// never stop while this STB is active". `base_chance == 0` is the
/// flag; non-zero means "roll the dice every `(min_rate, max_rate)`
/// seconds and fire if `random() < base_chance`". Exposed via
/// [`AmbientSoundDesc::is_continuous`] so consumers don't have to
/// re-derive the rule.
#[derive(Debug, Clone, serde::Serialize)]
pub struct AmbientSoundDesc {
    /// Sound type enum (`uint`).
    pub s_type: u32,
    pub volume: f32,
    pub base_chance: f32,
    pub min_rate: f32,
    pub max_rate: f32,
}

impl AmbientSoundDesc {
    pub fn unpack<R: Read + Seek>(reader: &mut R) -> BinResult<Self> {
        Ok(AmbientSoundDesc {
            s_type: u32::read_le(reader)?,
            volume: f32::read_le(reader)?,
            base_chance: f32::read_le(reader)?,
            min_rate: f32::read_le(reader)?,
            max_rate: f32::read_le(reader)?,
        })
    }

    /// Reverse of [`AmbientSoundDesc::unpack`] — writes the 5 little-endian
    /// scalar fields in wire order. `is_continuous` is NOT emitted (it is
    /// derived from `base_chance == 0.0` client-side per
    /// `external/GDL/PhatSDK/SoundDesc.cpp:78`).
    ///
    /// Mirrors ACE/DatReaderWriter `dats.xml:2865-2871` and PhatSDK
    /// `AmbientSoundDesc::UnPack` (no separate Pack — `DEFINE_PACK` is
    /// `UNFINISHED()` in PhatSDK; this is the inverse of UnPack).
    pub fn pack(&self, out: &mut Vec<u8>) {
        out.extend_from_slice(&self.s_type.to_le_bytes());
        out.extend_from_slice(&self.volume.to_le_bytes());
        out.extend_from_slice(&self.base_chance.to_le_bytes());
        out.extend_from_slice(&self.min_rate.to_le_bytes());
        out.extend_from_slice(&self.max_rate.to_le_bytes());
    }

    /// Derived "continuous loop" flag — `true` iff `base_chance` is
    /// exactly `0.0`. Mirrors PhatSDK's
    /// `sound->is_continuous = sound->base_chance == 0.0f` in
    /// `SoundDesc.cpp`'s `AmbientSoundDesc::UnPack`. Continuous
    /// entries should be started once when their STB becomes active
    /// and stopped when it deactivates; non-continuous entries roll
    /// per `(min_rate, max_rate)`-window timers.
    pub fn is_continuous(&self) -> bool {
        self.base_chance == 0.0
    }
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct AmbientSTBDesc {
    pub stb_id: u32,
    pub ambient_sounds: Vec<AmbientSoundDesc>,
}

impl AmbientSTBDesc {
    pub fn unpack<R: Read + Seek>(reader: &mut R) -> BinResult<Self> {
        let stb_id = u32::read_le(reader)?;
        let num = u32::read_le(reader)?;
        let mut ambient_sounds =
            Vec::with_capacity(crate::utils::safe_capacity(reader, num as usize, 4)?);
        for _ in 0..num {
            ambient_sounds.push(AmbientSoundDesc::unpack(reader)?);
        }
        Ok(AmbientSTBDesc {
            stb_id,
            ambient_sounds,
        })
    }

    /// Reverse of [`AmbientSTBDesc::unpack`] — writes `stb_id`, length-prefixed
    /// list of `AmbientSoundDesc`s. Mirrors PhatSDK
    /// `AmbientSTBDesc::UnPack` in `external/GDL/PhatSDK/SoundDesc.cpp:65-85`
    /// and ACE/DatReaderWriter `dats.xml:2860-2864`.
    pub fn pack(&self, out: &mut Vec<u8>) {
        out.extend_from_slice(&self.stb_id.to_le_bytes());
        out.extend_from_slice(&(self.ambient_sounds.len() as u32).to_le_bytes());
        for s in &self.ambient_sounds {
            s.pack(out);
        }
    }
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct SoundDesc {
    pub stb_descs: Vec<AmbientSTBDesc>,
}

impl SoundDesc {
    pub fn unpack<R: Read + Seek>(reader: &mut R) -> BinResult<Self> {
        let num = u32::read_le(reader)?;
        let mut stb_descs =
            Vec::with_capacity(crate::utils::safe_capacity(reader, num as usize, 4)?);
        for _ in 0..num {
            stb_descs.push(AmbientSTBDesc::unpack(reader)?);
        }
        Ok(SoundDesc { stb_descs })
    }

    /// Reverse of [`SoundDesc::unpack`] — emits the canonical wire
    /// representation: `u32 num_stb_descs` followed by that many
    /// [`AmbientSTBDesc`] records. Mirrors PhatSDK
    /// `CSoundDesc::UnPack` in `external/GDL/PhatSDK/SoundDesc.cpp:27-41`
    /// and ACE/DatReaderWriter `dats.xml:2856-2859`. Used by the
    /// `region_sound_info_parity` test to round-trip retail
    /// `client_portal.dat` bytes.
    pub fn pack(&self, out: &mut Vec<u8>) {
        out.extend_from_slice(&(self.stb_descs.len() as u32).to_le_bytes());
        for stb in &self.stb_descs {
            stb.pack(out);
        }
    }
}

/// One scene category (e.g. "GrassPlains"). Each carries a flat list of Scene
/// DIDs (`0x12xxxxxx`) — terrain landblocks sample these to scatter props.
///
/// `stb_index` is read as `i32` because retail wire data carries `-1` as
/// the "no ambient sounds for this scene type" sentinel. PhatSDK's
/// `RegionDesc.cpp:276-289` does `int stb_index = reader.Read<int>(); ...
/// if (stb_index != -1) sound_table_desc = sound_info->stb_desc.array_data[stb_index]`
/// — i.e. the index is signed and `-1` is meaningful. Reading as `u32`
/// would wrap `-1` to `0xFFFFFFFF` and either OOB-panic any consumer or
/// silently mis-index the SoundDesc array.
#[derive(Debug, Clone, serde::Serialize)]
pub struct SceneType {
    pub stb_index: i32,
    /// `0x12xxxxxx` Scene DIDs.
    pub scenes: Vec<u32>,
}

impl SceneType {
    pub fn unpack<R: Read + Seek>(reader: &mut R) -> BinResult<Self> {
        let stb_index = i32::read_le(reader)?;
        let num = u32::read_le(reader)?;
        let mut scenes = Vec::with_capacity(crate::utils::safe_capacity(reader, num as usize, 4)?);
        for _ in 0..num {
            scenes.push(u32::read_le(reader)?);
        }
        Ok(SceneType { stb_index, scenes })
    }

    /// Reverse of [`SceneType::unpack`] — `i32 stb_index` (SIGNED — `-1` is
    /// the "no ambient sounds" sentinel; writing it as a `u32` cast would
    /// preserve the same bytes but the field type must stay `i32` per
    /// PhatSDK RegionDesc.cpp:276), then `u32 num_scenes` + that many `u32`
    /// Scene DIDs.
    pub fn pack(&self, out: &mut Vec<u8>) {
        out.extend_from_slice(&self.stb_index.to_le_bytes());
        out.extend_from_slice(&(self.scenes.len() as u32).to_le_bytes());
        for scene in &self.scenes {
            out.extend_from_slice(&scene.to_le_bytes());
        }
    }
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct SceneDesc {
    pub scene_types: Vec<SceneType>,
}

impl SceneDesc {
    pub fn unpack<R: Read + Seek>(reader: &mut R) -> BinResult<Self> {
        let num = u32::read_le(reader)?;
        let mut scene_types =
            Vec::with_capacity(crate::utils::safe_capacity(reader, num as usize, 4)?);
        for _ in 0..num {
            scene_types.push(SceneType::unpack(reader)?);
        }
        Ok(SceneDesc { scene_types })
    }

    /// Reverse of [`SceneDesc::unpack`] — `u32 num_scene_types` + that many
    /// [`SceneType`].
    pub fn pack(&self, out: &mut Vec<u8>) {
        out.extend_from_slice(&(self.scene_types.len() as u32).to_le_bytes());
        for st in &self.scene_types {
            st.pack(out);
        }
    }
}

/// Per-terrain-type alpha mask + texture. Used by the `TexMerge` blender.
#[derive(Debug, Clone, serde::Serialize)]
pub struct TerrainAlphaMap {
    /// Terrain code enum.
    pub t_code: u32,
    /// `0x05xxxxxx` SurfaceTexture DID.
    pub texture_id: u32,
}

impl TerrainAlphaMap {
    pub fn unpack<R: Read + Seek>(reader: &mut R) -> BinResult<Self> {
        Ok(TerrainAlphaMap {
            t_code: u32::read_le(reader)?,
            texture_id: u32::read_le(reader)?,
        })
    }

    /// Reverse of [`TerrainAlphaMap::unpack`] — `u32 t_code`, `u32 texture_id`.
    pub fn pack(&self, out: &mut Vec<u8>) {
        out.extend_from_slice(&self.t_code.to_le_bytes());
        out.extend_from_slice(&self.texture_id.to_le_bytes());
    }
}

/// Road alpha-blend overlay.
#[derive(Debug, Clone, serde::Serialize)]
pub struct RoadAlphaMap {
    pub r_code: u32,
    /// `0x05xxxxxx` SurfaceTexture DID.
    pub texture_id: u32,
}

impl RoadAlphaMap {
    pub fn unpack<R: Read + Seek>(reader: &mut R) -> BinResult<Self> {
        Ok(RoadAlphaMap {
            r_code: u32::read_le(reader)?,
            texture_id: u32::read_le(reader)?,
        })
    }

    /// Reverse of [`RoadAlphaMap::unpack`] — `u32 r_code`, `u32 texture_id`.
    pub fn pack(&self, out: &mut Vec<u8>) {
        out.extend_from_slice(&self.r_code.to_le_bytes());
        out.extend_from_slice(&self.texture_id.to_le_bytes());
    }
}

/// Texture-merger sub-record describing how AC blends per-corner terrain
/// textures into a single landblock surface.
#[derive(Debug, Clone, serde::Serialize)]
pub struct TerrainTex {
    /// `0x05xxxxxx` SurfaceTexture DID — base diffuse.
    pub texture_id: u32,
    pub tex_tiling: u32,
    pub max_vert_bright: u32,
    pub min_vert_bright: u32,
    pub max_vert_saturate: u32,
    pub min_vert_saturate: u32,
    pub max_vert_hue: u32,
    pub min_vert_hue: u32,
    pub detail_tex_tiling: u32,
    /// `0x05xxxxxx` SurfaceTexture DID — detail layer.
    pub detail_texture_id: u32,
}

impl TerrainTex {
    pub fn unpack<R: Read + Seek>(reader: &mut R) -> BinResult<Self> {
        Ok(TerrainTex {
            texture_id: u32::read_le(reader)?,
            tex_tiling: u32::read_le(reader)?,
            max_vert_bright: u32::read_le(reader)?,
            min_vert_bright: u32::read_le(reader)?,
            max_vert_saturate: u32::read_le(reader)?,
            min_vert_saturate: u32::read_le(reader)?,
            max_vert_hue: u32::read_le(reader)?,
            min_vert_hue: u32::read_le(reader)?,
            detail_tex_tiling: u32::read_le(reader)?,
            detail_texture_id: u32::read_le(reader)?,
        })
    }

    /// Reverse of [`TerrainTex::unpack`] — the ten `u32` fields in read order.
    pub fn pack(&self, out: &mut Vec<u8>) {
        out.extend_from_slice(&self.texture_id.to_le_bytes());
        out.extend_from_slice(&self.tex_tiling.to_le_bytes());
        out.extend_from_slice(&self.max_vert_bright.to_le_bytes());
        out.extend_from_slice(&self.min_vert_bright.to_le_bytes());
        out.extend_from_slice(&self.max_vert_saturate.to_le_bytes());
        out.extend_from_slice(&self.min_vert_saturate.to_le_bytes());
        out.extend_from_slice(&self.max_vert_hue.to_le_bytes());
        out.extend_from_slice(&self.min_vert_hue.to_le_bytes());
        out.extend_from_slice(&self.detail_tex_tiling.to_le_bytes());
        out.extend_from_slice(&self.detail_texture_id.to_le_bytes());
    }
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct TMTerrainDesc {
    /// `TerrainTextureType` enum value (`uint`).
    pub terrain_type: u32,
    pub terrain_tex: TerrainTex,
}

impl TMTerrainDesc {
    pub fn unpack<R: Read + Seek>(reader: &mut R) -> BinResult<Self> {
        let terrain_type = u32::read_le(reader)?;
        let terrain_tex = TerrainTex::unpack(reader)?;
        Ok(TMTerrainDesc {
            terrain_type,
            terrain_tex,
        })
    }

    /// Reverse of [`TMTerrainDesc::unpack`] — `u32 terrain_type` then the
    /// [`TerrainTex`] payload.
    pub fn pack(&self, out: &mut Vec<u8>) {
        out.extend_from_slice(&self.terrain_type.to_le_bytes());
        self.terrain_tex.pack(out);
    }
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct TexMerge {
    pub base_tex_size: u32,
    pub corner_terrain_maps: Vec<TerrainAlphaMap>,
    pub side_terrain_maps: Vec<TerrainAlphaMap>,
    pub road_maps: Vec<RoadAlphaMap>,
    pub terrain_desc: Vec<TMTerrainDesc>,
}

impl TexMerge {
    pub fn unpack<R: Read + Seek>(reader: &mut R) -> BinResult<Self> {
        let base_tex_size = u32::read_le(reader)?;

        let n = u32::read_le(reader)?;
        let mut corner_terrain_maps =
            Vec::with_capacity(crate::utils::safe_capacity(reader, n as usize, 4)?);
        for _ in 0..n {
            corner_terrain_maps.push(TerrainAlphaMap::unpack(reader)?);
        }

        let n = u32::read_le(reader)?;
        let mut side_terrain_maps =
            Vec::with_capacity(crate::utils::safe_capacity(reader, n as usize, 4)?);
        for _ in 0..n {
            side_terrain_maps.push(TerrainAlphaMap::unpack(reader)?);
        }

        let n = u32::read_le(reader)?;
        let mut road_maps = Vec::with_capacity(crate::utils::safe_capacity(reader, n as usize, 4)?);
        for _ in 0..n {
            road_maps.push(RoadAlphaMap::unpack(reader)?);
        }

        let n = u32::read_le(reader)?;
        let mut terrain_desc =
            Vec::with_capacity(crate::utils::safe_capacity(reader, n as usize, 4)?);
        for _ in 0..n {
            terrain_desc.push(TMTerrainDesc::unpack(reader)?);
        }

        Ok(TexMerge {
            base_tex_size,
            corner_terrain_maps,
            side_terrain_maps,
            road_maps,
            terrain_desc,
        })
    }

    /// Reverse of [`TexMerge::unpack`] — `u32 base_tex_size`, then the four
    /// length-prefixed lists in their exact read order: corner
    /// [`TerrainAlphaMap`]s, side [`TerrainAlphaMap`]s, road [`RoadAlphaMap`]s,
    /// and [`TMTerrainDesc`]s. Each list is `u32 count` + that many records.
    pub fn pack(&self, out: &mut Vec<u8>) {
        out.extend_from_slice(&self.base_tex_size.to_le_bytes());

        out.extend_from_slice(&(self.corner_terrain_maps.len() as u32).to_le_bytes());
        for m in &self.corner_terrain_maps {
            m.pack(out);
        }

        out.extend_from_slice(&(self.side_terrain_maps.len() as u32).to_le_bytes());
        for m in &self.side_terrain_maps {
            m.pack(out);
        }

        out.extend_from_slice(&(self.road_maps.len() as u32).to_le_bytes());
        for m in &self.road_maps {
            m.pack(out);
        }

        out.extend_from_slice(&(self.terrain_desc.len() as u32).to_le_bytes());
        for d in &self.terrain_desc {
            d.pack(out);
        }
    }
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct LandSurf {
    /// `LandSurf.Type` enum (`uint`).
    pub surf_type: u32,
    pub tex_merge: TexMerge,
}

impl LandSurf {
    pub fn unpack<R: Read + Seek>(reader: &mut R) -> BinResult<Self> {
        let surf_type = u32::read_le(reader)?;
        let tex_merge = TexMerge::unpack(reader)?;
        Ok(LandSurf {
            surf_type,
            tex_merge,
        })
    }

    /// Reverse of [`LandSurf::unpack`] — `u32 surf_type` then the [`TexMerge`]
    /// payload.
    pub fn pack(&self, out: &mut Vec<u8>) {
        out.extend_from_slice(&self.surf_type.to_le_bytes());
        self.tex_merge.pack(out);
    }
}

/// Named terrain category (e.g. "Grasslands", "BarrenRock"). `terrain_color`
/// is the radar/minimap color for this terrain.
#[derive(Debug, Clone, serde::Serialize)]
pub struct TerrainType {
    pub terrain_name: String,
    pub terrain_color: u32,
    pub scene_types: Vec<u32>,
}

impl TerrainType {
    pub fn unpack<R: Read + Seek>(reader: &mut R) -> BinResult<Self> {
        let terrain_name = read_pstring_char(reader)?;
        let terrain_color = u32::read_le(reader)?;
        let num = u32::read_le(reader)?;
        let mut scene_types =
            Vec::with_capacity(crate::utils::safe_capacity(reader, num as usize, 4)?);
        for _ in 0..num {
            scene_types.push(u32::read_le(reader)?);
        }
        Ok(TerrainType {
            terrain_name,
            terrain_color,
            scene_types,
        })
    }

    /// Reverse of [`TerrainType::unpack`] — the 4-aligned PStringBase<char>
    /// `terrain_name`, `u32 terrain_color`, `u32 num_scene_types` + that many
    /// `u32` Scene DIDs.
    pub fn pack(&self, out: &mut Vec<u8>) {
        write_pstring_char(out, &self.terrain_name);
        out.extend_from_slice(&self.terrain_color.to_le_bytes());
        out.extend_from_slice(&(self.scene_types.len() as u32).to_le_bytes());
        for scene in &self.scene_types {
            out.extend_from_slice(&scene.to_le_bytes());
        }
    }
}

/// Region-level terrain palette + texture-blending rules. Unconditional —
/// every Region has one, even ones without SkyInfo.
#[derive(Debug, Clone, serde::Serialize)]
pub struct TerrainDesc {
    pub terrain_types: Vec<TerrainType>,
    pub land_surfaces: LandSurf,
}

impl TerrainDesc {
    pub fn unpack<R: Read + Seek>(reader: &mut R) -> BinResult<Self> {
        let num = u32::read_le(reader)?;
        let mut terrain_types =
            Vec::with_capacity(crate::utils::safe_capacity(reader, num as usize, 4)?);
        for _ in 0..num {
            terrain_types.push(TerrainType::unpack(reader)?);
        }
        let land_surfaces = LandSurf::unpack(reader)?;
        Ok(TerrainDesc {
            terrain_types,
            land_surfaces,
        })
    }

    /// Reverse of [`TerrainDesc::unpack`] — `u32 num_terrain_types` + that many
    /// [`TerrainType`], then the [`LandSurf`] payload.
    pub fn pack(&self, out: &mut Vec<u8>) {
        out.extend_from_slice(&(self.terrain_types.len() as u32).to_le_bytes());
        for tt in &self.terrain_types {
            tt.pack(out);
        }
        self.land_surfaces.pack(out);
    }
}

/// Realm-wide miscellany — autotest map ID, clear-cell ID, etc.
#[derive(Debug, Clone, serde::Serialize)]
pub struct RegionMisc {
    pub version: u32,
    pub game_map_id: u32,
    pub autotest_map_id: u32,
    pub autotest_map_size: u32,
    pub clear_cell_id: u32,
    pub clear_monster_id: u32,
}

impl RegionMisc {
    pub fn unpack<R: Read + Seek>(reader: &mut R) -> BinResult<Self> {
        Ok(RegionMisc {
            version: u32::read_le(reader)?,
            game_map_id: u32::read_le(reader)?,
            autotest_map_id: u32::read_le(reader)?,
            autotest_map_size: u32::read_le(reader)?,
            clear_cell_id: u32::read_le(reader)?,
            clear_monster_id: u32::read_le(reader)?,
        })
    }

    /// Reverse of [`RegionMisc::unpack`] — the six `u32` fields in read order.
    pub fn pack(&self, out: &mut Vec<u8>) {
        out.extend_from_slice(&self.version.to_le_bytes());
        out.extend_from_slice(&self.game_map_id.to_le_bytes());
        out.extend_from_slice(&self.autotest_map_id.to_le_bytes());
        out.extend_from_slice(&self.autotest_map_size.to_le_bytes());
        out.extend_from_slice(&self.clear_cell_id.to_le_bytes());
        out.extend_from_slice(&self.clear_monster_id.to_le_bytes());
    }
}

/// AC's per-realm descriptor — `0x13000000` is the only Region currently
/// shipped in retail `client_portal.dat`. Its `region_number` field reads
/// 1 (per PhatSDK convention "Region 1 = Dereth"), but the file ID itself
/// is the namespace-prefix-only `0x13000000`. The `0x1300xxxx` namespace
/// reserves room for alternate realms (e.g. apartment overlays) but they
/// are not present in current retail.
#[derive(Debug, Clone, serde::Serialize)]
pub struct Region {
    /// File ID (HasId flag set on Region DBObjs per dats.xml:3850).
    pub id: u32,
    pub region_number: u32,
    pub version: u32,
    pub region_name: String,
    pub land_defs: LandDefs,
    pub game_time: GameTime,
    pub parts_mask: u32,
    /// Present iff `parts_mask & PARTS_MASK_HAS_SOUND_INFO != 0`.
    pub sound_info: Option<SoundDesc>,
    /// Present iff `parts_mask & PARTS_MASK_HAS_SCENE_INFO != 0`.
    pub scene_info: Option<SceneDesc>,
    /// Present iff `parts_mask & PARTS_MASK_HAS_SKY_INFO != 0`.
    /// **This is the load-bearing field for the parametric-skybox push.**
    pub sky_info: Option<SkyDesc>,
    /// Unconditional — every Region has a TerrainDesc.
    pub terrain_info: TerrainDesc,
    /// Present iff `parts_mask & PARTS_MASK_HAS_REGION_MISC != 0`.
    pub region_misc: Option<RegionMisc>,
}

impl Region {
    pub fn unpack<R: Read + Seek>(reader: &mut R) -> BinResult<Self> {
        // DBObj.HasId — first DWORD is the file ID.
        let id = u32::read_le(reader)?;
        let region_number = u32::read_le(reader)?;
        let version = u32::read_le(reader)?;
        let region_name = read_pstring_char(reader)?;

        let land_defs = LandDefs::unpack(reader)?;
        let game_time = GameTime::unpack(reader)?;
        let parts_mask = u32::read_le(reader)?;

        // dats.xml:3860-3870 emits the optional fields in *maskmap
        // declaration order*, NOT bit-value order. The schema order
        // is [SkyInfo, SoundInfo, SceneInfo] — SkyInfo first even
        // though its bit (0x10) is higher than SoundInfo's (0x01).
        // PhatSDK RegionDesc.cpp:268-306 confirms this layout against
        // real bytes.
        let sky_info = if parts_mask & PARTS_MASK_HAS_SKY_INFO != 0 {
            Some(SkyDesc::unpack(reader)?)
        } else {
            None
        };

        let sound_info = if parts_mask & PARTS_MASK_HAS_SOUND_INFO != 0 {
            Some(SoundDesc::unpack(reader)?)
        } else {
            None
        };

        let scene_info = if parts_mask & PARTS_MASK_HAS_SCENE_INFO != 0 {
            Some(SceneDesc::unpack(reader)?)
        } else {
            None
        };

        // dats.xml:3871 — TerrainInfo is unconditional.
        let terrain_info = TerrainDesc::unpack(reader)?;

        // dats.xml:3872-3876 — second maskmap; RegionMisc comes AFTER
        // TerrainInfo (not before).
        let region_misc = if parts_mask & PARTS_MASK_HAS_REGION_MISC != 0 {
            Some(RegionMisc::unpack(reader)?)
        } else {
            None
        };

        Ok(Region {
            id,
            region_number,
            version,
            region_name,
            land_defs,
            game_time,
            parts_mask,
            sound_info,
            scene_info,
            sky_info,
            terrain_info,
            region_misc,
        })
    }

    /// Reverse of [`Region::unpack`] — serialize the full Region body into
    /// `out`. Field order is the EXACT inverse of the reader:
    ///
    /// ```text
    ///   id(u32) region_number(u32) version(u32)
    ///   region_name (PStringBase<char>, 4-aligned)
    ///   land_defs (8 scalars + 256 f32)
    ///   game_time (GameTime)
    ///   parts_mask(u32)
    ///   if parts_mask & 0x10  : SkyDesc      (HasSkyInfo)   ← WIRE ORDER: sky first
    ///   if parts_mask & 0x01  : SoundDesc    (HasSoundInfo)
    ///   if parts_mask & 0x02  : SceneDesc    (HasSceneInfo)
    ///   TerrainDesc                                          (unconditional)
    ///   if parts_mask & 0x200 : RegionMisc   (HasRegionMisc) ← after TerrainInfo
    /// ```
    ///
    /// The optional blocks are emitted in WIRE order — `[Sky, Sound, Scene,
    /// (Terrain), Misc]` — NOT bit-value order, matching `Region::unpack` and
    /// PhatSDK RegionDesc.cpp:268-306. Each is gated on its own parts_mask
    /// bit; a bit set with a `None` field is an unwritable contradiction
    /// (the byte stream could not be re-parsed back to the same record), so
    /// this returns an error rather than emitting bad bytes. The higher-level
    /// `DatPack for Region` guard rejects BOTH directions (set-but-None AND
    /// clear-but-Some) up front; this inverse only needs the set-but-None
    /// check to stay a faithful inverse of the reader.
    pub fn pack(&self, out: &mut Vec<u8>) -> BinResult<()> {
        out.extend_from_slice(&self.id.to_le_bytes());
        out.extend_from_slice(&self.region_number.to_le_bytes());
        out.extend_from_slice(&self.version.to_le_bytes());
        write_pstring_char(out, &self.region_name);

        self.land_defs.pack(out);
        self.game_time.pack(out);
        out.extend_from_slice(&self.parts_mask.to_le_bytes());

        // WIRE ORDER: SkyInfo (0x10) first, even though its bit value is
        // higher than SoundInfo's. Mirrors Region::unpack exactly.
        if self.parts_mask & PARTS_MASK_HAS_SKY_INFO != 0 {
            let sky = self.sky_info.as_ref().ok_or_else(|| binrw::Error::AssertFail {
                pos: out.len() as u64,
                message: "parts_mask HasSkyInfo (0x10) set but sky_info is None".to_string(),
            })?;
            sky.pack(out);
        }

        if self.parts_mask & PARTS_MASK_HAS_SOUND_INFO != 0 {
            let sound = self.sound_info.as_ref().ok_or_else(|| binrw::Error::AssertFail {
                pos: out.len() as u64,
                message: "parts_mask HasSoundInfo (0x01) set but sound_info is None".to_string(),
            })?;
            // SoundDesc already has an inverse pack() (shipped) — WRAP it.
            sound.pack(out);
        }

        if self.parts_mask & PARTS_MASK_HAS_SCENE_INFO != 0 {
            let scene = self.scene_info.as_ref().ok_or_else(|| binrw::Error::AssertFail {
                pos: out.len() as u64,
                message: "parts_mask HasSceneInfo (0x02) set but scene_info is None".to_string(),
            })?;
            scene.pack(out);
        }

        // TerrainInfo is unconditional.
        self.terrain_info.pack(out);

        // RegionMisc comes AFTER TerrainInfo (second maskmap).
        if self.parts_mask & PARTS_MASK_HAS_REGION_MISC != 0 {
            let misc = self.region_misc.as_ref().ok_or_else(|| binrw::Error::AssertFail {
                pos: out.len() as u64,
                message: "parts_mask HasRegionMisc (0x200) set but region_misc is None"
                    .to_string(),
            })?;
            misc.pack(out);
        }

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::file_type::game_time::TimeOfDay;
    use std::io::Cursor;

    /// Lifts the `_numTimesOfDay`/`is_night`/`name` shape of the schema into
    /// a sanity check. Forces `is_night` to be the 4-byte form per
    /// dats.xml:2798 (`bool size="4"`), not a single byte.
    #[test]
    fn time_of_day_unpacks_as_4_byte_bool_with_aligned_pstring() {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&0.5f32.to_le_bytes()); // start
        bytes.extend_from_slice(&1u32.to_le_bytes()); // is_night = true (4 bytes)
        bytes.extend_from_slice(&5u16.to_le_bytes()); // pstring len
        bytes.extend_from_slice(b"Night"); // 5 bytes
        // After u16(2) + 5 bytes name = 7 bytes since pstring start. With
        // start(4) + is_night(4) before, offset is 4+4+2+5 = 15. Align to
        // 4 → pad 1 byte.
        bytes.extend_from_slice(&[0u8; 1]);

        let tod = TimeOfDay::unpack(&mut Cursor::new(bytes)).unwrap();
        assert_eq!(tod.start, 0.5);
        assert!(tod.is_night);
        assert_eq!(tod.name, "Night");
    }

    /// Mirrors PhatSDK SkyObject::UnPack byte-for-byte. Pins the field
    /// order — if a future schema change reorders begin_angle/end_angle
    /// or the gfx_object_id position, this catches it.
    #[test]
    fn sky_object_unpacks_nine_dwords_in_order() {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&0.25f32.to_le_bytes()); // begin_time
        bytes.extend_from_slice(&0.75f32.to_le_bytes()); // end_time
        bytes.extend_from_slice(&0.0f32.to_le_bytes()); // begin_angle
        bytes.extend_from_slice(&3.14f32.to_le_bytes()); // end_angle
        bytes.extend_from_slice(&0.1f32.to_le_bytes()); // tex_velocity_x
        bytes.extend_from_slice(&0.2f32.to_le_bytes()); // tex_velocity_y
        bytes.extend_from_slice(&0x0100_0123u32.to_le_bytes()); // default_gfx_object_id
        bytes.extend_from_slice(&0u32.to_le_bytes()); // default_pes_object_id
        bytes.extend_from_slice(&0xCAFEu32.to_le_bytes()); // properties

        let so = SkyObject::unpack(&mut Cursor::new(bytes)).unwrap();
        assert_eq!(so.begin_time, 0.25);
        assert_eq!(so.end_time, 0.75);
        assert_eq!(so.begin_angle, 0.0);
        assert_eq!(so.default_gfx_object_id, 0x0100_0123);
        assert_eq!(so.properties, 0xCAFE);
    }

    /// Asserts the parts-mask conditional layout: a region with mask 0
    /// must not consume any bytes for SkyInfo/SoundInfo/SceneInfo/etc, and
    /// the byte cursor lands at TerrainInfo immediately after parts_mask.
    /// This is the regression that catches accidental unconditional reads.
    #[test]
    fn region_parts_mask_zero_yields_no_optional_subrecords() {
        // Build a minimal Region with parts_mask=0 + tiny TerrainDesc
        // (0 types + LandSurf with 0 of everything in TexMerge).
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&0x1300_0000u32.to_le_bytes()); // id
        bytes.extend_from_slice(&1u32.to_le_bytes()); // region_number
        bytes.extend_from_slice(&0u32.to_le_bytes()); // version
        // region_name = "X" (1 byte + 3 padding for align)
        bytes.extend_from_slice(&1u16.to_le_bytes());
        bytes.push(b'X');
        bytes.extend_from_slice(&[0u8; 1]); // align to 4 (we're at u16+1 = 3 bytes from start of pstring; offset = 12+3 = 15; pad 1)

        // LandDefs: 8 fields (32 bytes) + 256 floats (1024 bytes) = 1056 bytes
        for _ in 0..8 {
            bytes.extend_from_slice(&0u32.to_le_bytes());
        }
        for _ in 0..256 {
            bytes.extend_from_slice(&0.0f32.to_le_bytes());
        }

        // GameTime: 8(zero_time) + 4(year) + 4(daylen) + 4(dpy) + pstring("") + 3 vec counts (all 0).
        bytes.extend_from_slice(&0.0f64.to_le_bytes()); // zero_time_of_year
        bytes.extend_from_slice(&0u32.to_le_bytes()); // zero_year
        bytes.extend_from_slice(&0.0f32.to_le_bytes()); // day_length
        bytes.extend_from_slice(&0u32.to_le_bytes()); // days_per_year
        // YearSpec = "" — pstring len 0 + align pad.
        bytes.extend_from_slice(&0u16.to_le_bytes());
        bytes.extend_from_slice(&[0u8; 2]); // pad from offset (length-2 → +2 = 4-aligned)
        bytes.extend_from_slice(&0u32.to_le_bytes()); // num_times_of_day
        bytes.extend_from_slice(&0u32.to_le_bytes()); // num_days_of_week
        bytes.extend_from_slice(&0u32.to_le_bytes()); // num_seasons

        bytes.extend_from_slice(&0u32.to_le_bytes()); // parts_mask = 0

        // TerrainDesc: 0 types + LandSurf{0, TexMerge{0, 0,0,0,0}}.
        bytes.extend_from_slice(&0u32.to_le_bytes()); // num_terrain_types
        bytes.extend_from_slice(&0u32.to_le_bytes()); // LandSurf.surf_type
        bytes.extend_from_slice(&0u32.to_le_bytes()); // TexMerge.base_tex_size
        bytes.extend_from_slice(&0u32.to_le_bytes()); // n corner
        bytes.extend_from_slice(&0u32.to_le_bytes()); // n side
        bytes.extend_from_slice(&0u32.to_le_bytes()); // n road
        bytes.extend_from_slice(&0u32.to_le_bytes()); // n terrain_desc

        let total = bytes.len() as u64;
        let mut cursor = Cursor::new(bytes);
        let region = Region::unpack(&mut cursor).expect("synthetic minimal region should parse");
        assert_eq!(region.id, 0x1300_0000);
        assert_eq!(region.region_number, 1);
        assert!(region.sound_info.is_none());
        assert!(region.scene_info.is_none());
        assert!(region.sky_info.is_none());
        assert!(region.region_misc.is_none());
        assert_eq!(region.terrain_info.terrain_types.len(), 0);
        // Cursor should be at end-of-buffer — i.e. the parser consumed
        // every byte. Anything else means we drifted.
        assert_eq!(
            cursor.position(),
            total,
            "parser drifted by {} bytes",
            total as i64 - cursor.position() as i64
        );
    }

    /// Loads real `client_portal.dat` (Region 1 = `0x13000000`) and verifies
    /// the SkyInfo chain unpacks. **This is the load-bearing evidence that
    /// downstream workstreams have something real to consume.**
    ///
    /// Resolves the dat in this order:
    /// 1. `HOLTBURGER_PORTAL_DAT` env var (existing convention from
    ///    `crate::utils::get_portal_dat_path`).
    /// 2. The repo-relative `dats/portal.dat`.
    /// 3. The canonical install path
    ///    `/home/wbterminal/ac_base_dats/client_portal.dat`.
    ///
    /// If none of the above resolves, the test prints a skip note and
    /// passes (so CI without the dat doesn't redbarn).
    fn locate_portal_dat() -> Option<std::path::PathBuf> {
        if let Some(p) = crate::utils::get_portal_dat_path() {
            return Some(p);
        }
        let canonical = std::path::PathBuf::from("/home/wbterminal/ac_base_dats/client_portal.dat");
        if canonical.exists() {
            return Some(canonical);
        }
        None
    }

    #[test]
    fn region_1_parses_from_real_client_portal_dat_with_sky_info() {
        use crate::DatDatabase;
        let Some(path) = locate_portal_dat() else {
            eprintln!(
                "[region_1_parses_from_real_client_portal_dat_with_sky_info] \
                 SKIP — HOLTBURGER_PORTAL_DAT unset and no canonical fallback \
                 found at /home/wbterminal/ac_base_dats/client_portal.dat"
            );
            return;
        };
        let dat = DatDatabase::new(&path).expect("client_portal.dat should open");
        let bytes = dat
            .get_file(0x1300_0000)
            .expect("Region 0x13000000 must exist in retail client_portal.dat");

        let region = Region::unpack(&mut Cursor::new(&bytes))
            .expect("Region 0x13000000 must parse cleanly");

        assert_eq!(region.id, 0x1300_0000, "Region id mismatch");
        assert_eq!(region.region_number, 1, "Region number should be 1");

        eprintln!(
            "[Region 0x{:08X}] name={:?} parts_mask=0x{:04X} (HasSkyInfo={}, HasSoundInfo={}, HasSceneInfo={}, HasRegionMisc={})",
            region.id,
            region.region_name,
            region.parts_mask,
            region.parts_mask & PARTS_MASK_HAS_SKY_INFO != 0,
            region.parts_mask & PARTS_MASK_HAS_SOUND_INFO != 0,
            region.parts_mask & PARTS_MASK_HAS_SCENE_INFO != 0,
            region.parts_mask & PARTS_MASK_HAS_REGION_MISC != 0,
        );

        assert_ne!(
            region.parts_mask & PARTS_MASK_HAS_SKY_INFO,
            0,
            "Retail Region 1 must have HasSkyInfo bit set (parts_mask=0x{:X})",
            region.parts_mask
        );
        let sky = region.sky_info.as_ref().expect("HasSkyInfo set → SkyDesc present");
        assert!(
            !sky.day_groups.is_empty(),
            "Retail Region 1 SkyDesc must carry at least one DayGroup"
        );

        eprintln!(
            "[SkyDesc] tick_size={} light_tick_size={} day_groups={}",
            sky.tick_size,
            sky.light_tick_size,
            sky.day_groups.len()
        );
        for (i, dg) in sky.day_groups.iter().enumerate() {
            eprintln!(
                "  DayGroup[{i}]: name={:?} chance={} sky_objects={} sky_time_keyframes={}",
                dg.day_name,
                dg.chance_of_occur,
                dg.sky_objects.len(),
                dg.sky_time.len(),
            );
        }
    }

    #[test]
    fn region_1_first_day_groups_sky_object_gfx_object_ids_have_gfx_obj_prefix() {
        use crate::DatDatabase;
        let Some(path) = locate_portal_dat() else {
            eprintln!(
                "[region_1_first_day_groups_sky_object_gfx_object_ids_have_gfx_obj_prefix] \
                 SKIP — no portal.dat resolved"
            );
            return;
        };
        let dat = DatDatabase::new(&path).expect("client_portal.dat should open");
        let bytes = dat.get_file(0x1300_0000).expect("Region 0x13000000 must exist");
        let region =
            Region::unpack(&mut Cursor::new(&bytes)).expect("Region 0x13000000 must parse");
        let sky = region.sky_info.as_ref().expect("SkyInfo must be present");
        assert!(!sky.day_groups.is_empty(), "at least one DayGroup");

        let dg0 = &sky.day_groups[0];
        assert!(
            !dg0.sky_objects.is_empty(),
            "first DayGroup must carry at least one SkyObject (got {})",
            dg0.sky_objects.len()
        );

        eprintln!(
            "[Region 1 → DayGroup[0] {:?}] SkyObjects = {}",
            dg0.day_name,
            dg0.sky_objects.len(),
        );
        for (i, so) in dg0.sky_objects.iter().enumerate() {
            eprintln!(
                "  SkyObject[{i}]: begin_time={} end_time={} begin_angle={} end_angle={} \
                 tex_velocity=({}, {}) default_gfx_object_id=0x{:08X} \
                 default_pes_object_id=0x{:08X} properties=0x{:08X}",
                so.begin_time,
                so.end_time,
                so.begin_angle,
                so.end_angle,
                so.tex_velocity_x,
                so.tex_velocity_y,
                so.default_gfx_object_id,
                so.default_pes_object_id,
                so.properties,
            );

            // The whole point of this workstream is to hand DIDs to the
            // downstream renderer. The schema declares
            // `genericValue="GfxObj"` (i.e. 0x01xxxxxx) but real bytes
            // confirm AC retail also ships SkyObjects whose visual is a
            // PhysicsScript-driven SetupModel (0x02xxxxxx) — e.g. DayGroup
            // "Sunny" SkyObject[6] is 0x02000714 paired with
            // default_pes_object_id 0x330007DB (the
            // physics-script-attached moon model). The renderer must
            // handle both. ID 0 is a valid sentinel ("no mesh") per
            // PhatSDK defaults, so we only enforce a non-zero ID landing
            // in one of the two visual-content namespaces.
            if so.default_gfx_object_id != 0 {
                let prefix = so.default_gfx_object_id >> 24;
                assert!(
                    prefix == 0x01 || prefix == 0x02,
                    "SkyObject[{i}].default_gfx_object_id 0x{:08X} must have \
                     0x01 (GfxObj) or 0x02 (SetupModel) prefix, got 0x{:02X}",
                    so.default_gfx_object_id,
                    prefix
                );
            }
        }
    }

    /// Strong invariant — once the full parser runs against retail
    /// Region 0x13000000, the cursor MUST land within a few bytes of
    /// end-of-buffer. Padding/trailing-zeros are OK (DBObj DAT records
    /// are page-aligned by the BTree writer) but if we're more than
    /// 16 bytes short, something silently got skipped; if we ran past
    /// the end, binrw would have errored already.
    #[test]
    fn region_1_parse_lands_at_end_of_record() {
        use crate::DatDatabase;
        let Some(path) = locate_portal_dat() else {
            eprintln!("[region_1_parse_lands_at_end_of_record] SKIP");
            return;
        };
        let dat = DatDatabase::new(&path).expect("portal.dat");
        let bytes = dat.get_file(0x1300_0000).expect("Region 0x13000000");
        let total = bytes.len() as u64;
        let mut cursor = Cursor::new(&bytes);
        let _region = Region::unpack(&mut cursor).expect("Region must parse");
        let consumed = cursor.position();
        let leftover = total - consumed;
        eprintln!(
            "[region_1_parse_lands_at_end_of_record] total={} consumed={} leftover={}",
            total, consumed, leftover
        );
        // The trailing bytes are AC's BTree-page padding zeros. Anything
        // > 16 means we missed a real field.
        assert!(
            leftover <= 16,
            "Region parser consumed only {} of {} bytes ({} leftover) — \
             likely missed a sub-record. Trailing bytes: {:02X?}",
            consumed,
            total,
            leftover,
            &bytes[consumed as usize..(consumed as usize + leftover as usize).min(bytes.len())]
        );

        // The trailing slack should be zeros (DAT page padding).
        let trailing: &[u8] = &bytes[consumed as usize..];
        assert!(
            trailing.iter().all(|&b| b == 0),
            "Trailing bytes after Region parse are not all zeros: {:02X?}",
            trailing
        );
    }

    #[test]
    fn region_1_region_misc_matches_dat_reader_writer_canonical_values() {
        use crate::DatDatabase;
        let Some(path) = locate_portal_dat() else {
            eprintln!("[region_1_region_misc_matches_dat_reader_writer_canonical_values] SKIP");
            return;
        };
        let dat = DatDatabase::new(&path).expect("portal.dat");
        let bytes = dat.get_file(0x1300_0000).expect("Region 0x13000000");
        let region = Region::unpack(&mut Cursor::new(&bytes)).expect("Region must parse");

        // Pins the post-TerrainDesc RegionMisc layout against the
        // canonical DatReaderWriter test
        // `RegionTests::CanReadEORRegion`. If TerrainDesc mis-parses
        // by even one byte, these constants drift and this test fails
        // before the renderer hits production.
        let misc = region
            .region_misc
            .as_ref()
            .expect("HasRegionMisc bit is set in retail Region 1");
        assert_eq!(misc.version, 1, "RegionMisc.version mismatch");
        assert_eq!(
            misc.game_map_id, 0x0600_127D,
            "RegionMisc.game_map_id mismatch"
        );
        assert_eq!(
            misc.autotest_map_id, 0x0600_0261,
            "RegionMisc.autotest_map_id mismatch"
        );
        assert_eq!(
            misc.autotest_map_size, 4,
            "RegionMisc.autotest_map_size mismatch"
        );
        assert_eq!(
            misc.clear_cell_id, 0x0100_0FDE,
            "RegionMisc.clear_cell_id mismatch"
        );
        assert_eq!(
            misc.clear_monster_id, 0x0100_1612,
            "RegionMisc.clear_monster_id mismatch"
        );
    }

    #[test]
    fn region_1_game_time_has_sensible_values() {
        use crate::DatDatabase;
        let Some(path) = locate_portal_dat() else {
            eprintln!("[region_1_game_time_has_sensible_values] SKIP — no portal.dat");
            return;
        };
        let dat = DatDatabase::new(&path).expect("client_portal.dat should open");
        let bytes = dat.get_file(0x1300_0000).expect("Region 0x13000000 must exist");
        let region =
            Region::unpack(&mut Cursor::new(&bytes)).expect("Region 0x13000000 must parse");
        let gt = &region.game_time;

        eprintln!(
            "[GameTime] zero_time_of_year={} zero_year={} day_length={} days_per_year={} year_spec={:?}",
            gt.zero_time_of_year, gt.zero_year, gt.day_length, gt.days_per_year, gt.year_spec,
        );
        eprintln!(
            "  times_of_day ({}), days_of_week ({}), seasons ({}):",
            gt.times_of_day.len(),
            gt.days_of_week.len(),
            gt.seasons.len(),
        );
        for tod in &gt.times_of_day {
            eprintln!(
                "    TimeOfDay: start={} is_night={} name={:?}",
                tod.start, tod.is_night, tod.name
            );
        }
        for dow in &gt.days_of_week {
            eprintln!("    DayOfWeek: {:?}", dow);
        }
        for s in &gt.seasons {
            eprintln!("    Season: start={} name={:?}", s.start, s.name);
        }

        assert!(gt.day_length > 0.0, "day_length must be positive");
        assert!(gt.days_per_year > 0, "days_per_year must be positive");
        assert!(
            !gt.times_of_day.is_empty(),
            "at least one TimeOfDay entry required"
        );
    }

    /// Workstream Sky-E (2026-05-11): asserts every SkyObject in Dereth
    /// Region 1 DayGroup[0] resolves through the GfxObj/SetupModel chain
    /// the Sky-E asset resolver consumes. Specifically:
    ///   - Each `default_gfx_object_id` is a `0x01` GfxObj or `0x02`
    ///     SetupModel (no other prefix is supported).
    ///   - The chain Surface → SurfaceTexture → Texture resolves at
    ///     least one non-zero texture DID per SkyObject (i.e. every
    ///     sky object has at least one visible surface).
    ///   - For SetupModel entries: at least one part is present and
    ///     each part's GfxObj parses cleanly.
    ///
    /// This is the load-bearing evidence the JS-side `resolveSkyAssets`
    /// has something real to consume from `client_portal.dat`.
    #[test]
    fn workstream_sky_e_seven_skyobjects_walk_to_textures() {
        use crate::DatDatabase;
        use crate::file_type::gfx_obj::GfxObj;
        use crate::file_type::setup_model::SetupModel;
        use crate::file_type::surface::Surface;
        use crate::file_type::surface_texture::SurfaceTexture;
        use crate::file_type::texture::Texture;

        let Some(path) = locate_portal_dat() else {
            eprintln!(
                "[workstream_sky_e_seven_skyobjects_walk_to_textures] SKIP — no portal.dat"
            );
            return;
        };
        let dat = DatDatabase::new(&path).expect("portal.dat must open");
        let bytes = dat.get_file(0x1300_0000).expect("Region 0x13000000");
        let region = Region::unpack(&mut Cursor::new(&bytes))
            .expect("Region must parse");
        let sky = region.sky_info.as_ref().expect("SkyInfo");
        assert!(!sky.day_groups.is_empty(), "at least one DayGroup");

        let dg0 = &sky.day_groups[0];
        assert!(
            !dg0.sky_objects.is_empty(),
            "DayGroup[0] must carry at least one SkyObject"
        );

        // Track totals so the JS-side resolver test can compare.
        let mut total_skyobjects = 0usize;
        let mut total_gfx_objs = 0usize;     // raw 0x01 SkyObjects
        let mut total_setup_models = 0usize; // 0x02 SkyObjects
        let mut total_textures_resolved = 0usize;

        // Pre-walk to texture so any chain failure surfaces here, NOT
        // at JS resolve time in the browser.
        for (i, so) in dg0.sky_objects.iter().enumerate() {
            let id = so.default_gfx_object_id;
            if id == 0 {
                // PhatSDK sentinel — "no mesh", filtered out in JS resolver.
                continue;
            }
            total_skyobjects += 1;
            let prefix = (id >> 24) as u8;
            assert!(
                prefix == 0x01 || prefix == 0x02,
                "SkyObject[{i}].default_gfx_object_id 0x{id:08X} must be GfxObj (0x01) or SetupModel (0x02), got prefix 0x{prefix:02X}"
            );

            // Collect part GfxObj IDs (single-elem for 0x01, parts[] for 0x02).
            let part_ids: Vec<u32> = match prefix {
                0x01 => {
                    total_gfx_objs += 1;
                    vec![id]
                }
                0x02 => {
                    total_setup_models += 1;
                    let setup_bytes = dat
                        .get_file(id)
                        .unwrap_or_else(|_| panic!(
                            "SkyObject[{i}] SetupModel 0x{id:08X} must resolve in DAT"
                        ));
                    let setup = SetupModel::unpack(&mut Cursor::new(&setup_bytes))
                        .unwrap_or_else(|_| panic!(
                            "SkyObject[{i}] SetupModel 0x{id:08X} must parse"
                        ));
                    assert!(
                        !setup.parts.is_empty(),
                        "SkyObject[{i}] SetupModel 0x{id:08X} must have at least one part"
                    );
                    setup.parts.clone()
                }
                _ => unreachable!(),
            };

            // Walk every part's GfxObj → surfaces → SurfaceTexture → Texture.
            // Assert at least one texture DID resolves cleanly for the
            // SkyObject overall (some surfaces may be solid-only ARGB).
            let mut textures_for_this_sky_object = 0usize;
            for part_id in &part_ids {
                let gfx_bytes = dat
                    .get_file(*part_id)
                    .unwrap_or_else(|_| panic!(
                        "SkyObject[{i}] part 0x{part_id:08X} must resolve in DAT"
                    ));
                let gfx = GfxObj::unpack(&mut Cursor::new(&gfx_bytes))
                    .unwrap_or_else(|_| panic!(
                        "SkyObject[{i}] part 0x{part_id:08X} must parse as GfxObj"
                    ));
                for surf_id in &gfx.surfaces {
                    let Ok(sbytes) = dat.get_file(*surf_id) else { continue };
                    let Ok(surf) = Surface::unpack(&sbytes) else { continue };
                    let Some((surf_tex_id, _)) = surf.textured() else {
                        continue;
                    };
                    let Ok(stb) = dat.get_file(surf_tex_id) else { continue };
                    let Ok(surf_tex) = SurfaceTexture::unpack(&stb) else { continue };
                    let Some(tex_id) = surf_tex.highest_res() else { continue };
                    let Ok(tb) = dat.get_file(tex_id) else { continue };
                    // Texture::unpack also handles palette-bearing formats
                    // by reading the trailing palette_id only when
                    // `format == P8 | Index16`.
                    let _tex = Texture::unpack(&tb)
                        .unwrap_or_else(|_| panic!(
                            "SkyObject[{i}] surface 0x{surf_id:08X} texture 0x{tex_id:08X} must parse"
                        ));
                    textures_for_this_sky_object += 1;
                }
            }
            total_textures_resolved += textures_for_this_sky_object;
            assert!(
                textures_for_this_sky_object > 0,
                "SkyObject[{i}] (0x{id:08X}) must resolve to at least one texture"
            );
        }

        // Sanity floor: retail Dereth DayGroup[0] has 7 SkyObjects with
        // a known prefix split (6 × 0x01 + 1 × 0x02).
        assert!(
            total_skyobjects >= 7,
            "expected at least 7 visible SkyObjects in DayGroup[0], got {total_skyobjects}"
        );
        assert!(
            total_setup_models >= 1,
            "expected at least 1 SetupModel SkyObject (the physics moon 0x02000714), got {total_setup_models}"
        );
        eprintln!(
            "[workstream_sky_e_seven_skyobjects_walk_to_textures] resolved {total_textures_resolved} textures across \
             {total_skyobjects} SkyObjects ({total_gfx_objs} GfxObj + {total_setup_models} SetupModel)"
        );
    }

    /// Probe (Sky-I investigation, 2026-05-11): print AABB + bounding
    /// sphere for each celestial body in Dereth Region 0x13000000
    /// DayGroup[0]. Answer the "are the meshes too small to see"
    /// question for the renderer-side debugging.
    ///
    /// For GfxObj (0x01) bodies: walk vertex_array.vertices and compute
    /// AABB directly. For SetupModel (0x02) bodies: print AC's own
    /// authoritative `radius`, `height`, `sorting_sphere`, plus the
    /// per-part GfxObj AABB.
    ///
    /// Always passes — diagnostic-only, output via eprintln.
    #[test]
    fn sky_i_probe_sky_object_mesh_sizes() {
        use crate::DatDatabase;
        use crate::file_type::gfx_obj::GfxObj;
        use crate::file_type::setup_model::SetupModel;

        let Some(path) = locate_portal_dat() else {
            eprintln!("[sky-i-probe] SKIP — no portal.dat");
            return;
        };
        let dat = DatDatabase::new(&path).expect("portal.dat must open");
        let bytes = dat.get_file(0x1300_0000).expect("Region 0x13000000");
        let region = Region::unpack(&mut Cursor::new(&bytes))
            .expect("Region must parse");
        let sky = region.sky_info.as_ref().expect("SkyInfo");
        let dg0 = &sky.day_groups[0];

        eprintln!("\n=== [sky-i-probe] DayGroup[0] '{}' mesh sizes ===", dg0.day_name);

        fn gfx_aabb(gfx: &GfxObj) -> ((f32, f32, f32), (f32, f32, f32), usize) {
            let mut min = (f32::INFINITY, f32::INFINITY, f32::INFINITY);
            let mut max = (f32::NEG_INFINITY, f32::NEG_INFINITY, f32::NEG_INFINITY);
            for v in gfx.vertex_array.vertices.values() {
                let o = &v.origin;
                if o.x < min.0 { min.0 = o.x; }
                if o.y < min.1 { min.1 = o.y; }
                if o.z < min.2 { min.2 = o.z; }
                if o.x > max.0 { max.0 = o.x; }
                if o.y > max.1 { max.1 = o.y; }
                if o.z > max.2 { max.2 = o.z; }
            }
            (min, max, gfx.vertex_array.vertices.len())
        }

        for (i, so) in dg0.sky_objects.iter().enumerate() {
            let id = so.default_gfx_object_id;
            if id == 0 { continue; }
            let prefix = (id >> 24) as u8;
            eprintln!(
                "\n--- SkyObject[{i}] 0x{id:08X} (prefix 0x{prefix:02X}) begin={:.3} end={:.3} ---",
                so.begin_time, so.end_time
            );
            match prefix {
                0x01 => {
                    let gb = dat.get_file(id).expect("GfxObj must resolve");
                    let gfx = GfxObj::unpack(&mut Cursor::new(&gb)).expect("GfxObj must parse");
                    let (min, max, nv) = gfx_aabb(&gfx);
                    let ex = (max.0 - min.0, max.1 - min.1, max.2 - min.2);
                    let diag = (ex.0 * ex.0 + ex.1 * ex.1 + ex.2 * ex.2).sqrt();
                    eprintln!("  GfxObj: {nv} vertices");
                    eprintln!("  AABB min ({:>8.3}, {:>8.3}, {:>8.3})", min.0, min.1, min.2);
                    eprintln!("       max ({:>8.3}, {:>8.3}, {:>8.3})", max.0, max.1, max.2);
                    eprintln!("    extent ({:>8.3}, {:>8.3}, {:>8.3})", ex.0, ex.1, ex.2);
                    eprintln!("  diagonal {diag:.3} units (AC \"feet\" ≈ metres)");
                }
                0x02 => {
                    let sb = dat.get_file(id).expect("SetupModel must resolve");
                    let setup = SetupModel::unpack(&mut Cursor::new(&sb))
                        .expect("SetupModel must parse");
                    eprintln!("  SetupModel: {} parts", setup.parts.len());
                    eprintln!("  AC-authoritative: radius={:.3}  height={:.3}",
                              setup.radius, setup.height);
                    eprintln!(
                        "  sorting_sphere: origin=({:.3},{:.3},{:.3}) r={:.3}",
                        setup.sorting_sphere.center.x,
                        setup.sorting_sphere.center.y,
                        setup.sorting_sphere.center.z,
                        setup.sorting_sphere.radius
                    );
                    eprintln!(
                        "  selection_sphere: origin=({:.3},{:.3},{:.3}) r={:.3}",
                        setup.selection_sphere.center.x,
                        setup.selection_sphere.center.y,
                        setup.selection_sphere.center.z,
                        setup.selection_sphere.radius
                    );
                    for (pi, part_id) in setup.parts.iter().enumerate() {
                        let gb = match dat.get_file(*part_id) {
                            Ok(b) => b,
                            Err(_) => {
                                eprintln!("    part[{pi}] 0x{part_id:08X}: (not found)");
                                continue;
                            }
                        };
                        let gfx = match GfxObj::unpack(&mut Cursor::new(&gb)) {
                            Ok(g) => g,
                            Err(_) => {
                                eprintln!("    part[{pi}] 0x{part_id:08X}: parse failed");
                                continue;
                            }
                        };
                        let (min, max, nv) = gfx_aabb(&gfx);
                        let ex = (max.0 - min.0, max.1 - min.1, max.2 - min.2);
                        let diag = (ex.0 * ex.0 + ex.1 * ex.1 + ex.2 * ex.2).sqrt();
                        eprintln!(
                            "    part[{pi}] 0x{part_id:08X} {nv}v extent=({:.3},{:.3},{:.3}) diag={:.3}",
                            ex.0, ex.1, ex.2, diag
                        );
                    }
                }
                _ => unreachable!(),
            }
        }
        eprintln!();
    }
}

#[cfg(test)]
mod sound_probe {
    use super::*;
    use crate::DatDatabase;
    use std::io::Cursor;

    fn open_retail_region_1() -> Option<Region> {
        let path = if let Some(p) = crate::utils::get_portal_dat_path() {
            p
        } else {
            let retail = std::path::PathBuf::from(
                "/home/wbterminal/projects/RetailSmoke/dats/base/client_portal.dat",
            );
            if retail.exists() {
                retail
            } else {
                let alt =
                    std::path::PathBuf::from("/home/wbterminal/ac_base_dats/client_portal.dat");
                if alt.exists() {
                    alt
                } else {
                    eprintln!("SKIP — no retail client_portal.dat available");
                    return None;
                }
            }
        };
        let dat = DatDatabase::new(&path).expect("dat");
        let bytes = dat.get_file(0x13000000).expect("region");
        Some(Region::unpack(&mut Cursor::new(&bytes)).expect("parse"))
    }

    #[test]
    fn probe_region_1_ambient_sounds() {
        let Some(region) = open_retail_region_1() else {
            return;
        };
        eprintln!(
            "Region: name={:?}, parts_mask=0x{:04X}",
            region.region_name, region.parts_mask
        );
        if let Some(sd) = &region.sound_info {
            eprintln!("SoundDesc: {} STBs", sd.stb_descs.len());
            for (i, stb) in sd.stb_descs.iter().enumerate() {
                eprintln!(
                    "  STB[{}] id={} (0x{:08X}) sounds={}",
                    i,
                    stb.stb_id,
                    stb.stb_id,
                    stb.ambient_sounds.len()
                );
                for s in &stb.ambient_sounds {
                    eprintln!(
                        "    type={} (0x{:08X}) vol={:.2} chance={:.2} rate=[{:.1},{:.1}] cont={}",
                        s.s_type,
                        s.s_type,
                        s.volume,
                        s.base_chance,
                        s.min_rate,
                        s.max_rate,
                        s.is_continuous()
                    );
                }
            }
        } else {
            eprintln!("Region has no sound_info");
        }
    }

    /// End-to-end-ish smoke for Task A: Region 0x13000000 carries N
    /// STBs (the doc plan claims 37); enumerate them and assert every
    /// STB's `stb_id` is parseable as a `SoundTable` via the new
    /// `sound_table.rs` parser. This is the cross-cut that proves
    /// the SoundDesc → SoundTable chain works end to end against
    /// retail bytes.
    #[test]
    fn probe_region_sound_desc_stbs() {
        let Some(region) = open_retail_region_1() else {
            return;
        };
        let sd = region.sound_info.as_ref().expect("region has SoundDesc");
        let path = if let Some(p) = crate::utils::get_portal_dat_path() {
            p
        } else {
            let retail = std::path::PathBuf::from(
                "/home/wbterminal/projects/RetailSmoke/dats/base/client_portal.dat",
            );
            if retail.exists() {
                retail
            } else {
                std::path::PathBuf::from("/home/wbterminal/ac_base_dats/client_portal.dat")
            }
        };
        let dat = DatDatabase::new(&path).expect("dat");

        let total = sd.stb_descs.len();
        eprintln!(
            "[probe_region_sound_desc_stbs] Region 0x13000000 SoundDesc has {} STBs",
            total
        );
        let mut parsed = 0usize;
        let mut missing = 0usize;
        for (i, stb) in sd.stb_descs.iter().enumerate() {
            let bytes = match dat.get_file(stb.stb_id) {
                Ok(b) => b,
                Err(_) => {
                    eprintln!(
                        "  STB[{}] id=0x{:08X} MISSING from DAT (stb_not_found)",
                        i, stb.stb_id
                    );
                    missing += 1;
                    continue;
                }
            };
            let st = crate::file_type::sound_table::SoundTable::unpack(&bytes)
                .unwrap_or_else(|e| {
                    panic!(
                        "STB[{}] id=0x{:08X} parse failed: {:?}",
                        i, stb.stb_id, e
                    )
                });
            assert_eq!(st.id, stb.stb_id, "STB[{i}] id mismatch");
            parsed += 1;
        }
        eprintln!(
            "[probe_region_sound_desc_stbs] parsed {}/{} STBs cleanly ({} missing in DAT)",
            parsed, total, missing
        );
        // Doc plan asserts the count is 37; record the actual count
        // so any deviation surfaces in test output.
        eprintln!(
            "[probe_region_sound_desc_stbs] doc-claim=37, actual={}",
            total
        );
        // Soft assertion: at least most STBs should parse. Allow
        // some retail records to be missing from the DAT (the
        // `stb_not_found` diagnostic in PhatSDK confirms it can
        // happen) but require zero parse failures.
        assert!(parsed > 0, "expected at least one SoundTable to parse");
    }

    /// Verify the `is_continuous()` derived flag — at least one
    /// retail entry on Region 0x13000000 should have `base_chance == 0.0`
    /// (continuous loop). If none exist, report that as a finding.
    #[test]
    fn region_is_continuous_derived() {
        let Some(region) = open_retail_region_1() else {
            return;
        };
        let sd = region.sound_info.as_ref().expect("region has SoundDesc");
        let mut total_entries = 0usize;
        let mut continuous_count = 0usize;
        let mut first_continuous: Option<(usize, AmbientSoundDesc)> = None;
        for (i, stb) in sd.stb_descs.iter().enumerate() {
            for s in &stb.ambient_sounds {
                total_entries += 1;
                if s.is_continuous() {
                    continuous_count += 1;
                    if first_continuous.is_none() {
                        first_continuous = Some((i, s.clone()));
                    }
                }
            }
        }
        eprintln!(
            "[region_is_continuous_derived] {} continuous / {} total ambient entries",
            continuous_count, total_entries
        );
        if let Some((stb_idx, s)) = &first_continuous {
            eprintln!(
                "  first continuous: STB[{stb_idx}] s_type=0x{:08X} vol={:.2} \
                 rate=[{:.1},{:.1}] base_chance={}",
                s.s_type, s.volume, s.min_rate, s.max_rate, s.base_chance
            );
            assert!(s.is_continuous(), "derived flag must return true for base_chance == 0");
            assert_eq!(s.base_chance, 0.0, "continuous entries have base_chance == 0");
        } else {
            // Per the agent prompt: if none exist, weaken to a "no
            // continuous entries in retail Region 13" finding rather
            // than failing the test. Print the finding clearly.
            eprintln!(
                "[region_is_continuous_derived] FINDING: zero continuous \
                 (base_chance == 0.0) entries across {} ambient entries in \
                 retail Region 0x13000000 SoundDesc; every entry is a \
                 probability-rolled trigger.",
                total_entries
            );
        }
    }

    /// Verify the `stb_index: i32` fix — at least one SceneType on
    /// Region 0x13000000 should carry `stb_index == -1` (no ambient
    /// for that scene type), proving the i32 change preserves the
    /// sentinel. If every SceneType has a valid index, report it as
    /// a no-op safety improvement.
    #[test]
    fn region_stb_index_negative_sentinel() {
        let Some(region) = open_retail_region_1() else {
            return;
        };
        let scene_info = region
            .scene_info
            .as_ref()
            .expect("region has SceneDesc");
        let total_scene_types = scene_info.scene_types.len();
        let mut neg_count = 0usize;
        let mut max_valid: i32 = -1;
        let mut min_valid: i32 = i32::MAX;
        for st in &scene_info.scene_types {
            if st.stb_index == -1 {
                neg_count += 1;
            } else if st.stb_index >= 0 {
                max_valid = max_valid.max(st.stb_index);
                min_valid = min_valid.min(st.stb_index);
            }
        }
        eprintln!(
            "[region_stb_index_negative_sentinel] {} of {} SceneTypes have stb_index == -1 \
             (valid range: {}..={})",
            neg_count, total_scene_types, min_valid, max_valid
        );
        if neg_count > 0 {
            eprintln!(
                "[region_stb_index_negative_sentinel] CONFIRMED: i32 fix preserves \
                 {} retail '-1' sentinels that would have wrapped to 0xFFFFFFFF as u32",
                neg_count
            );
        } else {
            eprintln!(
                "[region_stb_index_negative_sentinel] FINDING: retail Region 0x13000000 \
                 has no SceneType with stb_index == -1; every SceneType is bound to a \
                 valid SoundDesc STB. The i32 change is still a safety improvement (the \
                 wire field is signed per PhatSDK) but has no observable effect on retail."
            );
        }
        // Also bound-check that no valid index goes off the end of
        // SoundDesc.stb_descs — defensive consistency check.
        if let Some(sd) = &region.sound_info {
            assert!(
                max_valid < sd.stb_descs.len() as i32 || neg_count == total_scene_types,
                "max stb_index {max_valid} out of bounds for {} STBs",
                sd.stb_descs.len()
            );
        }
    }
}
