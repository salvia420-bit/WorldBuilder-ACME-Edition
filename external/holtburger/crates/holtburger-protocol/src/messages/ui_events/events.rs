//! UI-surface self-events (SG-C3, 2026-06-09) — S2C GameEvents that drive a
//! client UI: the barber/appearance editor, the /age reply, the chat
//! channel picker, the available-housing list, and house access records.
//! All verified UNHANDLED (the lens-1 false-positive re-check passed — none
//! collide with an existing opcode/variant).
//!
//! Wire formats locked against ACE `Source/ACE.Server/Network/GameEvent/Events/
//! GameEvent{StartBarber,QueryAgeResponse,ChannelList,ChannelIndex,
//! HouseUpdateHAR,HouseAvailableHouses}.cs` (+ `Network/Structure/
//! {HouseAccess,GuestInfo,PackableList}.cs`). Opcodes from `GameEventType.cs`:
//! StartBarber=0x0075, ChannelList=0x0148, ChannelIndex=0x0149,
//! QueryAgeResponse=0x01C3, UpdateHAR=0x0257, AvailableHouses=0x0271.
//!
//! NOTE: the handoff labelled `UpdateHAR` "heritage/allegiance rank" — it is
//! actually **House Access Records** (the house guest list), decoded as such.

use crate::messages::utils::{
    read_hashtable_header, read_string16, write_hashtable_header, write_string16,
};
use crate::traits::{ProtocolPack, ProtocolUnpack};
use byteorder::{ByteOrder, LittleEndian, WriteBytesExt};
use holtburger_common::Guid;

/// `GameEventQueryAgeResponse` (0x01C3). Wire: `[string16 target_name,
/// string16 age]`. The reply to `/age <name>` — a pre-formatted age string.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QueryAgeResponseEventData {
    pub target_name: String,
    pub age: String,
}

impl ProtocolUnpack for QueryAgeResponseEventData {
    fn unpack(data: &[u8], offset: &mut usize) -> Option<Self> {
        let target_name = read_string16(data, offset)?;
        let age = read_string16(data, offset)?;
        Some(Self { target_name, age })
    }
}

impl ProtocolPack for QueryAgeResponseEventData {
    fn pack(&self, buf: &mut Vec<u8>) {
        write_string16(buf, &self.target_name);
        write_string16(buf, &self.age);
    }
}

/// `GameEventStartBarber` (0x0075). Opens the appearance/barber editor with
/// the player's current head/face/palette DIDs. Wire: 16 consecutive `u32`s
/// (palette base, head obj, hair tex + default, eyes tex + default, nose tex
/// + default, mouth tex + default, skin/hair/eyes palette, setup table,
/// option1, option2). Field order mirrors the ACE constructor exactly.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct StartBarberEventData {
    pub palette_base_did: u32,
    pub head_object_did: u32,
    pub hair_texture: u32,
    pub default_hair_texture: u32,
    pub eyes_texture_did: u32,
    pub default_eyes_texture_did: u32,
    pub nose_texture_did: u32,
    pub default_nose_texture_did: u32,
    pub mouth_texture_did: u32,
    pub default_mouth_texture_did: u32,
    pub skin_palette_did: u32,
    pub hair_palette_did: u32,
    pub eyes_palette_did: u32,
    pub setup_table_id: u32,
    /// 1 for the Empyrean float/bound toggle, else 0.
    pub option1: u32,
    /// Unused in retail (always 0).
    pub option2: u32,
}

impl ProtocolUnpack for StartBarberEventData {
    fn unpack(data: &[u8], offset: &mut usize) -> Option<Self> {
        if *offset + 64 > data.len() {
            return None;
        }
        let mut rd = || {
            let v = LittleEndian::read_u32(&data[*offset..*offset + 4]);
            *offset += 4;
            v
        };
        Some(Self {
            palette_base_did: rd(),
            head_object_did: rd(),
            hair_texture: rd(),
            default_hair_texture: rd(),
            eyes_texture_did: rd(),
            default_eyes_texture_did: rd(),
            nose_texture_did: rd(),
            default_nose_texture_did: rd(),
            mouth_texture_did: rd(),
            default_mouth_texture_did: rd(),
            skin_palette_did: rd(),
            hair_palette_did: rd(),
            eyes_palette_did: rd(),
            setup_table_id: rd(),
            option1: rd(),
            option2: rd(),
        })
    }
}

