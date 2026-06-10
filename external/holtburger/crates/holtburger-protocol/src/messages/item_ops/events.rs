//! Item-operation self-events (SG-C2, 2026-06-09) — S2C.
//!
//! Two genuinely-unhandled GameEvents:
//!   - `SalvageOperationsResult` (0x02B4) — the per-material salvage yield,
//!     shown as a result toast/panel after using an Ust.
//!     (`Source/ACE.Server/Network/GameEvent/Events/
//!     GameEventSalvageOperationsResult.cs` + `Network/Structure/
//!     SalvageResult.cs`).
//!   - `InscriptionResponse` (opcode `GetInscriptionResponse` 0x00C3) — the
//!     object's inscription text + scribe. **Deprecated in retail** (ACE:
//!     "THIS EVENT IS DEPRECIATED AND HAS NO HANDLER IN ACCLIENT"); the modern
//!     client reads inscription text from `IdentifyObjectResponse`
//!     (`PropertyString::Inscription`) instead. Decoded here for completeness.
//!
//! Two of SG-C2's four listed events were verified ALREADY HANDLED (not gaps):
//!   - `WieldItem` packs opcode `WieldObject` (0x0023) → already decoded by
//!     `WieldObjectEventData` (`[u32 object, i32 EquipMask]`).
//!   - `ItemServerSaysContainId` packs opcode `InventoryPutObjInContainer`
//!     (0x0022) → already decoded by `InventoryPutObjInContainerEventData`
//!     (`[guid item, guid container, u32 placement, u32 container_type]`).

use crate::messages::utils::{read_string16, write_string16};
use crate::traits::{ProtocolPack, ProtocolUnpack};
use byteorder::{ByteOrder, LittleEndian, WriteBytesExt};
use holtburger_common::Guid;

/// One salvaged-material line. `SalvageResult.cs` wire:
/// `[u32 material_type, f64 workmanship, u32 units]` (16 bytes).
/// `workmanship` is the average workmanship of the salvaged items;
/// `units` is the resulting bag quantity.
#[derive(Debug, Clone, PartialEq)]
pub struct SalvageResult {
    pub material_type: u32,
    pub workmanship: f64,
    pub units: u32,
}

impl ProtocolUnpack for SalvageResult {
    fn unpack(data: &[u8], offset: &mut usize) -> Option<Self> {
        if *offset + 16 > data.len() {
            return None;
        }
        let material_type = LittleEndian::read_u32(&data[*offset..*offset + 4]);
        let workmanship = LittleEndian::read_f64(&data[*offset + 4..*offset + 12]);
        let units = LittleEndian::read_u32(&data[*offset + 12..*offset + 16]);
        *offset += 16;
        Some(Self {
            material_type,
            workmanship,
            units,
        })
    }
}

impl ProtocolPack for SalvageResult {
    fn pack(&self, buf: &mut Vec<u8>) {
        buf.write_u32::<LittleEndian>(self.material_type).unwrap();
        buf.write_f64::<LittleEndian>(self.workmanship).unwrap();
        buf.write_u32::<LittleEndian>(self.units).unwrap();
    }
}

/// `GameEventSalvageOperationsResult` (0x02B4). Wire:
/// `[u32 skill, u32 not_salvagable(=0), i32 count, SalvageResult[count],
///   i32 augmentation_bonus]`. `not_salvagable` is a always-0 placeholder
/// (ACE `Writer.Write(0)`, commented "not salvagable item guid list?").
/// `augmentation_bonus` = `AugmentationBonusSalvage * 25` for the Salvaging
/// skill, else 0.
#[derive(Debug, Clone, PartialEq)]
pub struct SalvageOperationsResultEventData {
    pub skill: u32,
    pub not_salvagable: u32,
    pub augmentation_bonus: i32,
    pub results: Vec<SalvageResult>,
}

impl ProtocolUnpack for SalvageOperationsResultEventData {
    fn unpack(data: &[u8], offset: &mut usize) -> Option<Self> {
        if *offset + 12 > data.len() {
            return None;
        }
        let skill = LittleEndian::read_u32(&data[*offset..*offset + 4]);
        let not_salvagable = LittleEndian::read_u32(&data[*offset + 4..*offset + 8]);
        let count = LittleEndian::read_i32(&data[*offset + 8..*offset + 12]);
        *offset += 12;
        if count < 0 {
            return None;
        }
        let mut results = Vec::with_capacity(count as usize);
        for _ in 0..count {
            results.push(SalvageResult::unpack(data, offset)?);
        }
        if *offset + 4 > data.len() {
            return None;
        }
        let augmentation_bonus = LittleEndian::read_i32(&data[*offset..*offset + 4]);
        *offset += 4;
        Some(Self {
            skill,
            not_salvagable,
            augmentation_bonus,
            results,
        })
    }
}

