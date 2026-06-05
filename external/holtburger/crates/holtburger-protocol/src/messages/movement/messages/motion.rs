use crate::messages::movement::messages::position::PositionPack;
use crate::messages::movement::types::*;
use crate::messages::utils::{align_offset, pad_to_4};
use crate::traits::{ProtocolPack, ProtocolUnpack};
use byteorder::{ByteOrder, LittleEndian};
use holtburger_common::Guid;
pub use holtburger_common::position::WorldPosition;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MovementEventData {
    pub guid: Guid,
    pub object_instance_sequence: u16,
    pub movement_sequence: u16,
    pub server_control_sequence: u16,
    pub is_autonomous: bool,
    pub movement_type: MovementType,
    pub motion_flags: u8,
    pub current_style: u16,
    pub data: MovementTypeData,
}

impl ProtocolUnpack for MovementEventData {
    fn unpack(data: &[u8], offset: &mut usize) -> Option<Self> {
        let guid = Guid::unpack(data, offset)?;

        if *offset + 2 > data.len() {
            return None;
        }
        let object_instance_sequence = LittleEndian::read_u16(&data[*offset..*offset + 2]);
        *offset += 2;

        if *offset + 2 > data.len() {
            return None;
        }
        let movement_sequence = LittleEndian::read_u16(&data[*offset..*offset + 2]);
        *offset += 2;

        if *offset + 2 > data.len() {
            return None;
        }
        let server_control_sequence = LittleEndian::read_u16(&data[*offset..*offset + 2]);
        *offset += 2;

        if *offset + 1 > data.len() {
            return None;
        }
        let is_autonomous = data[*offset] != 0;
        *offset += 1;

        // Alignment (ACE uses Writer.Align() which aligns to 4 bytes)
        align_offset(offset, 4);

        if *offset + 1 > data.len() {
            return None;
        }
        let movement_type_raw = data[*offset];
        let movement_type =
            MovementType::from_repr(movement_type_raw).unwrap_or(MovementType::Invalid);
        *offset += 1;

        if *offset + 1 > data.len() {
            return None;
        }
        let motion_flags = data[*offset];
        *offset += 1;

        if *offset + 2 > data.len() {
            return None;
        }
        let current_style = LittleEndian::read_u16(&data[*offset..*offset + 2]);
        *offset += 2;

        let data_payload = match movement_type {
            MovementType::MoveToObject => {
                MovementTypeData::MoveToObject(MoveToObject::unpack(data, offset)?)
            }
            MovementType::MoveToPosition => {
                MovementTypeData::MoveToPosition(MoveToPosition::unpack(data, offset)?)
            }
            MovementType::TurnToObject => {
                MovementTypeData::TurnToObject(TurnToObject::unpack(data, offset)?)
            }
            MovementType::TurnToHeading => {
                MovementTypeData::TurnToHeading(TurnToHeading::unpack(data, offset)?)
            }
            // Retail `MovementManager::unpack_movement` (acclient.c:339491) reads
            // the InterpretedMotionState body ONLY for type 0 (`case 0:`). Types
            // 1-5 (RawCommand / InterpretedCommand / Stop*) hit the `default:` arm
            // (acclient.c:339618) which reads NO body bytes (result = 0). They are
            // never emitted by retail/ACE/chorizite, so this is latent-only — but
            // unpack_ext would over-read >=4 bytes for them. Default to an empty
            // MovementInvalid (consumes nothing); downstream consumers read its
            // fields via Option and fail-soft on None.
            MovementType::Invalid => {
                MovementTypeData::Invalid(MovementInvalid::unpack_ext(data, offset, motion_flags)?)
            }
            MovementType::RawCommand
            | MovementType::InterpretedCommand
            | MovementType::StopRawCommand
            | MovementType::StopInterpretedCommand
            | MovementType::StopCompletely => MovementTypeData::Invalid(MovementInvalid::default()),
        };

        Some(MovementEventData {
            guid,
            object_instance_sequence,
            movement_sequence,
            server_control_sequence,
            is_autonomous,
            movement_type,
            motion_flags,
            current_style,
            data: data_payload,
        })
    }
}