impl ProtocolPack for StartBarberEventData {
    fn pack(&self, buf: &mut Vec<u8>) {
        for v in [
            self.palette_base_did,
            self.head_object_did,
            self.hair_texture,
            self.default_hair_texture,
            self.eyes_texture_did,
            self.default_eyes_texture_did,
            self.nose_texture_did,
            self.default_nose_texture_did,
            self.mouth_texture_did,
            self.default_mouth_texture_did,
            self.skin_palette_did,
            self.hair_palette_did,
            self.eyes_palette_did,
            self.setup_table_id,
            self.option1,
            self.option2,
        ] {
            buf.write_u32::<LittleEndian>(v).unwrap();
        }
    }
}

/// `GameEventChannelList` (0x0148). The online players in a chat channel.
/// Wire: `[u32 count, string16 player_name × count]`. The count is always
/// written (0 when empty), unlike `ChannelIndex`.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ChannelListEventData {
    pub player_names: Vec<String>,
}

impl ProtocolUnpack for ChannelListEventData {
    fn unpack(data: &[u8], offset: &mut usize) -> Option<Self> {
        if *offset + 4 > data.len() {
            return None;
        }
        let count = LittleEndian::read_u32(&data[*offset..*offset + 4]);
        *offset += 4;
        let mut player_names = Vec::with_capacity(count.min(4096) as usize);
        for _ in 0..count {
            player_names.push(read_string16(data, offset)?);
        }
        Some(Self { player_names })
    }
}

impl ProtocolPack for ChannelListEventData {
    fn pack(&self, buf: &mut Vec<u8>) {
        buf.write_u32::<LittleEndian>(self.player_names.len() as u32)
            .unwrap();
        for n in &self.player_names {
            write_string16(buf, n);
        }
    }
}

/// `GameEventChannelIndex` (0x0149). The chat channels available to the
/// player. Wire: `[u32 count, string16 channel_name × count]` — BUT ACE
/// writes **nothing at all** for a non-privileged player (the body is empty,
/// no count). So unpack treats "fewer than 4 bytes remain" as the empty case,
/// and pack writes nothing when empty (ACE-faithful). CAVEAT: an empty
/// ChannelIndex bundled *before* another GameEvent in the same message would
/// be ambiguous — but ACE sends a populated list only to admins/advocates and
/// the empty form alone, so this is safe in practice.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ChannelIndexEventData {
    pub channels: Vec<String>,
}

impl ProtocolUnpack for ChannelIndexEventData {
    fn unpack(data: &[u8], offset: &mut usize) -> Option<Self> {
        if *offset + 4 > data.len() {
            return Some(Self::default()); // empty body (non-privileged player)
        }
        let count = LittleEndian::read_u32(&data[*offset..*offset + 4]);
        *offset += 4;
        let mut channels = Vec::with_capacity(count.min(64) as usize);
        for _ in 0..count {
            channels.push(read_string16(data, offset)?);
        }
        Some(Self { channels })
    }
}

impl ProtocolPack for ChannelIndexEventData {
    fn pack(&self, buf: &mut Vec<u8>) {
        if self.channels.is_empty() {
            return; // ACE writes nothing for the empty/non-privileged case
        }
        buf.write_u32::<LittleEndian>(self.channels.len() as u32)
            .unwrap();
        for c in &self.channels {
            write_string16(buf, c);
        }
    }
}

/// `GameEventHouseAvailableHouses` (0x0271). The pickable houses of a type.
/// Wire: `[u32 house_type, PackableList<u32> locations (= [u32 count,
/// u32 × count]), i32 total_available]`.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct HouseAvailableHousesEventData {
    pub house_type: u32,
    pub locations: Vec<u32>,
    pub total_available: i32,
}

