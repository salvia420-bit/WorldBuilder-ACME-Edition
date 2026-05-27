//! Wave F.5 (2026-05-27) — Contract C2S actions.
//!
//! `Social_AbandonContract` (GameAction 0x0316) — drop an active
//! contract. Server routes to `ACE.Server.WorldObjects.Player.HandleActionAbandonContract`
//! (`Player_Contracts.cs:7`) which calls `ContractManager.Abandon` →
//! `Erase`, which then broadcasts a `Social_SendClientContractTracker`
//! with `DeleteContract=true`.
//!
//! Wire format reference:
//! - `external/chorizite/Chorizite.ACProtocol/Chorizite.ACProtocol/Messages/C2S/Actions/Social_AbandonContract.generated.cs`
//!
//! Wire: one u32 carrying a `ContractId`.

use crate::traits::{ProtocolPack, ProtocolUnpack};
use byteorder::{ByteOrder, LittleEndian, WriteBytesExt};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AbandonContractActionData {
    pub contract_id: u32,
}

impl ProtocolUnpack for AbandonContractActionData {
    fn unpack(data: &[u8], offset: &mut usize) -> Option<Self> {
        if *offset + 4 > data.len() {
            return None;
        }
        let contract_id = LittleEndian::read_u32(&data[*offset..*offset + 4]);
        *offset += 4;
        Some(Self { contract_id })
    }
}

impl ProtocolPack for AbandonContractActionData {
    fn pack(&self, buf: &mut Vec<u8>) {
        buf.write_u32::<LittleEndian>(self.contract_id).unwrap();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::messages::{GameAction, GameActionMessage};

    fn round_trip(msg: &GameActionMessage) {
        let mut packed = Vec::new();
        msg.pack(&mut packed);
        let mut offset = 0;
        let unpacked =
            GameActionMessage::unpack(&packed, &mut offset).expect("unpack failed");
        assert_eq!(offset, packed.len(), "extra bytes left after unpack");
        assert_eq!(&unpacked, msg, "round-trip mismatch");
    }

    #[test]
    fn abandon_contract_round_trip() {
        // Contract 5 (Reign_of_Terror — Chorizite ContractId.cs:25).
        let msg = GameActionMessage {
            sequence: 0x42,
            action: GameAction::AbandonContract(Box::new(AbandonContractActionData {
                contract_id: 5,
            })),
        };
        round_trip(&msg);
    }

    #[test]
    fn abandon_contract_wire_size() {
        let msg = GameActionMessage {
            sequence: 1,
            action: GameAction::AbandonContract(Box::new(AbandonContractActionData {
                contract_id: 0x0014,
            })),
        };
        let mut buf = Vec::new();
        msg.pack(&mut buf);
        // GameActionMessage: 4 (sequence) + 4 (actionType opcode) + 4
        // (ContractId payload) = 12 bytes.
        assert_eq!(buf.len(), 12, "GameAction AbandonContract = 12 wire bytes");
    }
}
