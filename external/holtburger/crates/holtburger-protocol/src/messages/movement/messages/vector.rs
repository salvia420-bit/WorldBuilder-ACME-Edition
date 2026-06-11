use crate::messages::utils::{align_offset, pad_to_4};
use crate::traits::{ProtocolPack, ProtocolUnpack};
use byteorder::{ByteOrder, LittleEndian};
use holtburger_common::Guid;
pub use holtburger_common::position::WorldPosition;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct VectorUpdateData {
    pub guid: Guid,
    pub velocity: holtburger_common::math::Vector3,
    pub omega: holtburger_common::math::Vector3,
    pub instance_sequence: u16,
    pub vector_sequence: u16,
}

impl ProtocolUnpack for VectorUpdateData {
    fn unpack(data: &[u8], offset: &mut usize) -> Option<Self> {
        let guid = Guid::unpack(data, offset)?;
        if *offset + 28 > data.len() {
            return None;
        }
        let velocity = holtburger_common::math::Vector3 {
            x: LittleEndian::read_f32(&data[*offset..*offset + 4]),
            y: LittleEndian::read_f32(&data[*offset + 4..*offset + 8]),
            z: LittleEndian::read_f32(&data[*offset + 8..*offset + 12]),
        };
        *offset += 12;
        let omega = holtburger_common::math::Vector3 {
            x: LittleEndian::read_f32(&data[*offset..*offset + 4]),
            y: LittleEndian::read_f32(&data[*offset + 4..*offset + 8]),
            z: LittleEndian::read_f32(&data[*offset + 8..*offset + 12]),
        };
        *offset += 12;
        let instance_sequence = LittleEndian::read_u16(&data[*offset..*offset + 2]);
        let vector_sequence = LittleEndian::read_u16(&data[*offset + 2..*offset + 4]);
        *offset += 4;

        Some(VectorUpdateData {
            guid,
            velocity,
            omega,
            instance_sequence,
            vector_sequence,
        })
    }
}