impl ProtocolUnpack for HouseAvailableHousesEventData {
    fn unpack(data: &[u8], offset: &mut usize) -> Option<Self> {
        if *offset + 8 > data.len() {
            return None;
        }
        let house_type = LittleEndian::read_u32(&data[*offset..*offset + 4]);
        let count = LittleEndian::read_u32(&data[*offset + 4..*offset + 8]);
        *offset += 8;
        let mut locations = Vec::with_capacity(count.min(8192) as usize);
        for _ in 0..count {
            if *offset + 4 > data.len() {
                return None;
            }
            locations.push(LittleEndian::read_u32(&data[*offset..*offset + 4]));
            *offset += 4;
        }
        if *offset + 4 > data.len() {
            return None;
        }
        let total_available = LittleEndian::read_i32(&data[*offset..*offset + 4]);
        *offset += 4;
        Some(Self {
            house_type,
            locations,
            total_available,
        })
    }
}

impl ProtocolPack for HouseAvailableHousesEventData {
    fn pack(&self, buf: &mut Vec<u8>) {
        buf.write_u32::<LittleEndian>(self.house_type).unwrap();
        buf.write_u32::<LittleEndian>(self.locations.len() as u32)
            .unwrap();
        for &l in &self.locations {
            buf.write_u32::<LittleEndian>(l).unwrap();
        }
        buf.write_i32::<LittleEndian>(self.total_available).unwrap();
    }
}

/// One house guest. `GuestInfo.cs` wire: `[u32 storage_permission(bool),
/// string16 name]`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HouseGuest {
    pub guid: Guid,
    /// false = house access, true = house + storage access.
    pub storage_permission: bool,
    pub name: String,
}

/// `GameEventUpdateHAR` (0x0257) — House Access Records (the guest list).
/// Wraps `HouseAccess` (`HouseAccess.cs`). Wire:
/// `[u32 version(0x10000002), u32 bitmask, u32 monarch_guid,
///   PackableHashTable<guid,GuestInfo> guests (= [u16 count, u16 buckets,
///   {u32 guid, u32 storage, string16 name} × count]),
///   PackableList<guid> roommates (= [u32 count, u32 guid × count])]`.
/// `bitmask` (`HARBitfield`): 1=open, 2=allegiance access, 4=+storage.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpdateHarEventData {
    pub version: u32,
    pub bitmask: u32,
    pub monarch_guid: Guid,
    /// Preserved so a round-trip re-emits ACE's bucket count verbatim.
    pub guest_buckets: u16,
    pub guests: Vec<HouseGuest>,
    pub roommates: Vec<Guid>,
}

impl ProtocolUnpack for UpdateHarEventData {
    fn unpack(data: &[u8], offset: &mut usize) -> Option<Self> {
        if *offset + 12 > data.len() {
            return None;
        }
        let version = LittleEndian::read_u32(&data[*offset..*offset + 4]);
        let bitmask = LittleEndian::read_u32(&data[*offset + 4..*offset + 8]);
        *offset += 8;
        let monarch_guid = Guid::unpack(data, offset)?;
        let (guest_count, guest_buckets) = read_hashtable_header(data, offset)?;
        let mut guests = Vec::with_capacity(guest_count.min(4096));
        for _ in 0..guest_count {
            let guid = Guid::unpack(data, offset)?;
            if *offset + 4 > data.len() {
                return None;
            }
            let storage_permission = LittleEndian::read_u32(&data[*offset..*offset + 4]) != 0;
            *offset += 4;
            let name = read_string16(data, offset)?;
            guests.push(HouseGuest {
                guid,
                storage_permission,
                name,
            });
        }
        if *offset + 4 > data.len() {
            return None;
        }
        let roommate_count = LittleEndian::read_u32(&data[*offset..*offset + 4]);
        *offset += 4;
        let mut roommates = Vec::with_capacity(roommate_count.min(4096) as usize);
        for _ in 0..roommate_count {
            roommates.push(Guid::unpack(data, offset)?);
        }
        Some(Self {
            version,
            bitmask,
            monarch_guid,
            guest_buckets: guest_buckets as u16,
            guests,
            roommates,
        })
    }
}

