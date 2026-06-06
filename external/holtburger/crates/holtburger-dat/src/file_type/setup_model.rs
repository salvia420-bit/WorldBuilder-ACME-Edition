use crate::graphics::Frame;
use binrw::{
    BinRead, BinResult, BinWrite,
    io::{Read, Seek, Write},
};
use holtburger_common::{Sphere, Vector3};
use std::collections::HashMap;
use std::io::Cursor;

#[derive(Debug, Clone, BinRead, BinWrite, serde::Serialize)]
#[br(little)]
#[bw(little)]
pub struct CylSphere {
    pub origin: Vector3,
    pub radius: f32,
    pub height: f32,
}

#[derive(Debug, Clone, BinRead, BinWrite, serde::Serialize)]
#[br(little)]
#[bw(little)]
pub struct LocationType {
    pub part_id: i32,
    pub frame: Frame,
}

#[derive(Debug, Clone, BinRead, BinWrite, serde::Serialize)]
#[br(little)]
#[bw(little)]
pub struct LightInfo {
    pub viewer_space_location: Frame,
    pub color: u32,
    pub intensity: f32,
    pub falloff: f32,
    pub cone_angle: f32,
}

/// Wire-level AnimationHook: `[u32 hook_type][i32 direction][variant payload][0..3 align pad]`.
///
/// `data` holds the variant payload PLUS the trailing 0..3 alignment-pad
/// bytes that retail's `PackObj::ALIGN_PTR(addr, &size)` emits after every
/// hook (acclient.c:296286 / 300284, called from `CAnimHook::UnPackHook`
/// at acclient.c:343027 and `CAnimHook::PackHook` at acclient.c:342168).
/// `write()` dumps `data` verbatim, so the round-trip is byte-equal.
///
/// Variant payload sizes match the 27-case `CAnimHook::UnPackHook` switch
/// (acclient.c:342737–343026). The `ReplaceObject` variant follows
/// `AnimPartChange::UnPack` (acclient.c:471699): 1 byte `part_index` then
/// `Unpack_AsDataIDOfKnownType(0x01000000)` for the GfxObj part-id
/// (acclient.c:667732).
#[derive(Debug, Clone, serde::Serialize)]
pub struct AnimationHook {
    pub hook_type: u32,
    /// `AnimHookDir`: Backward=-1, Both=0, Forward=1 (acclient.h:7311). The
    /// retail enum also defines UNKNOWN=0xFFFFFFFE (-2), but that is a
    /// constructor default that `CAnimHook::UnPackHook` overwrites with the
    /// wire value before any fire (acclient.c:339695), so it is never
    /// serialized — a full portal.dat survey (2026-06-05) found zero hooks
    /// carrying -2. Consumers should treat any value outside {-1,0,1} as
    /// Both(0) / unconditional-fire and must NOT blanket-negate it (see the
    /// reverse-segment clamp in web `build_concatenated_motion_frames`).
    pub direction: i32,
    pub data: Vec<u8>,
}