impl ProtocolPack for SalvageOperationsResultEventData {
    fn pack(&self, buf: &mut Vec<u8>) {
        buf.write_u32::<LittleEndian>(self.skill).unwrap();
        buf.write_u32::<LittleEndian>(self.not_salvagable).unwrap();
        buf.write_i32::<LittleEndian>(self.results.len() as i32).unwrap();
        for r in &self.results {
            r.pack(buf);
        }
        buf.write_i32::<LittleEndian>(self.augmentation_bonus).unwrap();
    }
}

/// `GameEventInscriptionResponse` (opcode `GetInscriptionResponse` 0x00C3).
/// Wire: `[guid object, string16 inscription, guid scribe, string16
/// scribe_name, string16 scribe_account]` then a trailing `Align()` — which
/// is a no-op because every `WriteString16L` field is already padded so
/// `(2 + len)` is a multiple of 4 (ACE `Extensions.WriteString16L`), and the
/// guids are 4-byte, so the running position is always 4-aligned.
/// **Deprecated** — see module doc.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InscriptionResponseEventData {
    pub object_guid: Guid,
    pub inscription: String,
    pub scribe_guid: Guid,
    pub scribe_name: String,
    pub scribe_account: String,
}

impl ProtocolUnpack for InscriptionResponseEventData {
    fn unpack(data: &[u8], offset: &mut usize) -> Option<Self> {
        let object_guid = Guid::unpack(data, offset)?;
        let inscription = read_string16(data, offset)?;
        let scribe_guid = Guid::unpack(data, offset)?;
        let scribe_name = read_string16(data, offset)?;
        let scribe_account = read_string16(data, offset)?;
        Some(Self {
            object_guid,
            inscription,
            scribe_guid,
            scribe_name,
            scribe_account,
        })
    }
}

impl ProtocolPack for InscriptionResponseEventData {
    fn pack(&self, buf: &mut Vec<u8>) {
        self.object_guid.pack(buf);
        write_string16(buf, &self.inscription);
        self.scribe_guid.pack(buf);
        write_string16(buf, &self.scribe_name);
        write_string16(buf, &self.scribe_account);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::messages::game_event::{GameEvent, GameEventMessage};
    use crate::messages::game_message::GameMessage;
    use crate::traits::{ProtocolPack, ProtocolUnpack};

    fn round_trip(event: GameEvent) -> (GameMessage, GameMessage) {
        let original = GameMessage::GameEvent(Box::new(GameEventMessage {
            target: Guid(0x5000_00AB),
            sequence: 0x42,
            event,
        }));
        let mut packed = Vec::new();
        original.pack(&mut packed);
        let mut offset = 0;
        let unpacked = GameMessage::unpack(&packed, &mut offset).unwrap();
        // The whole buffer must be consumed (no trailing slack / under-read).
        assert_eq!(offset, packed.len(), "offset != packed len");
        (original, unpacked)
    }

    #[test]
    fn salvage_operations_result_round_trip() {
        let (orig, back) = round_trip(GameEvent::SalvageOperationsResult(Box::new(
            SalvageOperationsResultEventData {
                skill: 40, // Salvaging
                not_salvagable: 0,
                augmentation_bonus: 75,
                results: vec![
                    SalvageResult {
                        material_type: 0x14, // Iron
                        workmanship: 7.5,
                        units: 120,
                    },
                    SalvageResult {
                        material_type: 0x2D, // Pyreal
                        workmanship: 9.25,
                        units: 4,
                    },
                ],
            },
        )));
        assert_eq!(orig, back);
    }

    #[test]
    fn salvage_operations_result_empty_round_trip() {
        let (orig, back) = round_trip(GameEvent::SalvageOperationsResult(Box::new(
            SalvageOperationsResultEventData {
                skill: 40,
                not_salvagable: 0,
                augmentation_bonus: 0,
                results: vec![],
            },
        )));
        assert_eq!(orig, back);
    }

    #[test]
    fn inscription_response_round_trip() {
        let (orig, back) = round_trip(GameEvent::InscriptionResponse(Box::new(
            InscriptionResponseEventData {
                object_guid: Guid(0x8000_0123),
                inscription: "To my dearest friend".to_string(),
                scribe_guid: Guid(0x5000_00AB),
                scribe_name: "Asheron".to_string(),
                scribe_account: "acct".to_string(),
            },
        )));
        assert_eq!(orig, back);
    }

    #[test]
    fn inscription_response_empty_strings_round_trip() {
        let (orig, back) = round_trip(GameEvent::InscriptionResponse(Box::new(
            InscriptionResponseEventData {
                object_guid: Guid(0x8000_0123),
                inscription: String::new(),
                scribe_guid: Guid::NULL,
                scribe_name: String::new(),
                scribe_account: String::new(),
            },
        )));
        assert_eq!(orig, back);
    }
}
