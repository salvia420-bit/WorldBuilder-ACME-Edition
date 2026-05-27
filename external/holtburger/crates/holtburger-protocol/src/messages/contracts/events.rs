//! Wave F.5 (2026-05-27) — Contract tracker (active quests) wire types.
//!
//! Mirrors Chorizite's `Social_SendClientContractTracker` (opcode
//! 0x0315 — single-tracker add/delete/update) and
//! `Social_SendClientContractTrackerTable` (opcode 0x0314 — full table
//! at login).
//!
//! Wire format references:
//! - `external/chorizite/Chorizite.ACProtocol/Chorizite.ACProtocol/Types/ContractTracker.generated.cs`
//! - `external/chorizite/Chorizite.ACProtocol/Chorizite.ACProtocol/Types/ContractTrackerTable.generated.cs`
//! - `external/chorizite/Chorizite.ACProtocol/Chorizite.ACProtocol/Messages/S2C/Events/Social_SendClientContractTracker.generated.cs`
//! - `external/chorizite/Chorizite.ACProtocol/Chorizite.ACProtocol/Messages/S2C/Events/Social_SendClientContractTrackerTable.generated.cs`
//! - `external/ACE/Source/ACE.Server/WorldObjects/Managers/ContractManager.cs`
//! - `~/ac-headers/acclient.c:702427` (`CM_Social::DispatchUI_SendClientContractTracker`)
//!
//! `CContractTracker` is 28 bytes on the wire:
//!   u32 version
//!   u32 contract_id
//!   u32 contract_stage    — `ContractStage` enum (1=New, 2=InProgress, 3=DoneOrPendingRepeat, 4+=contract-specific)
//!   i64 time_when_done
//!   i64 time_when_repeats
//!
//! `Social_SendClientContractTracker` appends two i32 bools after the
//! 28-byte payload (Chorizite's `ReadBool` reads i32; retail
//! `acclient.c:702448-702455` reads two `*(_DWORD *)buf`).
//!
//! `ContractTrackerTable` is a PackableHashTable<u32 contract_id,
//! ContractTracker>: `(count: u16, buckets: u16) + count×(u32 key +
//! 28-byte value)`. ACE matches `PackableHashTable.WriteHeader(count,
//! numBuckets)` for serialization; `numBuckets` is from
//! `HashComparer(32)`.

use crate::messages::utils::{read_hashtable_header, write_hashtable_header};
use crate::traits::{ProtocolPack, ProtocolUnpack};
use byteorder::{ByteOrder, LittleEndian, WriteBytesExt};

/// 28-byte `CContractTracker` payload — single-quest progress entry.
///
/// `version` is observed to be 1 in retail; we preserve it verbatim
/// rather than asserting because retail bumps it forward in newer
/// builds.
///
/// `stage` is a `ContractStage` (Chorizite enum): 1=New, 2=InProgress,
/// 3=DoneOrPendingRepeat. Values ≥ 4 are "contract-specific update
/// messages" per Chorizite's `ContractStage.generated.cs` comment.
///
/// Times are i64 — server seconds since epoch when the quest was
/// completed (`time_when_done`) and when it next becomes available
/// (`time_when_repeats`). Both can be 0 pre-completion.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ContractTrackerEntry {
    pub version: u32,
    pub contract_id: u32,
    pub stage: u32,
    pub time_when_done: i64,
    pub time_when_repeats: i64,
}

impl ProtocolUnpack for ContractTrackerEntry {
    fn unpack(data: &[u8], offset: &mut usize) -> Option<Self> {
        if *offset + 28 > data.len() {
            return None;
        }
        let version = LittleEndian::read_u32(&data[*offset..*offset + 4]);
        let contract_id = LittleEndian::read_u32(&data[*offset + 4..*offset + 8]);
        let stage = LittleEndian::read_u32(&data[*offset + 8..*offset + 12]);
        let time_when_done = LittleEndian::read_i64(&data[*offset + 12..*offset + 20]);
        let time_when_repeats = LittleEndian::read_i64(&data[*offset + 20..*offset + 28]);
        *offset += 28;
        Some(Self {
            version,
            contract_id,
            stage,
            time_when_done,
            time_when_repeats,
        })
    }
}

impl ProtocolPack for ContractTrackerEntry {
    fn pack(&self, buf: &mut Vec<u8>) {
        buf.write_u32::<LittleEndian>(self.version).unwrap();
        buf.write_u32::<LittleEndian>(self.contract_id).unwrap();
        buf.write_u32::<LittleEndian>(self.stage).unwrap();
        buf.write_i64::<LittleEndian>(self.time_when_done).unwrap();
        buf.write_i64::<LittleEndian>(self.time_when_repeats).unwrap();
    }
}

