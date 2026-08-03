use crate::messages::utils::{
    read_hashtable_header, read_string16, require_fixed_stride, write_hashtable_header,
    write_string16,
};
use crate::traits::{ProtocolPack, ProtocolUnpack};
use byteorder::{ByteOrder, LittleEndian, WriteBytesExt};
use std::collections::HashMap;

// SquelchDB sends `Dictionary<uint, SquelchInfo>` with header NumBuckets=32.
// See `ACE.Server.Network.Structure.SquelchDB.HashComparer` (numBuckets=32).
const SQUELCH_CHARACTER_BUCKETS: usize = 32;

/// Mirrors `ACE.Server.Network.Structure.SquelchInfo`. Wire shape per
/// `SquelchInfoExtensions.Write`:
/// `[u32 num_filters, u32 filter[num_filters], string16L player_name, u32 account]`.
/// `Filters` is always written 4-long in retail (constructor expands a single
/// mask into `{mask, mask, mask, mask}`; the chat-menu checkbox toggle
/// requires the 4x repetition per ACE comment).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SquelchInfo {
    pub filters: [u32; 4],
    pub player_name: String,
    pub account: bool,
}

impl ProtocolUnpack for SquelchInfo {
    fn unpack(data: &[u8], offset: &mut usize) -> Option<Self> {
        if *offset + 4 > data.len() {
            return None;
        }
        let num_filters = LittleEndian::read_u32(&data[*offset..*offset + 4]) as usize;
        *offset += 4;
        if num_filters != 4 {
            log::warn!(
                "SquelchInfo: expected 4 filters, got {} (continuing)",
                num_filters
            );
        }
        // Rust review 2026-08-03 (F-sweep): 32-bit usize wrap in the span guard;
        // see `utils::require_fixed_stride`. (The `filters` array write below is
        // already bounded by its own `if i < 4` — not a defect.)
        require_fixed_stride(data, *offset, num_filters, 4)?;
        let mut filters = [0u32; 4];
        for i in 0..num_filters {
            let v = LittleEndian::read_u32(&data[*offset..*offset + 4]);
            *offset += 4;
            if i < 4 {
                filters[i] = v;
            }
        }
        let player_name = read_string16(data, offset)?;
        if *offset + 4 > data.len() {
            return None;
        }
        let account = LittleEndian::read_u32(&data[*offset..*offset + 4]) != 0;
        *offset += 4;
        Some(Self {
            filters,
            player_name,
            account,
        })
    }
}

impl ProtocolPack for SquelchInfo {
    fn pack(&self, buf: &mut Vec<u8>) {
        buf.write_u32::<LittleEndian>(4).unwrap();
        for f in self.filters.iter() {
            buf.write_u32::<LittleEndian>(*f).unwrap();
        }
        write_string16(buf, &self.player_name);
        buf.write_u32::<LittleEndian>(u32::from(self.account))
            .unwrap();
    }
}

/// Mirrors `ACE.Server.Network.Structure.SquelchDB`. Wire shape per
/// `SquelchDBExtensions.Write`:
/// `[PackableHashTable<string,u32> accounts (always empty),
///   PackableHashTable<u32,SquelchInfo> characters,
///   SquelchInfo globals]`.
/// `accounts` is always written with `count=0, buckets=0` in retail (ACE
/// comment: "always empty in retail pcaps, even with account squelches").
/// We don't store it — read past the header to advance offset on unpack,
/// write a `{0,0}` header on pack.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SetSquelchDbEventData {
    pub characters: HashMap<u32, SquelchInfo>,
    pub globals: SquelchInfo,
}

impl ProtocolUnpack for SetSquelchDbEventData {
    fn unpack(data: &[u8], offset: &mut usize) -> Option<Self> {
        // Skip the always-empty `accounts` dict header.
        let (accounts_count, _) = read_hashtable_header(data, offset)?;
        if accounts_count != 0 {
            log::warn!(
                "SetSquelchDb: accounts dict non-empty (count={}) — ACE retail always sends 0",
                accounts_count
            );
        }
        // Even if non-empty, advance past `string16L key + u32 value` pairs.
        for _ in 0..accounts_count {
            let _ = read_string16(data, offset)?;
            if *offset + 4 > data.len() {
                return None;
            }
            *offset += 4;
        }

        let (char_count, _) = read_hashtable_header(data, offset)?;
        let mut characters = HashMap::with_capacity(char_count);
        for _ in 0..char_count {
            if *offset + 4 > data.len() {
                return None;
            }
            let key = LittleEndian::read_u32(&data[*offset..*offset + 4]);
            *offset += 4;
            let info = SquelchInfo::unpack(data, offset)?;
            characters.insert(key, info);
        }

        let globals = SquelchInfo::unpack(data, offset)?;

        Some(Self {
            characters,
            globals,
        })
    }
}

impl ProtocolPack for SetSquelchDbEventData {
    fn pack(&self, buf: &mut Vec<u8>) {
        // accounts: always-empty hashtable header.
        write_hashtable_header(buf, 0, 0);

        write_hashtable_header(buf, self.characters.len(), SQUELCH_CHARACTER_BUCKETS);
        let mut entries: Vec<(&u32, &SquelchInfo)> = self.characters.iter().collect();
        entries.sort_by(|a, b| compare_u32_hash(*a.0, *b.0, SQUELCH_CHARACTER_BUCKETS));
        for (k, v) in entries {
            buf.write_u32::<LittleEndian>(*k).unwrap();
            v.pack(buf);
        }

        self.globals.pack(buf);
    }
}

fn compare_u32_hash(left: u32, right: u32, buckets: usize) -> std::cmp::Ordering {
    let lb = (left as usize) % buckets;
    let rb = (right as usize) % buckets;
    lb.cmp(&rb).then_with(|| left.cmp(&right))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::messages::{GameEvent, GameEventMessage};
    use holtburger_common::Guid;

    fn round_trip(msg: &GameEventMessage) {
        let mut packed = Vec::new();
        msg.pack(&mut packed);
        let mut offset = 0;
        let unpacked = GameEventMessage::unpack(&packed, &mut offset).expect("unpack failed");
        assert_eq!(offset, packed.len(), "extra bytes left after unpack");
        assert_eq!(&unpacked, msg, "round-trip mismatch");
    }

    #[test]
    fn set_squelch_db_round_trip_two_characters() {
        let mut characters = HashMap::new();
        characters.insert(
            0x5000_AAAAu32,
            SquelchInfo {
                filters: [0xFFFF_FFFF; 4],
                player_name: "Noisy Mcgee".to_string(),
                account: false,
            },
        );
        characters.insert(
            0x5000_BBBBu32,
            SquelchInfo {
                filters: [0xFFFF_FFFF; 4],
                player_name: "Spammer".to_string(),
                account: true,
            },
        );
        let event = SetSquelchDbEventData {
            characters,
            globals: SquelchInfo {
                filters: [0; 4],
                player_name: String::new(),
                account: false,
            },
        };
        let msg = GameEventMessage {
            target: Guid(0x5000_0001),
            sequence: 1,
            event: GameEvent::SetSquelchDb(Box::new(event)),
        };
        round_trip(&msg);
    }
}