impl AnimationHook {
    pub fn read<R: Read + Seek>(reader: &mut R) -> BinResult<Self> {
        let hook_type = u32::read_le(reader)?;
        let direction = i32::read_le(reader)?;

        let payload_start = reader.stream_position()?;
        let mut data = match hook_type {
            0 => Vec::new(),                       // NoOp
            1 => read_exact_payload(reader, 4)?,   // Sound (gid_: u32)
            2 => read_exact_payload(reader, 4)?,   // SoundTable (sound_type_: u32)
            3 => read_exact_payload(reader, 28)?,  // Attack (AttackCone: i32 + 4 f32 + 2 f32)
            4 => Vec::new(),                       // AnimationDone
            5 => read_replace_object_payload(reader)?,
            6 => read_exact_payload(reader, 4)?,   // Ethereal (ethereal: i32)
            7 => read_exact_payload(reader, 16)?,  // TransparentPart (part u32 + 3 f32)
            8 => read_exact_payload(reader, 12)?,  // Luminous (3 f32)
            9 => read_exact_payload(reader, 16)?,  // LuminousPart (part u32 + 3 f32)
            10 => read_exact_payload(reader, 12)?, // Diffuse (3 f32)
            11 => read_exact_payload(reader, 16)?, // DiffusePart (part u32 + 3 f32)
            12 => read_exact_payload(reader, 8)?,  // Scale (2 f32)
            13 => read_exact_payload(reader, 40)?, // CreateParticle (gid + part + Frame + emitter_id)
            14 => read_exact_payload(reader, 4)?,  // DestroyParticle (emitter_id u32)
            15 => read_exact_payload(reader, 4)?,  // StopParticle (emitter_id u32)
            16 => read_exact_payload(reader, 4)?,  // NoDraw (_no_draw: i32)
            17 => Vec::new(),                      // DefaultScript
            18 => read_exact_payload(reader, 4)?,  // DefaultScriptPart (_part_index: u32)
            19 => read_exact_payload(reader, 8)?,  // CallPES (pes u32 + pause f32)
            20 => read_exact_payload(reader, 12)?, // Transparent (3 f32)
            // NOTE: DRW dats.xml labels `SoundTweakedHook` fields as
            // `Priority, Probability, Volume`, retail UnPack reads them
            // as `prob, prio, vol`. Cite: acclient.c:343123
            // (SoundTweakedHook::UnPack). No on-wire impact (still 16
            // bytes / 3 floats) — we store the payload as opaque bytes,
            // so this cite is for any future code that slots the floats
            // into named fields. Trusting DRW's order would swap prob↔prio.
            // See [[feedback_dat_parser_mislabels]] memory for the full pattern.
            //
            // 2026-06-04: the wasm getters that DO slot these floats
            // (apps/holtburger-web/src/lib.rs `soundProbability` /
            // `soundPriority`, both getter pairs) now read RETAIL order
            // — on-disk `[gid@0, prob@4, prio@8, vol@12]`
            // (acclient.c:343129-343138) — i.e. probability<-[4..8],
            // priority<-[8..12]. They previously read the swapped
            // DRW-labelled order; corrected so the OFFSET-4 PlayProbability
            // gate fires on the right float.
            21 => read_exact_payload(reader, 16)?, // SoundTweaked (gid + 3 f32)
            22 => read_exact_payload(reader, 12)?, // SetOmega (Vector3)
            23 => read_exact_payload(reader, 8)?,  // TextureVelocity (2 f32)
            24 => read_exact_payload(reader, 12)?, // TextureVelocityPart (part u32 + 2 f32)
            25 => read_exact_payload(reader, 4)?,  // SetLight (_lights_on: i32)
            26 => read_exact_payload(reader, 40)?, // CreateBlockingParticle (same as CreateParticle)
            _ => {
                return Err(binrw::Error::Custom {
                    pos: reader.stream_position()?,
                    err: Box::new(format!(
                        "Unsupported AnimationHook type: 0x{:08X}",
                        hook_type
                    )),
                });
            }
        };

        // Mirror retail `PackObj::ALIGN_PTR(addr, &size)` — pad to a
        // 4-byte boundary after each hook's variant payload. Only
        // ReplaceObject (3 or 5 bytes) naturally requires padding; all
        // other variants already end on a 4-byte boundary, so the loop
        // is a no-op for them.
        let payload_end = reader.stream_position()?;
        let bytes_read = payload_end - payload_start;
        let pad_len = ((4 - (bytes_read % 4)) % 4) as usize;
        if pad_len > 0 {
            let mut pad_buf = vec![0u8; pad_len];
            reader.read_exact(&mut pad_buf)?;
            data.extend_from_slice(&pad_buf);
        }

        Ok(Self {
            hook_type,
            direction,
            data,
        })
    }

    pub fn write<W: Write + Seek>(&self, writer: &mut W) -> BinResult<()> {
        self.hook_type.write_le(writer)?;
        self.direction.write_le(writer)?;
        writer.write_all(&self.data)?;
        Ok(())
    }