impl ProtocolPack for UpdateHarEventData {
    fn pack(&self, buf: &mut Vec<u8>) {
        buf.write_u32::<LittleEndian>(self.version).unwrap();
        buf.write_u32::<LittleEndian>(self.bitmask).unwrap();
        self.monarch_guid.pack(buf);
        write_hashtable_header(buf, self.guests.len(), self.guest_buckets as usize);
        for g in &self.guests {
            g.guid.pack(buf);
            buf.write_u32::<LittleEndian>(u32::from(g.storage_permission))
                .unwrap();
            write_string16(buf, &g.name);
        }
        buf.write_u32::<LittleEndian>(self.roommates.len() as u32)
            .unwrap();
        for r in &self.roommates {
            r.pack(buf);
        }
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
        assert_eq!(offset, packed.len(), "offset != packed len");
        (original, unpacked)
    }

    #[test]
    fn query_age_response_round_trip() {
        let (o, b) = round_trip(GameEvent::QueryAgeResponse(Box::new(
            QueryAgeResponseEventData {
                target_name: "Asheron".to_string(),
                age: "1 year, 2 days".to_string(),
            },
        )));
        assert_eq!(o, b);
    }

    #[test]
    fn start_barber_round_trip() {
        let (o, b) = round_trip(GameEvent::StartBarber(Box::new(StartBarberEventData {
            palette_base_did: 0x0400_0FED,
            head_object_did: 0x0100_02AB,
            setup_table_id: 0x0200_0001,
            option1: 1,
            ..Default::default()
        })));
        assert_eq!(o, b);
    }

    #[test]
    fn channel_list_round_trip() {
        let (o, b) = round_trip(GameEvent::ChannelList(Box::new(ChannelListEventData {
            player_names: vec!["Alice".to_string(), "Bob".to_string()],
        })));
        assert_eq!(o, b);
        // Empty list still writes the count.
        let (o2, b2) = round_trip(GameEvent::ChannelList(Box::new(ChannelListEventData {
            player_names: vec![],
        })));
        assert_eq!(o2, b2);
    }

    #[test]
    fn channel_index_populated_round_trip() {
        let (o, b) = round_trip(GameEvent::ChannelIndex(Box::new(ChannelIndexEventData {
            channels: vec!["Abuse".to_string(), "Help".to_string()],
        })));
        assert_eq!(o, b);
    }

    #[test]
    fn channel_index_empty_round_trip() {
        // Non-privileged player: ACE writes an empty body; pack writes nothing,
        // unpack returns an empty list (and consumes no body bytes).
        let (o, b) = round_trip(GameEvent::ChannelIndex(Box::new(ChannelIndexEventData {
            channels: vec![],
        })));
        assert_eq!(o, b);
    }

    #[test]
    fn house_available_houses_round_trip() {
        let (o, b) = round_trip(GameEvent::HouseAvailableHouses(Box::new(
            HouseAvailableHousesEventData {
                house_type: 2, // Villa
                locations: vec![0x0001_0001, 0x0002_0002, 0x0003_0003],
                total_available: 17,
            },
        )));
        assert_eq!(o, b);
    }

    #[test]
    fn update_har_round_trip() {
        let (o, b) = round_trip(GameEvent::UpdateHar(Box::new(UpdateHarEventData {
            version: 0x1000_0002,
            bitmask: 0x04, // allegiance + storage
            monarch_guid: Guid(0x5000_0ABC),
            guest_buckets: 64,
            guests: vec![
                HouseGuest {
                    guid: Guid(0x5000_0111),
                    storage_permission: true,
                    name: "Friend".to_string(),
                },
                HouseGuest {
                    guid: Guid(0x5000_0222),
                    storage_permission: false,
                    name: "Acquaintance".to_string(),
                },
            ],
            roommates: vec![Guid(0x5000_0333)],
        })));
        assert_eq!(o, b);
    }

    #[test]
    fn update_har_empty_round_trip() {
        let (o, b) = round_trip(GameEvent::UpdateHar(Box::new(UpdateHarEventData {
            version: 0x1000_0002,
            bitmask: 0,
            monarch_guid: Guid::NULL,
            guest_buckets: 64,
            guests: vec![],
            roommates: vec![],
        })));
        assert_eq!(o, b);
    }
}
