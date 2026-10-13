pub use crate::messages::character::types::*;
pub use crate::messages::chat::turbine::*;
pub use crate::messages::chat::types::*;
pub use crate::messages::combat::types::*;
pub use crate::messages::effects::types::*;
pub use crate::messages::inventory::types::*;
pub use crate::messages::misc::types::*;
pub use crate::messages::movement::actions::*;
pub use crate::messages::movement::messages::*;
pub use crate::messages::movement::types::*;
pub use crate::messages::object::messages::*;
pub use crate::messages::object::types::*;
pub use crate::messages::player::types::*;

pub use crate::messages::game_action::GameActionMessage;
pub use crate::messages::game_event::GameEventMessage;

#[derive(Debug, Clone, PartialEq)]
pub enum GameMessage {
    None, // 0x0000
    CharacterList(Box<CharacterListData>),
    CharacterCreate(Box<CharacterCreateRequestData>),
    CharacterCreateResponse(Box<CharacterCreateResponseData>),
    CharacterDeleteRequest(Box<CharacterDeleteRequestData>),
    CharacterDeleteResponse,
    CharacterRestoreRequest(Box<CharacterRestoreRequestData>),
    CharacterEnterWorldRequest(Box<CharacterEnterWorldRequestData>),
    CharacterEnterWorld(Box<CharacterEnterWorldData>),
    CharacterEnterWorldServerReady, // 0xF7DF
    ServerName(Box<ServerNameData>),
    ServerMessage(Box<ServerMessageData>),
    PlayerKilled(Box<PlayerKilledData>),
    TurbineChat(Box<TurbineChatMessageData>),
    DddInterrogation(Box<DddInterrogationData>),
    DddInterrogationResponse(Box<DddInterrogationResponseData>),
    DddRequestDataMessage(Box<DddRequestDataMessageData>),
    DddErrorMessage(Box<DddErrorMessageData>),
    DddDataMessage(Box<DddDataMessageData>),
    DddBeginDdd(Box<DddBeginDddData>),
    DddEndDdd, // 0xF7EA — empty payload
    CharacterError(Box<CharacterErrorData>),
    AccountBoot(Box<BootAccountData>),
    CharacterLogOff, // 0xF653
    GameAction(Box<GameActionMessage>),
    GameEvent(Box<GameEventMessage>),

    PrivateUpdateAttribute(Box<PrivateUpdateAttributeData>),
    PublicUpdateAttribute(Box<PublicUpdateAttributeData>),
    PrivateUpdateSkill(Box<PrivateUpdateSkillData>),
    PublicUpdateSkill(Box<PublicUpdateSkillData>),
    PrivateUpdateSkillLevel(Box<PrivateUpdateSkillLevelData>),
    PublicUpdateSkillLevel(Box<PublicUpdateSkillLevelData>),
    PrivateUpdateVital(Box<PrivateUpdateVitalData>),
    PublicUpdateVital(Box<PublicUpdateVitalData>),
    PrivateUpdateVitalCurrent(Box<PrivateUpdateVitalCurrentData>),

    HearSpeech(Box<HearSpeechData>),
    HearRangedSpeech(Box<HearRangedSpeechData>),
    EmoteText(Box<EmoteTextData>),
    SoulEmote(Box<SoulEmoteData>),

    // Object Messages
    ObjectCreate(Box<ObjectDescriptionData>),
    PlayerCreate(Box<PlayerCreateData>),
    UpdateObject(Box<ObjectDescriptionData>),
    ObjectDelete(Box<ObjectDeleteData>),
    ObjDescEvent(Box<ObjDescEventData>),
    ForceObjectDescSend(Box<ForceObjectDescSendData>),
    UpdatePosition(Box<UpdatePositionData>),
    PositionAndMovementEvent(Box<PositionAndMovementEventData>),
    PrivateUpdatePosition(Box<PrivateUpdatePositionData>),
    PublicUpdatePosition(Box<PublicUpdatePositionData>),
    VectorUpdate(Box<VectorUpdateData>),
    UpdateMotion(Box<MovementEventData>),
    PlayerTeleport(Box<PlayerTeleportData>),
    AutonomousPosition(Box<ServerAutonomousPositionData>),

