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
//! `[SoundInfo, SceneInfo, SkyInfo, TerrainInfo, RegionMisc]` *not* in mask-bit
//! order — but each is gated on its specific bit. `TerrainInfo` is unconditional.

use crate::file_type::game_time::GameTime;
use crate::utils::{align_boundary, read_pstring};
use binrw::{
    BinRead, BinResult,
    io::{Read, Seek},
};

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
#[derive(Debug, Clone)]
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
}

/// Top-level skybox descriptor — owns N DayGroups (one is active per in-world
/// day; selector hashes `current_day`/`current_year` against `num_day_groups`).
#[derive(Debug, Clone)]
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

        let num_day_groups = u32::read_le(reader)?;
        let mut day_groups = Vec::with_capacity(num_day_groups as usize);
        for _ in 0..num_day_groups {
            day_groups.push(DayGroup::unpack(reader)?);
        }

        Ok(SkyDesc {
            tick_size,
            light_tick_size,
            day_groups,
        })
    }
}

/// One in-world day archetype (e.g. "Clear", "Cloudy", "Rainy"). Owns its
/// celestial fleet (`sky_objects`) + lighting keyframes (`sky_time`).
#[derive(Debug, Clone)]
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
        let day_name = read_pstring(reader, 2)?;
        align_boundary(reader, 4)?;

        // PhatSDK SkyDesc.cpp:117-125 — SkyObjects come BEFORE SkyTime
        // (counter-intuitive, but matches both the schema and the C++
        // UnPack). The order matters because each SkyTimeOfDay's
        // SkyObjectReplace entries are back-referenced to a SkyObject
        // index from this array.
        let num_sky_objects = u32::read_le(reader)?;
        let mut sky_objects = Vec::with_capacity(num_sky_objects as usize);
        for _ in 0..num_sky_objects {
            sky_objects.push(SkyObject::unpack(reader)?);
        }

        let num_sky_time = u32::read_le(reader)?;
        let mut sky_time = Vec::with_capacity(num_sky_time as usize);
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
}

/// A persistent celestial billboard (sun, moon, milky way, etc) that arcs
/// across the dome each day. `default_gfx_object_id` is the `0x01xxxxxx` GfxObj
/// DID — feed it into `crate::file_type::gfx_obj::GfxObj` to extract the
/// mesh + textures.
#[derive(Debug, Clone)]
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
}

/// One lighting keyframe in a `DayGroup`'s 24-hour cycle. AC interpolates
/// directional + ambient color/brightness + fog between consecutive entries.
#[derive(Debug, Clone)]
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
        let mut sky_obj_replace = Vec::with_capacity(num_replace as usize);
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
}

/// Per-keyframe override that swaps a `SkyObject`'s gfx mesh + color params.
/// `object_index` indexes into the owning `DayGroup.sky_objects` array.
#[derive(Debug, Clone)]
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
}

/// Ambient sound bank reference (one STB entry).
#[derive(Debug, Clone)]
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
}

#[derive(Debug, Clone)]
pub struct AmbientSTBDesc {
    pub stb_id: u32,
    pub ambient_sounds: Vec<AmbientSoundDesc>,
}

impl AmbientSTBDesc {
    pub fn unpack<R: Read + Seek>(reader: &mut R) -> BinResult<Self> {
        let stb_id = u32::read_le(reader)?;
        let num = u32::read_le(reader)?;
        let mut ambient_sounds = Vec::with_capacity(num as usize);
        for _ in 0..num {
            ambient_sounds.push(AmbientSoundDesc::unpack(reader)?);
        }
        Ok(AmbientSTBDesc {
            stb_id,
            ambient_sounds,
        })
    }
}

#[derive(Debug, Clone)]
pub struct SoundDesc {
    pub stb_descs: Vec<AmbientSTBDesc>,
}

impl SoundDesc {
    pub fn unpack<R: Read + Seek>(reader: &mut R) -> BinResult<Self> {
        let num = u32::read_le(reader)?;
        let mut stb_descs = Vec::with_capacity(num as usize);
        for _ in 0..num {
            stb_descs.push(AmbientSTBDesc::unpack(reader)?);
        }
        Ok(SoundDesc { stb_descs })
    }
}

/// One scene category (e.g. "GrassPlains"). Each carries a flat list of Scene
/// DIDs (`0x12xxxxxx`) — terrain landblocks sample these to scatter props.
#[derive(Debug, Clone)]
pub struct SceneType {
    pub stb_index: u32,
    /// `0x12xxxxxx` Scene DIDs.
    pub scenes: Vec<u32>,
}