/// `Social_SendClientContractTracker` (opcode 0x0315) event payload.
///
/// Fired by ACE `ContractManager` on Add (DeleteContract=false,
/// SetAsDisplayContract=false), Erase (DeleteContract=true), and
/// Update (both false, tracker carries updated stage/timestamps).
///
/// `set_as_display_contract` toggles the "primary" contract — the one
/// retail's gmContractsUI pins as the prominent display in the panel
/// header. ACE leaves this `false` in all observed flows (ACE
/// `ContractManager.cs:147,200,221`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SendClientContractTrackerEventData {
    pub tracker: ContractTrackerEntry,
    pub delete_contract: bool,
    pub set_as_display_contract: bool,
}

impl ProtocolUnpack for SendClientContractTrackerEventData {
    fn unpack(data: &[u8], offset: &mut usize) -> Option<Self> {
        let tracker = ContractTrackerEntry::unpack(data, offset)?;
        if *offset + 8 > data.len() {
            return None;
        }
        // Chorizite's `ReadBool` reads i32 (4 bytes) — matches retail
        // `acclient.c:702448-702455` which reads `*(_DWORD *)buf` twice.
        let delete_raw = LittleEndian::read_i32(&data[*offset..*offset + 4]);
        let display_raw = LittleEndian::read_i32(&data[*offset + 4..*offset + 8]);
        *offset += 8;
        Some(Self {
            tracker,
            delete_contract: delete_raw == 1,
            set_as_display_contract: display_raw == 1,
        })
    }
}

impl ProtocolPack for SendClientContractTrackerEventData {
    fn pack(&self, buf: &mut Vec<u8>) {
        self.tracker.pack(buf);
        buf.write_i32::<LittleEndian>(if self.delete_contract { 1 } else { 0 })
            .unwrap();
        buf.write_i32::<LittleEndian>(if self.set_as_display_contract { 1 } else { 0 })
            .unwrap();
    }
}

/// `Social_SendClientContractTrackerTable` (opcode 0x0314) event
/// payload — full snapshot pushed at login when the player has ≥1
/// contract (ACE `Player_Networking.SendContractTrackerTable`).
///
/// Wire: `PackableHashTable<u32 contract_id, ContractTracker>` =
/// `(count: u16, buckets: u16) + count×(u32 + 28-byte ContractTracker)`.
///
/// ACE writes `numBuckets = 32` (from `HashComparer(32)`); we preserve
/// the value the server sent on unpack and emit a fixed `BUCKETS` on
/// pack to match.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SendClientContractTrackerTableEventData {
    /// `(contract_id, tracker)` pairs in wire order. ACE emits sorted
    /// by `HashComparer`-ordering which is not lexicographic by ID;
    /// callers should re-sort if they need a deterministic display
    /// order.
    pub trackers: Vec<(u32, ContractTrackerEntry)>,
}

impl SendClientContractTrackerTableEventData {
    /// ACE-side bucket count for the contract-tracker PackableHashTable.
    /// `HashComparer(32)` in `ContractManagerExtensions.hashComparer`.
    pub const BUCKETS: usize = 32;
}

impl ProtocolUnpack for SendClientContractTrackerTableEventData {
    fn unpack(data: &[u8], offset: &mut usize) -> Option<Self> {
        let (count, _buckets) = read_hashtable_header(data, offset)?;
        let mut trackers = Vec::with_capacity(count);
        for _ in 0..count {
            if *offset + 4 > data.len() {
                return None;
            }
            let key = LittleEndian::read_u32(&data[*offset..*offset + 4]);
            *offset += 4;
            let tracker = ContractTrackerEntry::unpack(data, offset)?;
            trackers.push((key, tracker));
        }
        Some(Self { trackers })
    }
}

