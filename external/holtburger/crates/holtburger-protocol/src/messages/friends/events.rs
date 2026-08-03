use crate::messages::utils::{capacity_hint, read_string16, require_fixed_stride, write_string16};
use crate::traits::{ProtocolPack, ProtocolUnpack};
use byteorder::{ByteOrder, LittleEndian, WriteBytesExt};
use holtburger_common::Guid;

/// Mirrors `ACE.Server.Network.GameEvent.Events.GameEventFriendsListUpdate.FriendsUpdateTypeFlag`.
/// Sent at the trailing u32 of the payload.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FriendsUpdateTypeFlags(pub u32);

impl FriendsUpdateTypeFlags {
    pub const FULL_LIST: u32 = 0x0000;
    pub const FRIEND_ADDED: u32 = 0x0001;
    pub const FRIEND_REMOVED: u32 = 0x0002;
    pub const FRIEND_STATUS_CHANGED: u32 = 0x0004;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FriendEntry {
    pub friend_id: Guid,
    /// `u32` on wire (1/0).
    pub is_online: bool,
    /// `u32` on wire (1/0). ACE currently always writes 0.
    pub appear_offline: bool,
    /// `string16L` (length-prefixed, Windows-1252, 4-byte aligned).
    pub name: String,
    /// Friend-of-friend list. ACE writes count=0 + no body today; we
    /// keep the field so a future ACE patch enabling it round-trips.
    pub their_friends: Vec<Guid>,
    /// Inverse-friend list (players who friended this friend). Same
    /// "count=0 in ACE today" semantics as `their_friends`.
    pub inverse_friends: Vec<Guid>,
}

impl ProtocolUnpack for FriendEntry {
    fn unpack(data: &[u8], offset: &mut usize) -> Option<Self> {
        if *offset + 12 > data.len() {
            return None;
        }
        let friend_id = Guid(LittleEndian::read_u32(&data[*offset..*offset + 4]));
        let is_online = LittleEndian::read_u32(&data[*offset + 4..*offset + 8]) != 0;
        let appear_offline = LittleEndian::read_u32(&data[*offset + 8..*offset + 12]) != 0;
        *offset += 12;

        let name = read_string16(data, offset)?;

        if *offset + 4 > data.len() {
            return None;
        }
        let their_count = LittleEndian::read_u32(&data[*offset..*offset + 4]) as usize;
        *offset += 4;
        // Rust review 2026-08-03 (F-sweep): 32-bit usize wrap in the span guard;
        // see `utils::require_fixed_stride`.
        require_fixed_stride(data, *offset, their_count, 4)?;
        let mut their_friends = Vec::with_capacity(their_count);
        for _ in 0..their_count {
            their_friends.push(Guid(LittleEndian::read_u32(&data[*offset..*offset + 4])));
            *offset += 4;
        }

        if *offset + 4 > data.len() {
            return None;
        }
        let inverse_count = LittleEndian::read_u32(&data[*offset..*offset + 4]) as usize;
        *offset += 4;
        // Rust review 2026-08-03 (F-sweep): 32-bit usize wrap in the span guard;
        // see `utils::require_fixed_stride`.
        require_fixed_stride(data, *offset, inverse_count, 4)?;
        let mut inverse_friends = Vec::with_capacity(inverse_count);
        for _ in 0..inverse_count {
            inverse_friends.push(Guid(LittleEndian::read_u32(&data[*offset..*offset + 4])));
            *offset += 4;
        }

        Some(Self {
            friend_id,
            is_online,
            appear_offline,
            name,
            their_friends,
            inverse_friends,
        })
    }
}

impl ProtocolPack for FriendEntry {
    fn pack(&self, buf: &mut Vec<u8>) {
        buf.write_u32::<LittleEndian>(self.friend_id.0).unwrap();
        buf.write_u32::<LittleEndian>(u32::from(self.is_online)).unwrap();
        buf.write_u32::<LittleEndian>(u32::from(self.appear_offline)).unwrap();
        write_string16(buf, &self.name);
        buf.write_u32::<LittleEndian>(self.their_friends.len() as u32).unwrap();
        for g in &self.their_friends {
            buf.write_u32::<LittleEndian>(g.0).unwrap();
        }
        buf.write_u32::<LittleEndian>(self.inverse_friends.len() as u32).unwrap();
        for g in &self.inverse_friends {
            buf.write_u32::<LittleEndian>(g.0).unwrap();
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FriendsListUpdateEventData {
    pub friends: Vec<FriendEntry>,
    /// `FriendsUpdateTypeFlags`: FullList=0, FriendAdded=1,
    /// FriendRemoved=2, FriendStatusChanged=4. Sent as trailing u32.
    pub update_type: u32,
}

impl ProtocolUnpack for FriendsListUpdateEventData {
    fn unpack(data: &[u8], offset: &mut usize) -> Option<Self> {
        if *offset + 4 > data.len() {
            return None;
        }
        let friend_count = LittleEndian::read_u32(&data[*offset..*offset + 4]) as usize;
        *offset += 4;

        let mut friends = Vec::with_capacity(capacity_hint(data, *offset, friend_count));
        for _ in 0..friend_count {
            friends.push(FriendEntry::unpack(data, offset)?);
        }

        if *offset + 4 > data.len() {
            return None;
        }
        let update_type = LittleEndian::read_u32(&data[*offset..*offset + 4]);
        *offset += 4;

        Some(Self { friends, update_type })
    }
}

impl ProtocolPack for FriendsListUpdateEventData {
    fn pack(&self, buf: &mut Vec<u8>) {
        buf.write_u32::<LittleEndian>(self.friends.len() as u32).unwrap();
        for f in &self.friends {
            f.pack(buf);
        }
        buf.write_u32::<LittleEndian>(self.update_type).unwrap();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::messages::{GameEvent, GameEventMessage};

    fn round_trip(msg: &GameEventMessage) {
        let mut packed = Vec::new();
        msg.pack(&mut packed);
        let mut offset = 0;
        let unpacked = GameEventMessage::unpack(&packed, &mut offset).expect("unpack failed");
        assert_eq!(offset, packed.len(), "extra bytes left after unpack");
        assert_eq!(&unpacked, msg, "round-trip mismatch");
    }

    #[test]
    fn friends_list_update_round_trip_empty() {
        let event = FriendsListUpdateEventData {
            friends: vec![],
            update_type: FriendsUpdateTypeFlags::FULL_LIST,
        };
        let msg = GameEventMessage {
            target: Guid(0x5000_0001),
            sequence: 1,
            event: GameEvent::FriendsListUpdate(Box::new(event)),
        };
        round_trip(&msg);
    }

    #[test]
    fn friends_list_update_round_trip_three_friends() {
        let event = FriendsListUpdateEventData {
            friends: vec![
                FriendEntry {
                    friend_id: Guid(0x5000_AAAA),
                    is_online: true,
                    appear_offline: false,
                    name: "Friendo".to_string(),
                    their_friends: vec![],
                    inverse_friends: vec![],
                },
                FriendEntry {
                    friend_id: Guid(0x5000_BBBB),
                    is_online: false,
                    appear_offline: false,
                    name: "Offlino".to_string(),
                    their_friends: vec![],
                    inverse_friends: vec![],
                },
                FriendEntry {
                    friend_id: Guid(0x5000_CCCC),
                    is_online: true,
                    appear_offline: false,
                    name: "Stormbringer’s Apprentice".to_string(),
                    their_friends: vec![Guid(0x5000_DDDD), Guid(0x5000_EEEE)],
                    inverse_friends: vec![Guid(0x5000_FFFF)],
                },
            ],
            update_type: FriendsUpdateTypeFlags::FULL_LIST,
        };
        let msg = GameEventMessage {
            target: Guid(0x5000_3333),
            sequence: 0x42,
            event: GameEvent::FriendsListUpdate(Box::new(event)),
        };
        round_trip(&msg);
    }

    #[test]
    fn friends_list_update_round_trip_status_changed() {
        let event = FriendsListUpdateEventData {
            friends: vec![FriendEntry {
                friend_id: Guid(0x5000_AAAA),
                is_online: true,
                appear_offline: false,
                name: "Friendo".to_string(),
                their_friends: vec![],
                inverse_friends: vec![],
            }],
            update_type: FriendsUpdateTypeFlags::FRIEND_STATUS_CHANGED,
        };
        let msg = GameEventMessage {
            target: Guid(0x5000_3333),
            sequence: 7,
            event: GameEvent::FriendsListUpdate(Box::new(event)),
        };
        round_trip(&msg);
    }
}