impl SceneType {
    pub fn unpack<R: Read + Seek>(reader: &mut R) -> BinResult<Self> {
        let stb_index = u32::read_le(reader)?;
        let num = u32::read_le(reader)?;
        let mut scenes = Vec::with_capacity(num as usize);
        for _ in 0..num {
            scenes.push(u32::read_le(reader)?);
        }
        Ok(SceneType { stb_index, scenes })
    }
}

#[derive(Debug, Clone)]
pub struct SceneDesc {
    pub scene_types: Vec<SceneType>,
}

impl SceneDesc {
    pub fn unpack<R: Read + Seek>(reader: &mut R) -> BinResult<Self> {
        let num = u32::read_le(reader)?;
        let mut scene_types = Vec::with_capacity(num as usize);
        for _ in 0..num {
            scene_types.push(SceneType::unpack(reader)?);
        }
        Ok(SceneDesc { scene_types })
    }
}

/// Per-terrain-type alpha mask + texture. Used by the `TexMerge` blender.
#[derive(Debug, Clone)]
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
}

/// Road alpha-blend overlay.
#[derive(Debug, Clone)]
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
}

/// Texture-merger sub-record describing how AC blends per-corner terrain
/// textures into a single landblock surface.
#[derive(Debug, Clone)]
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
}

#[derive(Debug, Clone)]
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
}

#[derive(Debug, Clone)]
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
        let mut corner_terrain_maps = Vec::with_capacity(n as usize);
        for _ in 0..n {
            corner_terrain_maps.push(TerrainAlphaMap::unpack(reader)?);
        }

        let n = u32::read_le(reader)?;
        let mut side_terrain_maps = Vec::with_capacity(n as usize);
        for _ in 0..n {
            side_terrain_maps.push(TerrainAlphaMap::unpack(reader)?);
        }

        let n = u32::read_le(reader)?;
        let mut road_maps = Vec::with_capacity(n as usize);
        for _ in 0..n {
            road_maps.push(RoadAlphaMap::unpack(reader)?);
        }

        let n = u32::read_le(reader)?;
        let mut terrain_desc = Vec::with_capacity(n as usize);
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
}

#[derive(Debug, Clone)]
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
}

/// Named terrain category (e.g. "Grasslands", "BarrenRock"). `terrain_color`
/// is the radar/minimap color for this terrain.
#[derive(Debug, Clone)]
pub struct TerrainType {
    pub terrain_name: String,
    pub terrain_color: u32,
    pub scene_types: Vec<u32>,
}

impl TerrainType {
    pub fn unpack<R: Read + Seek>(reader: &mut R) -> BinResult<Self> {
        let terrain_name = read_pstring(reader, 2)?;
        align_boundary(reader, 4)?;
        let terrain_color = u32::read_le(reader)?;
        let num = u32::read_le(reader)?;
        let mut scene_types = Vec::with_capacity(num as usize);
        for _ in 0..num {
            scene_types.push(u32::read_le(reader)?);
        }
        Ok(TerrainType {
            terrain_name,
            terrain_color,
            scene_types,
        })
    }
}

/// Region-level terrain palette + texture-blending rules. Unconditional —
/// every Region has one, even ones without SkyInfo.
#[derive(Debug, Clone)]
pub struct TerrainDesc {
    pub terrain_types: Vec<TerrainType>,
    pub land_surfaces: LandSurf,
}

impl TerrainDesc {
    pub fn unpack<R: Read + Seek>(reader: &mut R) -> BinResult<Self> {
        let num = u32::read_le(reader)?;
        let mut terrain_types = Vec::with_capacity(num as usize);
        for _ in 0..num {
            terrain_types.push(TerrainType::unpack(reader)?);
        }
        let land_surfaces = LandSurf::unpack(reader)?;
        Ok(TerrainDesc {
            terrain_types,
            land_surfaces,
        })
    }
}

/// Realm-wide miscellany — autotest map ID, clear-cell ID, etc.
#[derive(Debug, Clone)]
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
}

/// AC's per-realm descriptor — `0x13000000` is the only Region currently
/// shipped in retail `client_portal.dat`. Its `region_number` field reads
/// 1 (per PhatSDK convention "Region 1 = Dereth"), but the file ID itself
/// is the namespace-prefix-only `0x13000000`. The `0x1300xxxx` namespace
/// reserves room for alternate realms (e.g. apartment overlays) but they
/// are not present in current retail.
#[derive(Debug, Clone)]
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
        let region_name = read_pstring(reader, 2)?;
        align_boundary(reader, 4)?;

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
}