    /// If this hook is a `CreateParticle` (type 13) or `CreateBlockingParticle`
    /// (type 26), decode the 40-byte payload into named fields.
    ///
    /// Retail wire layout, verbatim from `CreateParticleHook::UnPack`
    /// (`acclient.c` decomp, offset `0x005278A0`):
    /// ```text
    ///   uint32 emitter_info_id     // ParticleEmitter (0x32xxxxxx) DID
    ///   uint32 part_index          // Setup part this emitter attaches to
    ///   Frame  offset              // Vector3 origin + Quaternion (w,x,y,z)
    ///   uint32 emitter_id          // Per-script handle (Stop/Destroy keying)
    /// ```
    /// The struct declaration in `acclient.h` ("/* 6324 */ struct __cppobj
    /// CreateParticleHook ... { IDClass<_tagDataID,32,0> emitter_info_id;
    /// unsigned int part_index; Frame offset; unsigned int emitter_id; }")
    /// matches this Pack/UnPack ordering byte-for-byte.
    ///
    // NOTE: DRW dats.xml labels `CreateParticleHook.EmitterInfoId` as a
    // `<vector>` of `QualifiedDataId`, retail packs scalar u32.
    // Cite: acclient.c:343190 (CreateParticleHook::Pack at offset
    // `0x00527850`) + acclient.h:57526 (`IDClass<_tagDataID,32,0>` is a
    // single 4-byte id). Trusting DRW's `<vector>` tag would read a
    // bogus length prefix and explode the next 36 bytes of payload.
    // Same family of trap as GfxObjId/HwGfxObjId in ParticleEmitterInfo
    // (0x32 file_type). See [[feedback_dat_parser_mislabels]] and
    // [[reference_ac_particle_emitter_format]] memories.
    pub fn as_create_particle(&self) -> Option<CreateParticleHookPayload> {
        if self.hook_type != 13 && self.hook_type != 26 {
            return None;
        }
        if self.data.len() != 40 {
            return None;
        }
        let mut cursor = Cursor::new(&self.data[..]);
        CreateParticleHookPayload::read(&mut cursor).ok()
    }
}

/// Parsed view of a CreateParticle / CreateBlockingParticle hook payload.
///
/// Fields are in **wire order** (matches `CreateParticleHook::Pack` /
/// `UnPack` at `0x00527850` / `0x005278A0` in retail). Pack with
/// `write` to round-trip back to the original 40-byte slice.
#[derive(Debug, Clone, BinRead, BinWrite, PartialEq, serde::Serialize)]
#[br(little)]
#[bw(little)]
pub struct CreateParticleHookPayload {
    /// ParticleEmitter DID (file_type prefix `0x32`). Single scalar uint
    /// despite `dats.xml`'s `<vector>` tag — see `as_create_particle`
    /// for the cite.
    pub emitter_info_id: u32,
    /// Index into the parent `SetupModel.parts` table — which part of
    /// the model the emitter attaches to (`0xFFFFFFFF` for "root").
    pub part_index: u32,
    /// Local-space spawn transform (origin xyz + orientation wxyz).
    pub offset: Frame,
    /// Per-script handle. `DestroyParticleHook` / `StopParticleHook`
    /// reference this id to tear the emitter down.
    pub emitter_id: u32,
}

impl CreateParticleHookPayload {
    /// Pack into a fresh 40-byte buffer (mirrors retail
    /// `CreateParticleHook::Pack`).
    pub fn to_bytes(&self) -> [u8; 40] {
        let mut buf = [0u8; 40];
        {
            let mut cursor = Cursor::new(&mut buf[..]);
            self.write_le(&mut cursor).expect("40-byte buffer is sufficient");
        }
        buf
    }
}

fn read_exact_payload<R: Read + Seek>(reader: &mut R, payload_size: usize) -> BinResult<Vec<u8>> {
    let mut data = vec![0u8; payload_size];
    if payload_size > 0 {
        reader.read_exact(&mut data)?;
    }
    Ok(data)
}

