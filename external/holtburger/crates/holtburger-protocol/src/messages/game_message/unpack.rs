use super::GameMessage;
pub use crate::messages::character::types::*;
pub use crate::messages::chat::turbine::*;
pub use crate::messages::chat::types::*;
pub use crate::messages::combat::types::*;
pub use crate::messages::effects::types::*;
pub use crate::messages::inventory::types::*;
pub use crate::messages::misc::types::*;
pub use crate::messages::movement::messages::*;
pub use crate::messages::object::messages::*;
pub use crate::messages::player::types::*;

pub use crate::messages::game_action::GameActionMessage;
pub use crate::messages::game_event::GameEventMessage;
use crate::opcodes::*;
use crate::traits::ProtocolUnpack;
use byteorder::{ByteOrder, LittleEndian};

impl ProtocolUnpack for GameMessage {
    fn unpack(data: &[u8], offset: &mut usize) -> Option<Self> {
        if *offset + 4 > data.len() {
            return None;
        }
        let opcode_raw = LittleEndian::read_u32(&data[*offset..*offset + 4]);
        *offset += 4;

        let op = GameOpcode::from_repr(opcode_raw);
        if op.is_none() {
            log::warn!(
                "<<< Unknown Opcode: {:08X} Data Len: {}",
                opcode_raw,
                data.len() - *offset
            );
            let remaining = data[*offset..].to_vec();
            *offset = data.len();
            return Some(GameMessage::Unknown(opcode_raw, remaining));
        }

        match op.unwrap() {
            GameOpcode::None => Some(GameMessage::None),
            GameOpcode::CharacterList => Some(GameMessage::CharacterList(Box::new(
                CharacterListData::unpack(data, offset)?,
            ))),
            GameOpcode::CharacterCreate => Some(GameMessage::CharacterCreate(Box::new(
                CharacterCreateRequestData::unpack(data, offset)?,
            ))),
            GameOpcode::CharacterCreateResponse => Some(GameMessage::CharacterCreateResponse(
                Box::new(CharacterCreateResponseData::unpack(data, offset)?),
            )),
            GameOpcode::CharacterDelete => {
                if *offset == data.len() {
                    Some(GameMessage::CharacterDeleteResponse)
                } else {
                    Some(GameMessage::CharacterDeleteRequest(Box::new(
                        CharacterDeleteRequestData::unpack(data, offset)?,
                    )))
                }
            }
            GameOpcode::CharacterRestore => Some(GameMessage::CharacterRestoreRequest(Box::new(
                CharacterRestoreRequestData::unpack(data, offset)?,
            ))),
            GameOpcode::CharacterEnterWorldRequest => {
                Some(GameMessage::CharacterEnterWorldRequest(Box::new(
                    CharacterEnterWorldRequestData::unpack(data, offset)?,
                )))
            }
            GameOpcode::CharacterEnterWorld => Some(GameMessage::CharacterEnterWorld(Box::new(
                CharacterEnterWorldData::unpack(data, offset)?,
            ))),
            GameOpcode::ServerName => Some(GameMessage::ServerName(Box::new(
                ServerNameData::unpack(data, offset)?,
            ))),
            GameOpcode::PlayerKilled => Some(GameMessage::PlayerKilled(Box::new(
                PlayerKilledData::unpack(data, offset)?,
            ))),
            GameOpcode::CharacterEnterWorldServerReady => {
                Some(GameMessage::CharacterEnterWorldServerReady)
            }
            GameOpcode::DddInterrogation => Some(GameMessage::DddInterrogation),
            GameOpcode::DddInterrogationResponse => Some(GameMessage::DddInterrogationResponse(
                Box::new(DddInterrogationResponseData::unpack(data, offset)?),
            )),
            GameOpcode::CharacterError => Some(GameMessage::CharacterError(Box::new(
                CharacterErrorData::unpack(data, offset)?,
            ))),
            GameOpcode::AccountBoot => Some(GameMessage::AccountBoot(Box::new(
                BootAccountData::unpack(data, offset)?,
            ))),
            GameOpcode::CharacterLogOff => Some(GameMessage::CharacterLogOff),
            GameOpcode::ServerMessage => Some(GameMessage::ServerMessage(Box::new(
                ServerMessageData::unpack(data, offset)?,
            ))),
            GameOpcode::TurbineChat => Some(GameMessage::TurbineChat(Box::new(
                TurbineChatMessageData::unpack(data, offset)?,
            ))),
            GameOpcode::GameAction => Some(GameMessage::GameAction(Box::new(
                GameActionMessage::unpack(data, offset)?,
            ))),
            GameOpcode::GameEvent => Some(GameMessage::GameEvent(Box::new(
                GameEventMessage::unpack(data, offset)?,
            ))),
            GameOpcode::HearSpeech => Some(GameMessage::HearSpeech(Box::new(
                HearSpeechData::unpack(data, offset)?,
            ))),
            GameOpcode::HearRangedSpeech => Some(GameMessage::HearRangedSpeech(Box::new(
                HearRangedSpeechData::unpack(data, offset)?,
            ))),
            GameOpcode::EmoteText => Some(GameMessage::EmoteText(Box::new(EmoteTextData::unpack(
                data, offset,
            )?))),
            GameOpcode::SoulEmote => Some(GameMessage::SoulEmote(Box::new(SoulEmoteData::unpack(
                data, offset,
            )?))),
            GameOpcode::PrivateUpdateAttribute => Some(GameMessage::PrivateUpdateAttribute(
                Box::new(PrivateUpdateAttributeData::unpack(data, offset)?),
            )),
            GameOpcode::PublicUpdateAttribute => Some(GameMessage::PublicUpdateAttribute(
                Box::new(PublicUpdateAttributeData::unpack(data, offset)?),
            )),
            GameOpcode::PrivateUpdateSkill => Some(GameMessage::PrivateUpdateSkill(Box::new(
                PrivateUpdateSkillData::unpack(data, offset)?,
            ))),
            GameOpcode::PublicUpdateSkill => Some(GameMessage::PublicUpdateSkill(Box::new(
                PublicUpdateSkillData::unpack(data, offset)?,
            ))),
            GameOpcode::PrivateUpdateVital => Some(GameMessage::PrivateUpdateVital(Box::new(
                PrivateUpdateVitalData::unpack(data, offset)?,
            ))),
            GameOpcode::PublicUpdateVital => Some(GameMessage::PublicUpdateVital(Box::new(
                PublicUpdateVitalData::unpack(data, offset)?,
            ))),
            GameOpcode::PrivateUpdateVitalCurrent => Some(GameMessage::PrivateUpdateVitalCurrent(
                Box::new(PrivateUpdateVitalCurrentData::unpack(data, offset)?),
            )),
            GameOpcode::ObjectCreate => Some(GameMessage::ObjectCreate(Box::new(
                ObjectDescriptionData::unpack(data, offset)?,
            ))),
            GameOpcode::PlayerCreate => Some(GameMessage::PlayerCreate(Box::new(
                PlayerCreateData::unpack(data, offset)?,
            ))),
            GameOpcode::UpdateObject => Some(GameMessage::UpdateObject(Box::new(
                ObjectDescriptionData::unpack(data, offset)?,
            ))),
            GameOpcode::ObjectDelete => Some(GameMessage::ObjectDelete(Box::new(
                ObjectDeleteData::unpack(data, offset)?,
            ))),
            GameOpcode::UpdatePosition => Some(GameMessage::UpdatePosition(Box::new(
                UpdatePositionData::unpack(data, offset)?,
            ))),
            GameOpcode::PositionAndMovement => Some(GameMessage::PositionAndMovementEvent(
                Box::new(PositionAndMovementEventData::unpack(data, offset)?),
            )),
            GameOpcode::PrivateUpdatePosition => Some(GameMessage::PrivateUpdatePosition(
                Box::new(PrivateUpdatePositionData::unpack(data, offset)?),
            )),
            GameOpcode::PublicUpdatePosition => Some(GameMessage::PublicUpdatePosition(Box::new(
                PublicUpdatePositionData::unpack(data, offset)?,
            ))),
            GameOpcode::VectorUpdate => Some(GameMessage::VectorUpdate(Box::new(
                VectorUpdateData::unpack(data, offset)?,
            ))),
            GameOpcode::UpdateMotion => Some(GameMessage::UpdateMotion(Box::new(
                MovementEventData::unpack(data, offset)?,
            ))),
            GameOpcode::AutonomousPosition => Some(GameMessage::AutonomousPosition(Box::new(
                ServerAutonomousPositionData::unpack(data, offset)?,
            ))),
            GameOpcode::ParentEvent => Some(GameMessage::ParentEvent(Box::new(
                ParentEventData::unpack(data, offset)?,
            ))),
            GameOpcode::PickupEvent => Some(GameMessage::PickupEvent(Box::new(
                PickupEventData::unpack(data, offset)?,
            ))),
            GameOpcode::InventoryRemoveObject => Some(GameMessage::InventoryRemoveObject(
                Box::new(InventoryRemoveObjectData::unpack(data, offset)?),
            )),
            GameOpcode::SetStackSize => Some(GameMessage::SetStackSize(Box::new(
                SetStackSizeData::unpack(data, offset)?,
            ))),
            GameOpcode::SetState => Some(GameMessage::SetState(Box::new(SetStateData::unpack(
                data, offset,
            )?))),
            GameOpcode::PlayerTeleport => Some(GameMessage::PlayerTeleport(Box::new(
                PlayerTeleportData::unpack(data, offset)?,
            ))),
            GameOpcode::Sound => Some(GameMessage::PlaySound(Box::new(PlaySoundData::unpack(
                data, offset,
            )?))),
            GameOpcode::PlayEffect => Some(GameMessage::PlayEffect(Box::new(
                PlayEffectData::unpack(data, offset)?,
            ))),
            GameOpcode::PrivateUpdatePropertyInt => Some(GameMessage::PrivateUpdatePropertyInt(
                Box::new(PrivateUpdatePropertyIntData::unpack(data, offset)?),
            )),
            GameOpcode::PublicUpdatePropertyInt => Some(GameMessage::PublicUpdatePropertyInt(
                Box::new(PublicUpdatePropertyIntData::unpack(data, offset)?),
            )),
            GameOpcode::PrivateUpdatePropertyInt64 => {
                Some(GameMessage::PrivateUpdatePropertyInt64(Box::new(
                    PrivateUpdatePropertyInt64Data::unpack(data, offset)?,
                )))
            }
            GameOpcode::PublicUpdatePropertyInt64 => Some(GameMessage::PublicUpdatePropertyInt64(
                Box::new(PublicUpdatePropertyInt64Data::unpack(data, offset)?),
            )),
            GameOpcode::PrivateUpdatePropertyBool => Some(GameMessage::PrivateUpdatePropertyBool(
                Box::new(PrivateUpdatePropertyBoolData::unpack(data, offset)?),
            )),
            GameOpcode::PublicUpdatePropertyBool => Some(GameMessage::PublicUpdatePropertyBool(
                Box::new(PublicUpdatePropertyBoolData::unpack(data, offset)?),
            )),
            GameOpcode::PrivateUpdatePropertyFloat => {
                Some(GameMessage::PrivateUpdatePropertyFloat(Box::new(
                    PrivateUpdatePropertyFloatData::unpack(data, offset)?,
                )))
            }
            GameOpcode::PublicUpdatePropertyFloat => Some(GameMessage::PublicUpdatePropertyFloat(
                Box::new(PublicUpdatePropertyFloatData::unpack(data, offset)?),
            )),
            GameOpcode::PrivateUpdatePropertyString => {
                Some(GameMessage::PrivateUpdatePropertyString(Box::new(
                    PrivateUpdatePropertyStringData::unpack(data, offset)?,
                )))
            }
            GameOpcode::PublicUpdatePropertyString => {
                Some(GameMessage::PublicUpdatePropertyString(Box::new(
                    PublicUpdatePropertyStringData::unpack(data, offset)?,
                )))
            }
            GameOpcode::PrivateUpdatePropertyDid => Some(GameMessage::PrivateUpdatePropertyDataId(
                Box::new(PrivateUpdatePropertyDataIdData::unpack(data, offset)?),
            )),
            GameOpcode::PublicUpdatePropertyDid => Some(GameMessage::PublicUpdatePropertyDataId(
                Box::new(PublicUpdatePropertyDataIdData::unpack(data, offset)?),
            )),
            GameOpcode::PrivateUpdatePropertyIid => {
                Some(GameMessage::PrivateUpdatePropertyInstanceId(Box::new(
                    PrivateUpdatePropertyInstanceIdData::unpack(data, offset)?,
                )))
            }
            GameOpcode::PublicUpdatePropertyIid => {
                Some(GameMessage::PublicUpdatePropertyInstanceId(Box::new(
                    PublicUpdatePropertyInstanceIdData::unpack(data, offset)?,
                )))
            }

            GameOpcode::ObjDescEvent => Some(GameMessage::ObjDescEvent(Box::new(
                ObjDescEventData::unpack(data, offset)?,
            ))),
            GameOpcode::ForceObjectDescSend => Some(GameMessage::ForceObjectDescSend(Box::new(
                ForceObjectDescSendData::unpack(data, offset)?,
            ))),
            GameOpcode::PrivateUpdateSkillLevel => Some(GameMessage::PrivateUpdateSkillLevel(
                Box::new(PrivateUpdateSkillLevelData::unpack(data, offset)?),
            )),
            GameOpcode::PublicUpdateSkillLevel => Some(GameMessage::PublicUpdateSkillLevel(
                Box::new(PublicUpdateSkillLevelData::unpack(data, offset)?),
            )),

            // === Wave 6.A — Qualities codegen wiring (2026-05-28) ===
            //
            // Decode 20 newly-enumerated opcodes (16 `Remove*` + 4
            // `Attribute/Skill`) via the generated `S2C_Qualities_*::read_from`
            // codegen path. The wire bytes are validated by the generated
            // parser (so a malformed payload returns None rather than
            // silently passing through), but the result is wrapped as
            // `GameMessage::Unknown` because we have NO semantic GameMessage
            // variants for these yet (would require widening the enum + all
            // its consumers across the workspace, deferred to a follow-on
            // wave).
            //
            // The advance-then-Unknown contract is the same as the
            // top-of-function fall-through path (line 35-36), so existing
            // recv-loop consumers see the same behaviour. Crucially, the
            // bytes are CONSUMED — the `read_from` Result mutates *offset —
            // so the next message in a batched frame decodes from the
            // correct boundary instead of mid-payload garbage.
            //
            // ACE source for the Remove* family: emitted by
            // `WorldObject_Properties.cs::RemoveProperty(Property*)` paths.
            // ACE source for the Attribute/Skill family: not emitted by ACE
            // (Chorizite XML protocol.xml:130-135 declares them but
            // `ACE.Server/Network/GameMessages/GameMessageOpcode.cs` has no
            // entries for 0x02E1/0x02E2/0x02E5/0x02E6). Routed for
            // future-host compatibility.
            GameOpcode::PrivateRemoveIntEvent
            | GameOpcode::RemoveIntEvent
            | GameOpcode::PrivateRemoveBoolEvent
            | GameOpcode::RemoveBoolEvent
            | GameOpcode::PrivateRemoveFloatEvent
            | GameOpcode::RemoveFloatEvent
            | GameOpcode::PrivateRemoveStringEvent
            | GameOpcode::RemoveStringEvent
            | GameOpcode::PrivateRemoveDataIdEvent
            | GameOpcode::RemoveDataIdEvent
            | GameOpcode::PrivateRemoveInstanceIdEvent
            | GameOpcode::RemoveInstanceIdEvent
            | GameOpcode::PrivateRemovePositionEvent
            | GameOpcode::RemovePositionEvent
            | GameOpcode::PrivateRemoveInt64Event
            | GameOpcode::RemoveInt64Event
            | GameOpcode::PrivateUpdateSkillAC
            | GameOpcode::PublicUpdateSkillAC
            | GameOpcode::PrivateUpdateAttributeLevel
            | GameOpcode::PublicUpdateAttributeLevel => {
                // Decode through the generated codegen layer to validate
                // the wire bytes + advance the cursor. The Ok value is
                // discarded — we wrap as Unknown until a semantic variant
                // is needed (see comment above). Errors fall through to a
                // raw byte-grab so existing recv-loop consumers don't
                // crash on malformed payloads.
                let payload_start = *offset;
                let consumed = match opcode_raw {
                    // Remove* — 5 bytes private (byte Sequence + uint Key),
                    // 9 bytes public (byte Sequence + ObjectId + uint Key)
                    // — codegen handles per-variant.
                    0x01D1 => crate::generated::S2C_Qualities_PrivateRemoveIntEvent::read_from(data, offset).is_ok(),
                    0x01D2 => crate::generated::S2C_Qualities_RemoveIntEvent::read_from(data, offset).is_ok(),
                    0x01D3 => crate::generated::S2C_Qualities_PrivateRemoveBoolEvent::read_from(data, offset).is_ok(),
                    0x01D4 => crate::generated::S2C_Qualities_RemoveBoolEvent::read_from(data, offset).is_ok(),
                    0x01D5 => crate::generated::S2C_Qualities_PrivateRemoveFloatEvent::read_from(data, offset).is_ok(),
                    0x01D6 => crate::generated::S2C_Qualities_RemoveFloatEvent::read_from(data, offset).is_ok(),
                    0x01D7 => crate::generated::S2C_Qualities_PrivateRemoveStringEvent::read_from(data, offset).is_ok(),
                    0x01D8 => crate::generated::S2C_Qualities_RemoveStringEvent::read_from(data, offset).is_ok(),
                    0x01D9 => crate::generated::S2C_Qualities_PrivateRemoveDataIdEvent::read_from(data, offset).is_ok(),
                    0x01DA => crate::generated::S2C_Qualities_RemoveDataIdEvent::read_from(data, offset).is_ok(),
                    0x01DB => crate::generated::S2C_Qualities_PrivateRemoveInstanceIdEvent::read_from(data, offset).is_ok(),
                    0x01DC => crate::generated::S2C_Qualities_RemoveInstanceIdEvent::read_from(data, offset).is_ok(),
                    0x01DD => crate::generated::S2C_Qualities_PrivateRemovePositionEvent::read_from(data, offset).is_ok(),
                    0x01DE => crate::generated::S2C_Qualities_RemovePositionEvent::read_from(data, offset).is_ok(),
                    0x02B8 => crate::generated::S2C_Qualities_PrivateRemoveInt64Event::read_from(data, offset).is_ok(),
                    0x02B9 => crate::generated::S2C_Qualities_RemoveInt64Event::read_from(data, offset).is_ok(),
                    0x02E1 => crate::generated::S2C_Qualities_PrivateUpdateSkillAC::read_from(data, offset).is_ok(),
                    0x02E2 => crate::generated::S2C_Qualities_UpdateSkillAC::read_from(data, offset).is_ok(),
                    0x02E5 => crate::generated::S2C_Qualities_PrivateUpdateAttributeLevel::read_from(data, offset).is_ok(),
                    0x02E6 => crate::generated::S2C_Qualities_UpdateAttributeLevel::read_from(data, offset).is_ok(),
                    _ => false,
                };
                if !consumed {
                    // Bad bytes — gobble rest of buffer so we don't loop
                    // (matches top-of-function Unknown fall-through).
                    let remaining = data[*offset..].to_vec();
                    *offset = data.len();
                    return Some(GameMessage::Unknown(opcode_raw, remaining));
                }
                // Capture the bytes the codegen consumed for downstream
                // diagnostic visibility (mirrors the Unknown payload
                // contract — caller has the bytes if it wants them).
                let consumed_bytes = data[payload_start..*offset].to_vec();
                Some(GameMessage::Unknown(opcode_raw, consumed_bytes))
            }
        }
    }
}