    PrivateUpdatePropertyInt(Box<PrivateUpdatePropertyIntData>),
    PublicUpdatePropertyInt(Box<PublicUpdatePropertyIntData>),
    PrivateUpdatePropertyInt64(Box<PrivateUpdatePropertyInt64Data>),
    PublicUpdatePropertyInt64(Box<PublicUpdatePropertyInt64Data>),
    PrivateUpdatePropertyBool(Box<PrivateUpdatePropertyBoolData>),
    PublicUpdatePropertyBool(Box<PublicUpdatePropertyBoolData>),
    PrivateUpdatePropertyFloat(Box<PrivateUpdatePropertyFloatData>),
    PublicUpdatePropertyFloat(Box<PublicUpdatePropertyFloatData>),
    PrivateUpdatePropertyString(Box<PrivateUpdatePropertyStringData>),
    PublicUpdatePropertyString(Box<PublicUpdatePropertyStringData>),
    PrivateUpdatePropertyDataId(Box<PrivateUpdatePropertyDataIdData>),
    PublicUpdatePropertyDataId(Box<PublicUpdatePropertyDataIdData>),
    PrivateUpdatePropertyInstanceId(Box<PrivateUpdatePropertyInstanceIdData>),
    PublicUpdatePropertyInstanceId(Box<PublicUpdatePropertyInstanceIdData>),

    ParentEvent(Box<ParentEventData>),
    PickupEvent(Box<PickupEventData>),
    InventoryRemoveObject(Box<InventoryRemoveObjectData>),
    SetStackSize(Box<SetStackSizeData>),
    SetState(Box<SetStateData>),
    PlaySound(Box<PlaySoundData>),
    PlayEffect(Box<PlayEffectData>),
    EnvironChange(Box<EnvironChangeData>),

    Unknown(u32, Vec<u8>),
}

mod pack;
mod unpack;

/// test-tooling-3 (wire integrity): `GameMessage::unpack` wraps 20 Qualities
/// opcodes (Wave 6.A: the `Remove*` family, `Update*SkillAC`,
/// `Update*AttributeLevel`) as `GameMessage::Unknown` ON PURPOSE, both when
/// the generated codegen reader validates the payload and when it rejects it
/// (the `!consumed` raw-grab fallback). Given a whole inbound message (opcode
/// first), this re-runs that reader: `Some(true)` = a validated wrap,
/// `Some(false)` = a decode failure disguised as `Unknown`, `None` = not one
/// of the 20 (or no opcode). Diagnostics only; pure.
pub fn qualities_raw_wrap_decodes(message: &[u8]) -> Option<bool> {
    let b = message.get(0..4)?;
    let op = u32::from_le_bytes([b[0], b[1], b[2], b[3]]);
    let mut offset = 4;
    unpack::qualities_codegen_read(op, message, &mut offset)
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod raw_wrap_tests {
    use super::*;
    use crate::traits::ProtocolUnpack;

    /// 0x02E1 Qualities_PrivateUpdateSkillAC (protocol.xml): byte Sequence,
    /// SkillId Key (i32), SkillAdvancementClass Value (u32).
    fn update_skill_ac(skill: i32, sac: u32) -> Vec<u8> {
        let mut b = 0x02E1u32.to_le_bytes().to_vec();
        b.push(5);
        b.extend_from_slice(&skill.to_le_bytes());
        b.extend_from_slice(&sac.to_le_bytes());
        b
    }

    #[test]
    fn qualities_raw_wrap_valid_payload_is_some_true() {
        // MeleeDefense (6), Specialized (3).
        let msg = update_skill_ac(6, 3);
        assert_eq!(qualities_raw_wrap_decodes(&msg), Some(true));
        // ...and unpack still wraps it as Unknown, consuming every byte.
        let mut off = 0;
        let parsed = GameMessage::unpack(&msg, &mut off);
        assert!(matches!(parsed, Some(GameMessage::Unknown(0x02E1, _))));
        assert_eq!(off, msg.len());
    }

    #[test]
    fn qualities_raw_wrap_truncated_payload_is_some_false() {
        let mut msg = update_skill_ac(6, 3);
        msg.truncate(msg.len() - 4); // drop the SkillAdvancementClass
        assert_eq!(qualities_raw_wrap_decodes(&msg), Some(false));
        // unpack's raw-grab fallback: still Some(Unknown), indistinguishable
        // by variant from the validated wrap above.
        let mut off = 0;
        let parsed = GameMessage::unpack(&msg, &mut off);
        assert!(matches!(parsed, Some(GameMessage::Unknown(0x02E1, _))));
        assert_eq!(off, msg.len());
    }

    #[test]
    fn qualities_raw_wrap_other_opcodes_are_none() {
        // 0xF7B0 GameEvent, an unknown opcode, and a runt with no opcode.
        assert_eq!(qualities_raw_wrap_decodes(&0xF7B0u32.to_le_bytes()), None);
        assert_eq!(qualities_raw_wrap_decodes(&0xDEAD_BEEFu32.to_le_bytes()), None);
        assert_eq!(qualities_raw_wrap_decodes(&[0xE1, 0x02]), None);
    }
}