fn read_replace_object_payload<R: Read + Seek>(reader: &mut R) -> BinResult<Vec<u8>> {
    let mut data = Vec::with_capacity(5);

    // NOTE: DRW dats.xml labels `ReplaceObjectHook.PartIndex` as `ushort`
    // (2 bytes), retail packs scalar u8 (1 byte).
    // Cite: acclient.c:471699 (AnimPartChange::UnPack). Trusting DRW's
    // `ushort` label would over-read by 1 byte and silently desync every
    // AnimFrame/PhysicsScript containing a ReplaceObject hook.
    // See [[feedback_dat_parser_mislabels]] memory for the full pattern.
    let part_index = u8::read(reader)?;
    data.push(part_index);

    // `Unpack_AsDataIDOfKnownType(0x01000000)` (acclient.c:667732):
    //   read u16 hi; if (hi & 0x8000) read another u16 lo.
    // Total packed-id is either 2 or 4 bytes.
    let upper = u16::read_le(reader)?;
    data.extend_from_slice(&upper.to_le_bytes());
    if (upper & 0x8000) != 0 {
        let lower = u16::read_le(reader)?;
        data.extend_from_slice(&lower.to_le_bytes());
    }

    Ok(data)
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct AnimationFrame {
    pub frames: Vec<Frame>,
    pub hooks: Vec<AnimationHook>,
}

impl AnimationFrame {
    pub fn read<R: Read + Seek>(reader: &mut R, num_parts: u32) -> BinResult<Self> {
        let mut frames = Vec::with_capacity(num_parts as usize);
        for _ in 0..num_parts {
            frames.push(Frame::read_le(reader)?);
        }

        let num_hooks = u32::read_le(reader)?;
        let mut hooks = Vec::with_capacity(num_hooks as usize);
        for _ in 0..num_hooks {
            hooks.push(AnimationHook::read(reader)?);
        }

        Ok(Self { frames, hooks })
    }

    pub fn write<W: Write + Seek>(&self, writer: &mut W) -> BinResult<()> {
        for frame in &self.frames {
            frame.write_le(writer)?;
        }
        (self.hooks.len() as u32).write_le(writer)?;
        for hook in &self.hooks {
            hook.write(writer)?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct PlacementType {
    pub anim_frame: AnimationFrame,
}

impl PlacementType {
    pub fn read<R: Read + Seek>(reader: &mut R, num_parts: u32) -> BinResult<Self> {
        Ok(Self {
            anim_frame: AnimationFrame::read(reader, num_parts)?,
        })
    }

    pub fn write<W: Write + Seek>(&self, writer: &mut W) -> BinResult<()> {
        self.anim_frame.write(writer)
    }
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct SetupModel {
    pub id: u32,
    pub flags: u32,
    pub parts: Vec<u32>,
    pub parent_index: Vec<u32>,
    pub default_scale: Vec<Vector3>,
    pub holding_locations: HashMap<i32, LocationType>,
    pub connection_points: HashMap<i32, LocationType>,
    pub placement_frames: HashMap<i32, PlacementType>,
    pub cyl_spheres: Vec<CylSphere>,
    pub spheres: Vec<Sphere>,
    pub height: f32,
    pub radius: f32,
    pub step_up: f32,
    pub step_down: f32,
    pub sorting_sphere: Sphere,
    pub selection_sphere: Sphere,
    pub lights: HashMap<i32, LightInfo>,
    pub default_animation: Option<u32>,
    pub default_script: Option<u32>,
    pub default_motion_table: Option<u32>,
    pub default_sound_table: Option<u32>,
    pub default_script_table: Option<u32>,
}

impl SetupModel {
    pub fn read<R: Read + Seek>(reader: &mut R) -> BinResult<Self> {
        Self::unpack(reader)
    }

    fn decode_optional_resource_id(raw: u32) -> Option<u32> {
        (raw != 0).then_some(raw)
    }

    pub fn unpack<R: Read + Seek>(reader: &mut R) -> BinResult<Self> {
        let id = u32::read_le(reader)?;
        let flags = u32::read_le(reader)?;

        let num_parts = u32::read_le(reader)?;
        let mut parts = Vec::with_capacity(num_parts as usize);
        for _ in 0..num_parts {
            parts.push(u32::read_le(reader)?);
        }

        let mut parent_index = Vec::new();
        if (flags & 0x01) != 0 {
            // HasParent
            for _ in 0..num_parts {
                parent_index.push(u32::read_le(reader)?);
            }
        }

        let mut default_scale = Vec::new();
        if (flags & 0x02) != 0 {
            // HasDefaultScale
            for _ in 0..num_parts {
                default_scale.push(Vector3::read_le(reader)?);
            }
        }

        // HoldingLocations (Dict)
        let num_holding = u32::read_le(reader)?;
        let mut holding_locations = HashMap::new();
        for _ in 0..num_holding {
            let key = i32::read_le(reader)?;
            holding_locations.insert(key, LocationType::read_le(reader)?);
        }

        // ConnectionPoints (Dict)
        let num_conn = u32::read_le(reader)?;
        let mut connection_points = HashMap::new();
        for _ in 0..num_conn {
            let key = i32::read_le(reader)?;
            connection_points.insert(key, LocationType::read_le(reader)?);
        }

        // PlacementFrames (Dict)
        let num_placements = i32::read_le(reader)?;
        if num_placements < 0 {
            return Err(binrw::Error::Custom {
                pos: reader.stream_position()?,
                err: Box::new(format!(
                    "SetupModel 0x{id:08X} declared negative placement count {num_placements}"
                )),
            });
        }
        let mut placement_frames = HashMap::with_capacity(num_placements as usize);
        for _ in 0..num_placements as usize {
            let key = i32::read_le(reader)?;
            placement_frames.insert(key, PlacementType::read(reader, num_parts)?);
        }

        // CylSpheres (ACE uses a standard u32 count here, not a compressed array count)
        let num_cyl = u32::read_le(reader)?;
        let mut cyl_spheres = Vec::with_capacity(num_cyl as usize);
        for _ in 0..num_cyl {
            cyl_spheres.push(CylSphere::read_le(reader)?);
        }

        // Spheres (ACE uses a standard u32 count here, not a compressed array count)
        let num_sph = u32::read_le(reader)?;
        let mut spheres = Vec::with_capacity(num_sph as usize);
        for _ in 0..num_sph {
            spheres.push(Sphere::read_le(reader)?);
        }

        let height = f32::read_le(reader)?;
        let radius = f32::read_le(reader)?;
        let step_up = f32::read_le(reader)?;
        let step_down = f32::read_le(reader)?;

        let sorting_sphere = Sphere::read_le(reader)?;
        let selection_sphere = Sphere::read_le(reader)?;

        // Lights (Dict)
        let num_lights = u32::read_le(reader)?;
        let mut lights = HashMap::new();
        for _ in 0..num_lights {
            let key = i32::read_le(reader)?;
            lights.insert(key, LightInfo::read_le(reader)?);
        }

        let default_animation = Self::decode_optional_resource_id(u32::read_le(reader)?);
        let default_script = Self::decode_optional_resource_id(u32::read_le(reader)?);
        let default_motion_table = Self::decode_optional_resource_id(u32::read_le(reader)?);
        let default_sound_table = Self::decode_optional_resource_id(u32::read_le(reader)?);
        let default_script_table = Self::decode_optional_resource_id(u32::read_le(reader)?);

        Ok(SetupModel {
            id,
            flags,
            parts,
            parent_index,
            default_scale,
            holding_locations,
            connection_points,
            placement_frames,
            cyl_spheres,
            spheres,
            height,
            radius,
            step_up,
            step_down,
            sorting_sphere,
            selection_sphere,
            lights,
            default_animation,
            default_script,
            default_motion_table,
            default_sound_table,
            default_script_table,
        })
    }

    pub fn pack<W: Write + Seek>(&self, writer: &mut W) -> BinResult<()> {
        self.id.write_le(writer)?;
        self.flags.write_le(writer)?;

        (self.parts.len() as u32).write_le(writer)?;
        for &part in &self.parts {
            part.write_le(writer)?;
        }

        if (self.flags & 0x01) != 0 {
            for &idx in &self.parent_index {
                idx.write_le(writer)?;
            }
        }

        if (self.flags & 0x02) != 0 {
            for scale in &self.default_scale {
                scale.write_le(writer)?;
            }
        }

        (self.holding_locations.len() as u32).write_le(writer)?;
        let mut hold_keys: Vec<_> = self.holding_locations.keys().collect();
        hold_keys.sort();
        for &k in hold_keys {
            k.write_le(writer)?;
            self.holding_locations.get(&k).unwrap().write_le(writer)?;
        }

        (self.connection_points.len() as u32).write_le(writer)?;
        let mut conn_keys: Vec<_> = self.connection_points.keys().collect();
        conn_keys.sort();
        for &k in conn_keys {
            k.write_le(writer)?;
            self.connection_points.get(&k).unwrap().write_le(writer)?;
        }

        (self.placement_frames.len() as i32).write_le(writer)?;
        let mut place_keys: Vec<_> = self.placement_frames.keys().collect();
        place_keys.sort();
        for &k in place_keys {
            k.write_le(writer)?;
            self.placement_frames.get(&k).unwrap().write(writer)?;
        }

        (self.cyl_spheres.len() as u32).write_le(writer)?;
        for cyl in &self.cyl_spheres {
            cyl.write_le(writer)?;
        }

        (self.spheres.len() as u32).write_le(writer)?;
        for sph in &self.spheres {
            sph.write_le(writer)?;
        }

        self.height.write_le(writer)?;
        self.radius.write_le(writer)?;
        self.step_up.write_le(writer)?;
        self.step_down.write_le(writer)?;

        self.sorting_sphere.write_le(writer)?;
        self.selection_sphere.write_le(writer)?;

        (self.lights.len() as u32).write_le(writer)?;
        let mut light_keys: Vec<_> = self.lights.keys().collect();
        light_keys.sort();
        for &k in light_keys {
            k.write_le(writer)?;
            self.lights.get(&k).unwrap().write_le(writer)?;
        }

        let trailer = [
            self.default_animation,
            self.default_script,
            self.default_motion_table,
            self.default_sound_table,
            self.default_script_table,
        ];
        for value in trailer {
            value.unwrap_or(0).write_le(writer)?;
        }

        Ok(())
    }

    pub fn prune(&mut self) {
        // Drain the lamp oil
        self.lights.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn test_setup_model_prune() {
        let mut setup = SetupModel {
            id: 0x02000001,
            flags: 0,
            parts: vec![0, 1],
            parent_index: vec![],
            default_scale: vec![],
            holding_locations: HashMap::new(),
            connection_points: HashMap::new(),
            placement_frames: HashMap::new(),
            cyl_spheres: vec![],
            spheres: vec![],
            height: 1.0,
            radius: 1.0,
            step_up: 0.1,
            step_down: 0.1,
            sorting_sphere: Sphere {
                center: Vector3::zero(),
                radius: 1.0,
            },
            selection_sphere: Sphere {
                center: Vector3::zero(),
                radius: 1.0,
            },
            lights: HashMap::new(),
            default_animation: None,
            default_script: None,
            default_motion_table: None,
            default_sound_table: None,
            default_script_table: None,
        };

        setup.lights.insert(
            1,
            LightInfo {
                viewer_space_location: Frame::default(),
                color: 0xFFFFFFFF,
                intensity: 1.0,
                falloff: 1.0,
                cone_angle: 1.0,
            },
        );

        assert_eq!(setup.lights.len(), 1);
        setup.prune();
        assert_eq!(setup.lights.len(), 0);

        let mut data = Vec::new();
        let mut writer = Cursor::new(&mut data);
        setup.pack(&mut writer).unwrap();

        let mut reader = Cursor::new(data);
        let unpacked = SetupModel::unpack(&mut reader).unwrap();
        assert_eq!(unpacked.lights.len(), 0);
        assert_eq!(unpacked.parts.len(), 2);
    }

    #[test]
    fn test_setup_model_sparse_trailer_placeholders_round_trip_as_none() {
        let setup = SetupModel {
            id: 0x02000002,
            flags: 0,
            parts: vec![0],
            parent_index: vec![],
            default_scale: vec![],
            holding_locations: HashMap::new(),
            connection_points: HashMap::new(),
            placement_frames: HashMap::new(),
            cyl_spheres: vec![],
            spheres: vec![],
            height: 1.0,
            radius: 1.0,
            step_up: 0.1,
            step_down: 0.1,
            sorting_sphere: Sphere {
                center: Vector3::zero(),
                radius: 1.0,
            },
            selection_sphere: Sphere {
                center: Vector3::zero(),
                radius: 1.0,
            },
            lights: HashMap::new(),
            default_animation: None,
            default_script: None,
            default_motion_table: None,
            default_sound_table: None,
            default_script_table: Some(0x0E00_0123),
        };

        let mut data = Vec::new();
        let mut writer = Cursor::new(&mut data);
        setup.pack(&mut writer).unwrap();

        let mut reader = Cursor::new(data);
        let unpacked = SetupModel::unpack(&mut reader).unwrap();

        assert_eq!(unpacked.default_animation, None);
        assert_eq!(unpacked.default_script, None);
        assert_eq!(unpacked.default_motion_table, None);
        assert_eq!(unpacked.default_sound_table, None);
        assert_eq!(unpacked.default_script_table, Some(0x0E00_0123));
    }

    #[test]
    fn animation_hook_replace_object_reads_compact_known_type_payload_without_desync() {
        // Retail layout (acclient.c:471699 + 667732): 1 byte part_index,
        // then u16 packed-id (high bit clear → "compact"). Total payload
        // = 3 bytes, so PackObj::ALIGN_PTR emits 1 pad byte to reach the
        // next 4-byte boundary.
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&5u32.to_le_bytes());
        bytes.extend_from_slice(&0i32.to_le_bytes());
        bytes.push(7u8);                              // part_index = 7
        bytes.extend_from_slice(&0x1234u16.to_le_bytes()); // packed id (compact)
        bytes.push(0u8);                              // align pad

        let hook = AnimationHook::read(&mut Cursor::new(bytes))
            .expect("replace-object hook with compact part id should parse");

        assert_eq!(hook.hook_type, 5);
        assert_eq!(hook.direction, 0);
        // 1 byte part + 2 byte compact id + 1 byte pad
        assert_eq!(hook.data, vec![0x07, 0x34, 0x12, 0x00]);
    }

    #[test]
    fn animation_hook_replace_object_reads_extended_known_type_payload_without_desync() {
        // Extended packed id (upper word has 0x8000 set → 4-byte form).
        // Total payload = 1 + 4 = 5 bytes → 3 pad bytes.
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&5u32.to_le_bytes());
        bytes.extend_from_slice(&1i32.to_le_bytes());
        bytes.push(9u8);                              // part_index = 9
        bytes.extend_from_slice(&0x8001u16.to_le_bytes()); // packed id high (extended)
        bytes.extend_from_slice(&0x2345u16.to_le_bytes()); // packed id low
        bytes.extend_from_slice(&[0u8, 0u8, 0u8]);    // align pad (3 bytes)

        let hook = AnimationHook::read(&mut Cursor::new(bytes))
            .expect("replace-object hook with extended part id should parse");

        assert_eq!(hook.hook_type, 5);
        assert_eq!(hook.direction, 1);
        // 1 byte part + 4 byte extended id + 3 byte pad
        assert_eq!(hook.data, vec![0x09, 0x01, 0x80, 0x45, 0x23, 0x00, 0x00, 0x00]);
    }

    #[test]
    fn animation_hook_round_trips_byte_equal_with_replace_object_padding() {
        // ReplaceObject is the one variant whose payload is non-aligned;
        // verify the round-trip explicitly so a regression in the
        // padding logic surfaces immediately.
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&5u32.to_le_bytes());
        bytes.extend_from_slice(&(-1i32).to_le_bytes());
        bytes.push(3u8);
        bytes.extend_from_slice(&0x4242u16.to_le_bytes());
        bytes.push(0u8);

        let hook = AnimationHook::read(&mut Cursor::new(&bytes[..])).expect("parse");

        let mut out = Vec::new();
        let mut cursor = Cursor::new(&mut out);
        hook.write(&mut cursor).expect("write");
        assert_eq!(out, bytes, "byte-equal round trip");
    }
}
