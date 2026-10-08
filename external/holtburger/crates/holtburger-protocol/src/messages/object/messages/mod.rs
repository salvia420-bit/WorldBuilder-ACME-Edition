use crate::traits::{ProtocolPack, ProtocolUnpack};
use holtburger_common::Guid;

pub mod attribute;
pub mod description;
pub mod properties;
pub mod sound;
#[cfg(test)]
mod tests;
#[cfg(test)]
pub use self::attribute::*;
pub use self::description::*;
pub use self::properties::*;
pub use self::sound::*;

/// `DeleteObject` (0xF747). ACE `GameMessageDeleteObject` writes the guid,
/// the object's CURRENT `ObjectInstance` stamp (u16) and an `Align()` pad;
/// retail `CM_Physics::DispatchSB_DeleteObject` (acclient.c:709598-709609)
/// reads `object_id` + `instance_timestamp` for
/// `SmartBox::HandleDeleteObject`'s instance gate (:143262-143296).
///
/// createobj-5 (2026-10-08 follow-ups): `instance_sequence` is `None` when
/// the body ends after the guid (a short body stays ungated, so it can
/// never turn into a ghost that is never deleted).
#[derive(Debug, Clone, PartialEq)]
pub struct ObjectDeleteData {
    pub guid: Guid,
    pub instance_sequence: Option<u16>,
}

impl ProtocolUnpack for ObjectDeleteData {
    fn unpack(data: &[u8], offset: &mut usize) -> Option<Self> {
        let guid = Guid::unpack(data, offset)?;
        let instance_sequence = if *offset + 2 <= data.len() {
            let value = u16::from_le_bytes([data[*offset], data[*offset + 1]]);
            *offset += 2;
            // ACE `Writer.Align()` pad (2 bytes after the u16). Consumed
            // only as far as the body actually carries it.
            let aligned = (*offset + 3) & !3;
            *offset = aligned.min(data.len());
            Some(value)
        } else {
            None
        };
        Some(ObjectDeleteData {
            guid,
            instance_sequence,
        })
    }
}

impl ProtocolPack for ObjectDeleteData {
    fn pack(&self, buf: &mut Vec<u8>) {
        self.guid.pack(buf);
        if let Some(instance_sequence) = self.instance_sequence {
            buf.extend_from_slice(&instance_sequence.to_le_bytes());
            crate::messages::utils::pad_to_4(buf);
        }
    }
}