impl ProtocolPack for SendClientContractTrackerTableEventData {
    fn pack(&self, buf: &mut Vec<u8>) {
        write_hashtable_header(buf, self.trackers.len(), Self::BUCKETS);
        for (key, tracker) in &self.trackers {
            buf.write_u32::<LittleEndian>(*key).unwrap();
            tracker.pack(buf);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::messages::{GameEvent, GameEventMessage};
    use holtburger_common::Guid;

    fn sample_tracker(contract_id: u32, stage: u32) -> ContractTrackerEntry {
        ContractTrackerEntry {
            version: 1,
            contract_id,
            stage,
            time_when_done: 1_712_000_000,
            time_when_repeats: 1_712_086_400,
        }
    }

    #[test]
    fn contract_tracker_entry_round_trip() {
        let entry = sample_tracker(0x0014, 2);
        let mut buf = Vec::new();
        entry.pack(&mut buf);
        assert_eq!(
            buf.len(),
            28,
            "CContractTracker wire size must be 28 bytes (acclient.c:0x0059A180 Pack returns 28)",
        );
        let mut offset = 0;
        let unpacked = ContractTrackerEntry::unpack(&buf, &mut offset).expect("unpack");
        assert_eq!(offset, buf.len(), "no leftover bytes");
        assert_eq!(unpacked, entry);
    }

    #[test]
    fn contract_tracker_entry_zero_times() {
        // Pre-completion: both i64 timestamps 0.
        let entry = ContractTrackerEntry {
            version: 1,
            contract_id: 0x0042,
            stage: 1, // New
            time_when_done: 0,
            time_when_repeats: 0,
        };
        let mut buf = Vec::new();
        entry.pack(&mut buf);
        let mut offset = 0;
        let unpacked = ContractTrackerEntry::unpack(&buf, &mut offset).expect("unpack");
        assert_eq!(unpacked, entry);
    }

    fn round_trip(msg: &GameEventMessage) {
        let mut packed = Vec::new();
        msg.pack(&mut packed);
        let mut offset = 0;
        let unpacked =
            GameEventMessage::unpack(&packed, &mut offset).expect("unpack failed");
        assert_eq!(offset, packed.len(), "extra bytes left after unpack");
        assert_eq!(&unpacked, msg, "round-trip mismatch");
    }

    #[test]
    fn send_client_contract_tracker_event_round_trip_add() {
        // ACE Add flow: DeleteContract=false, SetAsDisplayContract=false.
        let event = SendClientContractTrackerEventData {
            tracker: sample_tracker(0x0008, 2),
            delete_contract: false,
            set_as_display_contract: false,
        };
        let msg = GameEventMessage {
            target: Guid(0x5000_0001),
            sequence: 1,
            event: GameEvent::SendClientContractTracker(Box::new(event)),
        };
        round_trip(&msg);
    }

    #[test]
    fn send_client_contract_tracker_event_round_trip_delete() {
        // ACE Erase flow: DeleteContract=true.
        let event = SendClientContractTrackerEventData {
            tracker: sample_tracker(0x0008, 3),
            delete_contract: true,
            set_as_display_contract: false,
        };
        let msg = GameEventMessage {
            target: Guid(0x5000_0001),
            sequence: 2,
            event: GameEvent::SendClientContractTracker(Box::new(event)),
        };
        round_trip(&msg);
    }

    #[test]
    fn send_client_contract_tracker_event_round_trip_display_flag() {
        // Synthetic: server pins primary display contract.
        let event = SendClientContractTrackerEventData {
            tracker: sample_tracker(0x0014, 2),
            delete_contract: false,
            set_as_display_contract: true,
        };
        let msg = GameEventMessage {
            target: Guid(0x5000_0001),
            sequence: 3,
            event: GameEvent::SendClientContractTracker(Box::new(event)),
        };
        round_trip(&msg);
    }

    #[test]
    fn send_client_contract_tracker_table_event_round_trip_empty() {
        // Edge case — ACE skips emit when count=0 (see
        // Player_Networking.SendContractTrackerTable's
        // `GetContractsCount > 0` gate), but the wire format still
        // accepts an empty table. Lock in the round-trip.
        let event = SendClientContractTrackerTableEventData { trackers: vec![] };
        let msg = GameEventMessage {
            target: Guid(0x5000_0001),
            sequence: 4,
            event: GameEvent::SendClientContractTrackerTable(Box::new(event)),
        };
        round_trip(&msg);
    }

    #[test]
    fn send_client_contract_tracker_table_event_round_trip_three_trackers() {
        // Three contracts: New / InProgress / DoneOrPendingRepeat.
        let trackers = vec![
            (0x0001, sample_tracker(0x0001, 1)), // New
            (0x0014, sample_tracker(0x0014, 2)), // InProgress
            (0x0042, sample_tracker(0x0042, 3)), // DoneOrPendingRepeat
        ];
        let event = SendClientContractTrackerTableEventData { trackers };
        let msg = GameEventMessage {
            target: Guid(0x5000_0001),
            sequence: 5,
            event: GameEvent::SendClientContractTrackerTable(Box::new(event)),
        };
        round_trip(&msg);
    }

    #[test]
    fn contract_tracker_table_wire_layout() {
        // Explicit wire-layout sanity probe: 3-entry table should be
        // 4 (header) + 3 × (4 + 28) bytes.
        let trackers = vec![
            (0x0001, sample_tracker(0x0001, 1)),
            (0x0014, sample_tracker(0x0014, 2)),
            (0x0042, sample_tracker(0x0042, 3)),
        ];
        let event = SendClientContractTrackerTableEventData { trackers };
        let mut buf = Vec::new();
        event.pack(&mut buf);
        let expected_len = 4 + 3 * (4 + 28);
        assert_eq!(
            buf.len(),
            expected_len,
            "table wire size 4-byte header + 3×(u32 key + 28-byte tracker) = {expected_len}",
        );
        // First 4 bytes: count=3, buckets=32.
        assert_eq!(LittleEndian::read_u16(&buf[0..2]), 3);
        assert_eq!(
            LittleEndian::read_u16(&buf[2..4]),
            SendClientContractTrackerTableEventData::BUCKETS as u16,
        );
    }
}