impl ProtocolPack for MovementEventData {
    fn pack(&self, buf: &mut Vec<u8>) {
        self.guid.pack(buf);
        buf.extend_from_slice(&self.object_instance_sequence.to_le_bytes());
        buf.extend_from_slice(&self.movement_sequence.to_le_bytes());
        buf.extend_from_slice(&self.server_control_sequence.to_le_bytes());
        buf.push(self.is_autonomous as u8);

        // Alignment
        pad_to_4(buf);

        buf.push(self.movement_type as u8);
        buf.push(self.motion_flags);
        buf.extend_from_slice(&self.current_style.to_le_bytes());

        match &self.data {
            // Mirror unpack: only type 0 (`Invalid`) carries an InterpretedMotionState
            // body on the wire. Types 1-5 also use the `Invalid` data variant but
            // retail writes/reads no body for them, so pack nothing (byte-parity).
            MovementTypeData::Invalid(d) => {
                if self.movement_type == MovementType::Invalid {
                    d.pack(buf);
                }
            }
            MovementTypeData::MoveToObject(d) => d.pack(buf),
            MovementTypeData::MoveToPosition(d) => d.pack(buf),
            MovementTypeData::TurnToObject(d) => d.pack(buf),
            MovementTypeData::TurnToHeading(d) => d.pack(buf),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum MovementTypeData {
    Invalid(MovementInvalid),
    MoveToObject(MoveToObject),
    MoveToPosition(MoveToPosition),
    TurnToObject(TurnToObject),
    TurnToHeading(TurnToHeading),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct MovementInvalid {
    pub state: InterpretedMotionState,
    pub sticky_object: Option<Guid>,
}

impl MovementInvalid {
    pub fn unpack_ext(data: &[u8], offset: &mut usize, flags: u8) -> Option<Self> {
        let state = InterpretedMotionState::unpack(data, offset)?;
        let sticky_object = if (flags & 0x01) != 0 {
            Guid::unpack(data, offset)
        } else {
            None
        };
        Some(MovementInvalid {
            state,
            sticky_object,
        })
    }
}

impl ProtocolUnpack for MovementInvalid {
    fn unpack(data: &[u8], offset: &mut usize) -> Option<Self> {
        Self::unpack_ext(data, offset, 0)
    }
}

impl ProtocolPack for MovementInvalid {
    fn pack(&self, buf: &mut Vec<u8>) {
        self.state.pack(buf);
        if let Some(guid) = self.sticky_object {
            guid.pack(buf);
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct MoveToObject {
    pub target: Guid,
    pub origin: Origin,
    pub params: MoveToParameters,
    pub run_rate: f32,
}

impl ProtocolUnpack for MoveToObject {
    fn unpack(data: &[u8], offset: &mut usize) -> Option<Self> {
        let target = Guid::unpack(data, offset)?;
        let origin = Origin::unpack(data, offset)?;
        let params = MoveToParameters::unpack(data, offset)?;
        if *offset + 4 > data.len() {
            return None;
        }
        let run_rate = LittleEndian::read_f32(&data[*offset..*offset + 4]);
        *offset += 4;
        Some(MoveToObject {
            target,
            origin,
            params,
            run_rate,
        })
    }
}

impl ProtocolPack for MoveToObject {
    fn pack(&self, buf: &mut Vec<u8>) {
        self.target.pack(buf);
        self.origin.pack(buf);
        self.params.pack(buf);
        buf.extend_from_slice(&self.run_rate.to_le_bytes());
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct MoveToPosition {
    pub origin: Origin,
    pub params: MoveToParameters,
    pub run_rate: f32,
}

impl ProtocolUnpack for MoveToPosition {
    fn unpack(data: &[u8], offset: &mut usize) -> Option<Self> {
        let origin = Origin::unpack(data, offset)?;
        let params = MoveToParameters::unpack(data, offset)?;
        if *offset + 4 > data.len() {
            return None;
        }
        let run_rate = LittleEndian::read_f32(&data[*offset..*offset + 4]);
        *offset += 4;
        Some(MoveToPosition {
            origin,
            params,
            run_rate,
        })
    }
}

impl ProtocolPack for MoveToPosition {
    fn pack(&self, buf: &mut Vec<u8>) {
        self.origin.pack(buf);
        self.params.pack(buf);
        buf.extend_from_slice(&self.run_rate.to_le_bytes());
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct TurnToObject {
    pub target: Guid,
    pub desired_heading: f32,
    pub params: TurnToParameters,
}

impl ProtocolUnpack for TurnToObject {
    fn unpack(data: &[u8], offset: &mut usize) -> Option<Self> {
        let target = Guid::unpack(data, offset)?;
        if *offset + 4 > data.len() {
            return None;
        }
        let desired_heading = LittleEndian::read_f32(&data[*offset..*offset + 4]);
        *offset += 4;
        let params = TurnToParameters::unpack(data, offset)?;
        Some(TurnToObject {
            target,
            desired_heading,
            params,
        })
    }
}

impl ProtocolPack for TurnToObject {
    fn pack(&self, buf: &mut Vec<u8>) {
        self.target.pack(buf);
        buf.extend_from_slice(&self.desired_heading.to_le_bytes());
        self.params.pack(buf);
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct TurnToHeading {
    pub params: TurnToParameters,
}

impl ProtocolUnpack for TurnToHeading {
    fn unpack(data: &[u8], offset: &mut usize) -> Option<Self> {
        let params = TurnToParameters::unpack(data, offset)?;
        Some(TurnToHeading { params })
    }
}

impl ProtocolPack for TurnToHeading {
    fn pack(&self, buf: &mut Vec<u8>) {
        self.params.pack(buf);
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct Origin {
    pub cell_id: Guid,
    pub position: holtburger_common::math::Vector3,
}

impl ProtocolUnpack for Origin {
    fn unpack(data: &[u8], offset: &mut usize) -> Option<Self> {
        if *offset + 16 > data.len() {
            return None;
        }
        let cell_id = LittleEndian::read_u32(&data[*offset..*offset + 4]).into();
        *offset += 4;
        let x = LittleEndian::read_f32(&data[*offset..*offset + 4]);
        let y = LittleEndian::read_f32(&data[*offset + 4..*offset + 8]);
        let z = LittleEndian::read_f32(&data[*offset + 8..*offset + 12]);
        *offset += 12;
        Some(Origin {
            cell_id,
            position: holtburger_common::math::Vector3 { x, y, z },
        })
    }
}

impl ProtocolPack for Origin {
    fn pack(&self, buf: &mut Vec<u8>) {
        buf.extend_from_slice(&<Guid as Into<u32>>::into(self.cell_id).to_le_bytes());
        buf.extend_from_slice(&self.position.x.to_le_bytes());
        buf.extend_from_slice(&self.position.y.to_le_bytes());
        buf.extend_from_slice(&self.position.z.to_le_bytes());
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct MoveToParameters {
    pub movement_parameters: u32,
    pub distance_to_object: f32,
    pub min_distance: f32,
    pub fail_distance: f32,
    pub speed: f32,
    pub walk_run_threshold: f32,
    pub desired_heading: f32,
}

impl ProtocolUnpack for MoveToParameters {
    fn unpack(data: &[u8], offset: &mut usize) -> Option<Self> {
        if *offset + 28 > data.len() {
            return None;
        }
        let movement_parameters = LittleEndian::read_u32(&data[*offset..*offset + 4]);
        let distance_to_object = LittleEndian::read_f32(&data[*offset + 4..*offset + 8]);
        let min_distance = LittleEndian::read_f32(&data[*offset + 8..*offset + 12]);
        let fail_distance = LittleEndian::read_f32(&data[*offset + 12..*offset + 16]);
        let speed = LittleEndian::read_f32(&data[*offset + 16..*offset + 20]);
        let walk_run_threshold = LittleEndian::read_f32(&data[*offset + 20..*offset + 24]);
        let desired_heading = LittleEndian::read_f32(&data[*offset + 24..*offset + 28]);
        *offset += 28;
        Some(MoveToParameters {
            movement_parameters,
            distance_to_object,
            min_distance,
            fail_distance,
            speed,
            walk_run_threshold,
            desired_heading,
        })
    }
}

impl ProtocolPack for MoveToParameters {
    fn pack(&self, buf: &mut Vec<u8>) {
        buf.extend_from_slice(&self.movement_parameters.to_le_bytes());
        buf.extend_from_slice(&self.distance_to_object.to_le_bytes());
        buf.extend_from_slice(&self.min_distance.to_le_bytes());
        buf.extend_from_slice(&self.fail_distance.to_le_bytes());
        buf.extend_from_slice(&self.speed.to_le_bytes());
        buf.extend_from_slice(&self.walk_run_threshold.to_le_bytes());
        buf.extend_from_slice(&self.desired_heading.to_le_bytes());
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct TurnToParameters {
    pub movement_parameters: u32,
    pub speed: f32,
    pub desired_heading: f32,
}

impl ProtocolUnpack for TurnToParameters {
    fn unpack(data: &[u8], offset: &mut usize) -> Option<Self> {
        if *offset + 12 > data.len() {
            return None;
        }
        let movement_parameters = LittleEndian::read_u32(&data[*offset..*offset + 4]);
        let speed = LittleEndian::read_f32(&data[*offset + 4..*offset + 8]);
        let desired_heading = LittleEndian::read_f32(&data[*offset + 8..*offset + 12]);
        *offset += 12;
        Some(TurnToParameters {
            movement_parameters,
            speed,
            desired_heading,
        })
    }
}

impl ProtocolPack for TurnToParameters {
    fn pack(&self, buf: &mut Vec<u8>) {
        buf.extend_from_slice(&self.movement_parameters.to_le_bytes());
        buf.extend_from_slice(&self.speed.to_le_bytes());
        buf.extend_from_slice(&self.desired_heading.to_le_bytes());
    }
}

/// Reads the guid-less `MovementData` body (chorizite protocol.xml:6498-6534):
/// `movement_sequence(u16) + server_control_sequence(u16) + is_autonomous(u8) +
/// align(4) + movement_type(u8) + motion_flags(u8) + current_style(u16) + switch`.
/// This is the inner body shared by 0xF74C (after guid + instance_seq) and
/// 0xF619 (after ObjectId + PositionPack). `guid` + `object_instance_sequence`
/// are supplied by the caller (0xF619 has no per-object instance seq → pass 0).
pub fn unpack_movement_data_body(
    data: &[u8],
    offset: &mut usize,
    guid: Guid,
    object_instance_sequence: u16,
) -> Option<MovementEventData> {
    if *offset + 2 > data.len() {
        return None;
    }
    let movement_sequence = LittleEndian::read_u16(&data[*offset..*offset + 2]);
    *offset += 2;

    if *offset + 2 > data.len() {
        return None;
    }
    let server_control_sequence = LittleEndian::read_u16(&data[*offset..*offset + 2]);
    *offset += 2;

    if *offset + 1 > data.len() {
        return None;
    }
    let is_autonomous = data[*offset] != 0;
    *offset += 1;

    // Alignment (ACE uses Writer.Align() which aligns to 4 bytes)
    align_offset(offset, 4);

    if *offset + 1 > data.len() {
        return None;
    }
    let movement_type_raw = data[*offset];
    let movement_type = MovementType::from_repr(movement_type_raw).unwrap_or(MovementType::Invalid);
    *offset += 1;

    if *offset + 1 > data.len() {
        return None;
    }
    let motion_flags = data[*offset];
    *offset += 1;

    if *offset + 2 > data.len() {
        return None;
    }
    let current_style = LittleEndian::read_u16(&data[*offset..*offset + 2]);
    *offset += 2;

    let data_payload = match movement_type {
        MovementType::MoveToObject => {
            MovementTypeData::MoveToObject(MoveToObject::unpack(data, offset)?)
        }
        MovementType::MoveToPosition => {
            MovementTypeData::MoveToPosition(MoveToPosition::unpack(data, offset)?)
        }
        MovementType::TurnToObject => {
            MovementTypeData::TurnToObject(TurnToObject::unpack(data, offset)?)
        }
        MovementType::TurnToHeading => {
            MovementTypeData::TurnToHeading(TurnToHeading::unpack(data, offset)?)
        }
        // Mirror MovementEventData::unpack (A5): only type 0 reads a body.
        MovementType::Invalid => {
            MovementTypeData::Invalid(MovementInvalid::unpack_ext(data, offset, motion_flags)?)
        }
        MovementType::RawCommand
        | MovementType::InterpretedCommand
        | MovementType::StopRawCommand
        | MovementType::StopInterpretedCommand
        | MovementType::StopCompletely => MovementTypeData::Invalid(MovementInvalid::default()),
    };

    Some(MovementEventData {
        guid,
        object_instance_sequence,
        movement_sequence,
        server_control_sequence,
        is_autonomous,
        movement_type,
        motion_flags,
        current_style,
        data: data_payload,
    })
}

/// Writes the guid-less `MovementData` body (inverse of `unpack_movement_data_body`).
/// The caller is responsible for writing any leading guid / object_instance_sequence
/// (or, for 0xF619, the PositionPack) BEFORE calling this.
pub fn pack_movement_data_body(ev: &MovementEventData, buf: &mut Vec<u8>) {
    buf.extend_from_slice(&ev.movement_sequence.to_le_bytes());
    buf.extend_from_slice(&ev.server_control_sequence.to_le_bytes());
    buf.push(ev.is_autonomous as u8);

    // Alignment
    pad_to_4(buf);

    buf.push(ev.movement_type as u8);
    buf.push(ev.motion_flags);
    buf.extend_from_slice(&ev.current_style.to_le_bytes());

    match &ev.data {
        // Mirror unpack (A5): only type 0 (`Invalid`) carries a body on the wire.
        MovementTypeData::Invalid(d) => {
            if ev.movement_type == MovementType::Invalid {
                d.pack(buf);
            }
        }
        MovementTypeData::MoveToObject(d) => d.pack(buf),
        MovementTypeData::MoveToPosition(d) => d.pack(buf),
        MovementTypeData::TurnToObject(d) => d.pack(buf),
        MovementTypeData::TurnToHeading(d) => d.pack(buf),
    }
}

/// S2C `Movement_PositionAndMovementEvent` (0xF619). Combined materialize frame
/// (lifestone / portal recall). chorizite protocol.xml:8239-8243 layout:
/// `ObjectId(u32) + PositionPack + MovementData` (the MovementData body is
/// guid-less — the ObjectId is the separate leading field). Retail dispatch:
/// acclient.c:392762 `UnpackPositionEvent` (== 0xF748) → `SetObjectMovement`
/// (== 0xF74C). ACE never emits this → purely additive forward-compat.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PositionAndMovementEventData {
    pub guid: Guid,
    pub pos: PositionPack,
    /// The guid-less MovementData body, materialized as a `MovementEventData`
    /// (guid mirrors the leading ObjectId; `object_instance_sequence` is 0 —
    /// 0xF619 carries none) so the world handler can reuse the 0xF74C path.
    pub movement: MovementEventData,
}

impl ProtocolUnpack for PositionAndMovementEventData {
    fn unpack(data: &[u8], offset: &mut usize) -> Option<Self> {
        let guid = Guid::unpack(data, offset)?;
        let pos = PositionPack::unpack(data, offset)?;
        let movement = unpack_movement_data_body(data, offset, guid, 0)?;
        Some(PositionAndMovementEventData {
            guid,
            pos,
            movement,
        })
    }
}

impl ProtocolPack for PositionAndMovementEventData {
    fn pack(&self, buf: &mut Vec<u8>) {
        self.guid.pack(buf);
        self.pos.pack(buf);
        pack_movement_data_body(&self.movement, buf);
    }
}