impl ProtocolPack for VectorUpdateData {
    fn pack(&self, buf: &mut Vec<u8>) {
        self.guid.pack(buf);
        buf.extend_from_slice(&self.velocity.x.to_le_bytes());
        buf.extend_from_slice(&self.velocity.y.to_le_bytes());
        buf.extend_from_slice(&self.velocity.z.to_le_bytes());
        buf.extend_from_slice(&self.omega.x.to_le_bytes());
        buf.extend_from_slice(&self.omega.y.to_le_bytes());
        buf.extend_from_slice(&self.omega.z.to_le_bytes());
        buf.extend_from_slice(&self.instance_sequence.to_le_bytes());
        buf.extend_from_slice(&self.vector_sequence.to_le_bytes());
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AutonomousPositionData {
    pub position: WorldPosition,
    pub instance_sequence: u16,
    pub server_control_sequence: u16,
    pub teleport_sequence: u16,
    pub force_position_sequence: u16,
    pub last_contact: u8,
}

impl ProtocolUnpack for AutonomousPositionData {
    fn unpack(data: &[u8], offset: &mut usize) -> Option<Self> {
        let position = WorldPosition::unpack(data, offset)?;
        if *offset + 9 > data.len() {
            return None;
        }
        let instance_sequence = LittleEndian::read_u16(&data[*offset..*offset + 2]);
        let server_control_sequence = LittleEndian::read_u16(&data[*offset + 2..*offset + 4]);
        let teleport_sequence = LittleEndian::read_u16(&data[*offset + 4..*offset + 6]);
        let force_position_sequence = LittleEndian::read_u16(&data[*offset + 6..*offset + 8]);
        let last_contact = data[*offset + 8];
        *offset += 9;

        // Alignment
        align_offset(offset, 4);

        Some(Self {
            position,
            instance_sequence,
            server_control_sequence,
            teleport_sequence,
            force_position_sequence,
            last_contact,
        })
    }
}

impl ProtocolPack for AutonomousPositionData {
    fn pack(&self, buf: &mut Vec<u8>) {
        self.position.pack(buf);
        buf.extend_from_slice(&self.instance_sequence.to_le_bytes());
        buf.extend_from_slice(&self.server_control_sequence.to_le_bytes());
        buf.extend_from_slice(&self.teleport_sequence.to_le_bytes());
        buf.extend_from_slice(&self.force_position_sequence.to_le_bytes());
        buf.push(self.last_contact);
        // Align
        pad_to_4(buf);
    }
}

/// S2C AutonomousPosition (0xF753). ACE serializes the pose with
/// `Position.Serialize(writer, true, false)` — `writeLandblock:false` — so the
/// frame carries NO leading cell id; the receiver supplies the object's
/// current landblock (see [`Self::position_in`]).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ServerAutonomousPositionData {
    pub guid: Guid,
    pub coords: holtburger_common::math::Vector3,
    pub rotation: holtburger_common::math::Quaternion,
    pub instance_sequence: u16,
    pub server_control_sequence: u16,
    pub teleport_sequence: u16,
    pub force_position_sequence: u16,
    pub contact_flags: u32,
}

impl ServerAutonomousPositionData {
    /// Rebuilds a full [`WorldPosition`] by carrying the receiver's current
    /// landblock forward (the wire frame omits it).
    pub fn position_in(&self, landblock_id: Guid) -> WorldPosition {
        WorldPosition {
            landblock_id,
            coords: self.coords,
            rotation: self.rotation,
        }
    }
}

impl ProtocolUnpack for ServerAutonomousPositionData {
    fn unpack(data: &[u8], offset: &mut usize) -> Option<Self> {
        let guid = Guid::unpack(data, offset)?;
        // Landblock-less pose: x,y,z + quat WXYZ (28 bytes), then 4 u16
        // sequences + u32 contact (12 bytes).
        if *offset + 40 > data.len() {
            return None;
        }
        let coords = holtburger_common::math::Vector3 {
            x: LittleEndian::read_f32(&data[*offset..*offset + 4]),
            y: LittleEndian::read_f32(&data[*offset + 4..*offset + 8]),
            z: LittleEndian::read_f32(&data[*offset + 8..*offset + 12]),
        };
        *offset += 12;
        let rotation = holtburger_common::math::Quaternion {
            w: LittleEndian::read_f32(&data[*offset..*offset + 4]),
            x: LittleEndian::read_f32(&data[*offset + 4..*offset + 8]),
            y: LittleEndian::read_f32(&data[*offset + 8..*offset + 12]),
            z: LittleEndian::read_f32(&data[*offset + 12..*offset + 16]),
        };
        *offset += 16;
        let instance_sequence = LittleEndian::read_u16(&data[*offset..*offset + 2]);
        let server_control_sequence = LittleEndian::read_u16(&data[*offset + 2..*offset + 4]);
        let teleport_sequence = LittleEndian::read_u16(&data[*offset + 4..*offset + 6]);
        let force_position_sequence = LittleEndian::read_u16(&data[*offset + 6..*offset + 8]);
        let contact_flags = LittleEndian::read_u32(&data[*offset + 8..*offset + 12]);
        *offset += 12;

        // Alignment
        align_offset(offset, 4);

        Some(Self {
            guid,
            coords,
            rotation,
            instance_sequence,
            server_control_sequence,
            teleport_sequence,
            force_position_sequence,
            contact_flags,
        })
    }
}

impl ProtocolPack for ServerAutonomousPositionData {
    fn pack(&self, buf: &mut Vec<u8>) {
        self.guid.pack(buf);
        buf.extend_from_slice(&self.coords.x.to_le_bytes());
        buf.extend_from_slice(&self.coords.y.to_le_bytes());
        buf.extend_from_slice(&self.coords.z.to_le_bytes());
        buf.extend_from_slice(&self.rotation.w.to_le_bytes());
        buf.extend_from_slice(&self.rotation.x.to_le_bytes());
        buf.extend_from_slice(&self.rotation.y.to_le_bytes());
        buf.extend_from_slice(&self.rotation.z.to_le_bytes());
        buf.extend_from_slice(&self.instance_sequence.to_le_bytes());
        buf.extend_from_slice(&self.server_control_sequence.to_le_bytes());
        buf.extend_from_slice(&self.teleport_sequence.to_le_bytes());
        buf.extend_from_slice(&self.force_position_sequence.to_le_bytes());
        buf.extend_from_slice(&self.contact_flags.to_le_bytes());

        // Alignment
        pad_to_4(buf);
    }
}

// AutonomyLevelData (top-level GameMessage flavor) removed — 0xF752 is a
// GameActionType-only opcode per retail (acclient.c
// CM_Movement::Event_AutonomyLevel @ 712866 writes 0xF752 inside an
// OrderHdr-wrapped GameAction payload) and ACE-Server
// GameActionType.AutonomyLevel. The action-side struct is
// `AutonomyLevelActionData` in movement::actions.
