pub use crate::messages::allegiance::events::*;
pub use crate::messages::book::events::*;
pub use crate::messages::chat::events::*;
pub use crate::messages::chat::turbine::*;
pub use crate::messages::chess::events::*;
pub use crate::messages::combat::events::*;
pub use crate::messages::contracts::events::*;
pub use crate::messages::fellowship::events::*;
pub use crate::messages::friends::events::*;
pub use crate::messages::house::events::*;
pub use crate::messages::inventory::events::*;
pub use crate::messages::item_ops::events::*;
pub use crate::messages::magic::events::*;
pub use crate::messages::misc::events::*;
pub use crate::messages::network::events::*;
pub use crate::messages::object::events::*;
pub use crate::messages::player::events::*;
pub use crate::messages::squelch::events::*;
pub use crate::messages::title::events::*;
pub use crate::messages::trade::events::*;
pub use crate::messages::ui_events::events::*;

use crate::opcodes::GameEventOpcode;
use crate::traits::{ProtocolPack, ProtocolUnpack};
use byteorder::{ByteOrder, LittleEndian, WriteBytesExt};
use holtburger_common::Guid;

#[derive(Debug, Clone, PartialEq)]
pub struct GameEventMessage {
    pub target: Guid,
    pub sequence: u32,
    pub event: GameEvent,
}

#[derive(Debug, Clone, PartialEq)]
pub enum GameEvent {
    PlayerDescription(Box<PlayerDescriptionEventData>),
    PingResponse(Box<PingResponseEventData>),
    ViewContents(Box<ViewContentsEventData>),
    InventoryPutObjInContainer(Box<InventoryPutObjInContainerEventData>),
    InventoryPutObjectIn3D(Box<InventoryPutObjectIn3DEventData>),
    WieldObject(Box<WieldObjectEventData>),
    Tell(Box<TellEventData>),
    ChannelBroadcast(Box<ChannelBroadcastEventData>),
    SetTurbineChatChannels(Box<SetTurbineChatChannelsEventData>),
    PopupString(Box<PopupStringEventData>),
    CommunicationTransientString(Box<CommunicationTransientStringEventData>),
    StartGame,
    AttackDone(Box<AttackDoneEventData>),
    AttackerNotification(Box<AttackerNotificationEventData>),
    DefenderNotification(Box<DefenderNotificationEventData>),
    EvasionAttackerNotification(Box<EvasionAttackerNotificationEventData>),
    EvasionDefenderNotification(Box<EvasionDefenderNotificationEventData>),
    CombatCommenceAttack,
    VictimNotification(Box<VictimNotificationEventData>),
    KillerNotification(Box<KillerNotificationEventData>),
    MagicUpdateEnchantment(Box<MagicUpdateEnchantmentEventData>),
    MagicUpdateMultipleEnchantments(Box<MagicUpdateMultipleEnchantmentsEventData>),
    MagicRemoveEnchantment(Box<MagicRemoveEnchantmentEventData>),
    MagicRemoveMultipleEnchantments(Box<MagicRemoveMultipleEnchantmentsEventData>),
    MagicPurgeEnchantments(Box<MagicPurgeEnchantmentsEventData>),
    MagicPurgeBadEnchantments(Box<MagicPurgeBadEnchantmentsEventData>),
    MagicUpdateSpell(Box<MagicUpdateSpellEventData>),
    MagicRemoveSpell(Box<MagicRemoveSpellEventData>),
    MagicDispelEnchantment(Box<MagicDispelEnchantmentEventData>),
    MagicDispelMultipleEnchantments(Box<MagicDispelMultipleEnchantmentsEventData>),
    WeenieError(Box<WeenieErrorEventData>),
    WeenieErrorWithString(Box<WeenieErrorWithStringEventData>),
    UseDone(Box<UseDoneEventData>),
    IdentifyObjectResponse(Box<IdentifyObjectResponseEventData>),
    InventoryServerSaveFailed(Box<InventoryServerSaveFailedEventData>),
    CharacterConfirmationRequest(Box<CharacterConfirmationRequestEventData>),
    CharacterConfirmationDone(Box<CharacterConfirmationDoneEventData>),
    CloseGroundContainer(Box<CloseGroundContainerEventData>),
    UpdateHealth(Box<UpdateHealthEventData>),
    QueryItemManaResponse(Box<QueryItemManaResponseEventData>),
    FellowshipFullUpdate(Box<FellowshipFullUpdateEventData>),
    FellowshipDisband,
    FellowshipUpdateFellow(Box<FellowshipUpdateFellowEventData>),
    RegisterTrade(Box<RegisterTradeEventData>),
    OpenTrade(Box<OpenTradeEventData>),
    CloseTrade(Box<CloseTradeEventData>),
    AddToTrade(Box<AddToTradeEventData>),
    AcceptTrade(Box<AcceptTradeEventData>),
    DeclineTrade(Box<DeclineTradeEventData>),
    ResetTrade(Box<ResetTradeEventData>),
    TradeFailure(Box<TradeFailureEventData>),
    ClearTradeAcceptance,
    BookDataResponse(Box<BookDataResponseEventData>),
    BookPageDataResponse(Box<BookPageDataResponseEventData>),
    BookModifyPageResponse(Box<BookModifyPageResponseEventData>),
    BookAddPageResponse(Box<BookAddPageResponseEventData>),
    BookDeletePageResponse(Box<BookDeletePageResponseEventData>),
    ApproachVendor(Box<ApproachVendorEventData>),
    FellowshipQuit(Box<FellowshipQuitEventData>),
    FellowshipDismiss(Box<FellowshipDismissEventData>),
    FellowshipFellowUpdateDone,
    FellowshipFellowStatsDone,
    AllegianceUpdate(Box<AllegianceUpdateEventData>),
    /// Wave-F3 (2026-05-27): S2C notification that a member of the
    /// player's allegiance logged in/out.
    /// Opcode `AllegianceLoginNotification = 0x027A`.
    AllegianceLoginNotification(Box<AllegianceLoginNotificationEventData>),
    /// Wave-F3 (2026-05-27): S2C reply to a client's
    /// `Allegiance_AllegianceInfoRequest` carrying a queried player's
    /// `AllegianceProfile`. Opcode `AllegianceInfoResponse = 0x027C`.
    AllegianceInfoResponse(Box<AllegianceInfoResponseEventData>),
    FriendsListUpdate(Box<FriendsListUpdateEventData>),
    SetSquelchDb(Box<SetSquelchDbEventData>),
    CharacterTitle(Box<CharacterTitleEventData>),
    UpdateTitle(Box<UpdateTitleEventData>),
    HouseStatus(Box<HouseStatusEventData>),
    HouseData(Box<HouseDataEventData>),
    HouseProfile(Box<HouseProfileEventData>),
    HouseUpdateRestrictions(Box<HouseUpdateRestrictionsEventData>),
    /// Wave F.5 (2026-05-27): single-contract delta from ACE's
    /// `ContractManager` — Add (delete=false), Erase (delete=true), and
    /// per-quest stage/timestamp updates (`MonitoredQuestFlags`
    /// notification). Opcode `SendClientContractTracker = 0x0315`.
    SendClientContractTracker(Box<SendClientContractTrackerEventData>),
    /// Wave F.5 (2026-05-27): full contract-tracker table pushed at
    /// login by ACE `Player_Networking.SendContractTrackerTable` when
    /// the player has ≥1 contract. Opcode
    /// `SendClientContractTrackerTable = 0x0314`.
    SendClientContractTrackerTable(Box<SendClientContractTrackerTableEventData>),
    // === Wave 6.C — Portal Storm dispatch (2026-05-28) ===
    /// Wave 6.C: Brewing variant of the portal-storm UI signal —
    /// "This area is getting too crowded — a Portal Storm is brewing"
    /// per ACE `GameEventPortalStormBrewing.cs`. Opcode
    /// `MiscPortalStormBrewing = 0x02C9`. Carries an `extent: f32`
    /// payload (ACE default 0.4) — when ≤ 0 the client resets the
    /// brewing timer per Chorizite XML annotation.
    MiscPortalStormBrewing(Box<MiscPortalStormBrewingEventData>),
    /// Wave 6.C: Imminent variant — final warning before the actual
    /// storm. ACE `GameEventPortalStormImminent.cs`. Opcode
    /// `MiscPortalStormImminent = 0x02CA`. Carries an `extent: f32`
    /// (ACE default 0.6).
    MiscPortalStormImminent(Box<MiscPortalStormImminentEventData>),
    /// Wave 6.C: the actual portal storm fired — the client gets
    /// teleported. ACE `GameEventPortalStorm.cs`. Opcode
    /// `MiscPortalStorm = 0x02CB`. No payload.
    MiscPortalStorm,
    /// Wave 6.C: portal storm subsided — area is safe to re-enter.
    /// ACE `GameEventPortalStormSubsided.cs`. Opcode
    /// `MiscPortalStormSubsided = 0x02CC`. No payload.
    MiscPortalStormSubsided,
    /// SG-C1a (2026-06-09): chess minigame — join result (`0x0281`).
    JoinGameResponse(Box<JoinGameResponseEventData>),
    /// SG-C1a: chess minigame — own-move result (`0x0283`).
    MoveResponse(Box<MoveResponseEventData>),
    /// SG-C1a: chess minigame — opponent's move (`0x0284`).
    OpponentTurn(Box<OpponentTurnEventData>),
    /// SG-C1a: chess minigame — opponent stalemate offer/retract (`0x0285`).
    OpponentStalemate(Box<OpponentStalemateEventData>),
    /// SG-C1a: chess minigame — game over (`0x028C`).
    GameOver(Box<GameOverEventData>),
    /// SG-C2 (2026-06-09): per-material salvage yield (`0x02B4`).
    SalvageOperationsResult(Box<SalvageOperationsResultEventData>),
    /// SG-C2: object inscription + scribe (`GetInscriptionResponse` 0x00C3;
    /// deprecated in retail — inscription normally arrives via appraisal).
    InscriptionResponse(Box<InscriptionResponseEventData>),
    /// SG-C3 (2026-06-09): reply to /age (`0x01C3`).
    QueryAgeResponse(Box<QueryAgeResponseEventData>),
    /// SG-C3: open the barber/appearance editor (`0x0075`).
    StartBarber(Box<StartBarberEventData>),
    /// SG-C3: online players in a chat channel (`0x0148`).
    ChannelList(Box<ChannelListEventData>),
    /// SG-C3: chat channels available to the player (`0x0149`).
    ChannelIndex(Box<ChannelIndexEventData>),
    /// SG-C3: house access records / guest list (`0x0257`).
    UpdateHar(Box<UpdateHarEventData>),
    /// SG-C3: available houses to purchase (`0x0271`).
    HouseAvailableHouses(Box<HouseAvailableHousesEventData>),
    Unknown(u32, Vec<u8>),
}

impl ProtocolUnpack for GameEventMessage {
    fn unpack(data: &[u8], offset: &mut usize) -> Option<Self> {
        let target = Guid::unpack(data, offset)?;
        if *offset + 8 > data.len() {
            return None;
        }
        let sequence = LittleEndian::read_u32(&data[*offset..*offset + 4]);
        let event_type_raw = LittleEndian::read_u32(&data[*offset + 4..*offset + 8]);
        *offset += 8;

        let event_op = GameEventOpcode::from_repr(event_type_raw);

        let event = match event_op {
            Some(op) => match op {
                GameEventOpcode::PlayerDescription => GameEvent::PlayerDescription(Box::new(
                    PlayerDescriptionEventData::unpack(target, sequence, data, offset)?,
                )),
                GameEventOpcode::PingResponse => {
                    GameEvent::PingResponse(Box::new(PingResponseEventData::unpack(data, offset)?))
                }
                GameEventOpcode::ViewContents => {
                    GameEvent::ViewContents(Box::new(ViewContentsEventData::unpack(data, offset)?))
                }
                GameEventOpcode::InventoryPutObjInContainer => {
                    GameEvent::InventoryPutObjInContainer(Box::new(
                        InventoryPutObjInContainerEventData::unpack(data, offset)?,
                    ))
                }
                GameEventOpcode::InventoryPutObjectIn3D => GameEvent::InventoryPutObjectIn3D(
                    Box::new(InventoryPutObjectIn3DEventData::unpack(data, offset)?),
                ),
                GameEventOpcode::WieldObject => {
                    GameEvent::WieldObject(Box::new(WieldObjectEventData::unpack(data, offset)?))
                }
                GameEventOpcode::Tell => {
                    GameEvent::Tell(Box::new(TellEventData::unpack(data, offset)?))
                }
                GameEventOpcode::ChannelBroadcast => GameEvent::ChannelBroadcast(Box::new(
                    ChannelBroadcastEventData::unpack(data, offset)?,
                )),
                GameEventOpcode::SetTurbineChatChannels => GameEvent::SetTurbineChatChannels(
                    Box::new(SetTurbineChatChannelsEventData::unpack(data, offset)?),
                ),
                GameEventOpcode::PopupString => {
                    GameEvent::PopupString(Box::new(PopupStringEventData::unpack(data, offset)?))
                }
                GameEventOpcode::CommunicationTransientString => {
                    GameEvent::CommunicationTransientString(Box::new(
                        CommunicationTransientStringEventData::unpack(data, offset)?,
                    ))
                }
                GameEventOpcode::StartGame => GameEvent::StartGame,
                GameEventOpcode::AttackDone => {
                    GameEvent::AttackDone(Box::new(AttackDoneEventData::unpack(data, offset)?))
                }
                GameEventOpcode::AttackerNotification => GameEvent::AttackerNotification(Box::new(
                    AttackerNotificationEventData::unpack(data, offset)?,
                )),
                GameEventOpcode::DefenderNotification => GameEvent::DefenderNotification(Box::new(
                    DefenderNotificationEventData::unpack(data, offset)?,
                )),
                GameEventOpcode::EvasionAttackerNotification => {
                    GameEvent::EvasionAttackerNotification(Box::new(
                        EvasionAttackerNotificationEventData::unpack(data, offset)?,
                    ))
                }
                GameEventOpcode::EvasionDefenderNotification => {
                    GameEvent::EvasionDefenderNotification(Box::new(
                        EvasionDefenderNotificationEventData::unpack(data, offset)?,
                    ))
                }
                GameEventOpcode::CombatCommenceAttack => GameEvent::CombatCommenceAttack,
                GameEventOpcode::VictimNotification => GameEvent::VictimNotification(Box::new(
                    VictimNotificationEventData::unpack(data, offset)?,
                )),
                GameEventOpcode::KillerNotification => GameEvent::KillerNotification(Box::new(
                    KillerNotificationEventData::unpack(data, offset)?,
                )),
                GameEventOpcode::MagicUpdateEnchantment => {
                    let mut d = MagicUpdateEnchantmentEventData::unpack(data, offset)?;
                    d.target = target;
                    d.sequence = sequence;
                    GameEvent::MagicUpdateEnchantment(Box::new(d))
                }
                GameEventOpcode::MagicUpdateMultipleEnchantments => {
                    let mut d = MagicUpdateMultipleEnchantmentsEventData::unpack(data, offset)?;
                    d.target = target;
                    d.sequence = sequence;
                    GameEvent::MagicUpdateMultipleEnchantments(Box::new(d))
                }
                GameEventOpcode::MagicRemoveEnchantment => {
                    let mut d = MagicRemoveEnchantmentEventData::unpack(data, offset)?;
                    d.target = target;
                    d.sequence = sequence;
                    GameEvent::MagicRemoveEnchantment(Box::new(d))
                }
                GameEventOpcode::MagicRemoveMultipleEnchantments => {
                    let mut d = MagicRemoveMultipleEnchantmentsEventData::unpack(data, offset)?;
                    d.target = target;
                    d.sequence = sequence;
                    GameEvent::MagicRemoveMultipleEnchantments(Box::new(d))
                }
                GameEventOpcode::MagicPurgeEnchantments => {
                    let mut d = MagicPurgeEnchantmentsEventData::unpack(data, offset)?;
                    d.target = target;
                    d.sequence = sequence;
                    GameEvent::MagicPurgeEnchantments(Box::new(d))
                }
                GameEventOpcode::MagicPurgeBadEnchantments => {
                    let mut d = MagicPurgeBadEnchantmentsEventData::unpack(data, offset)?;
                    d.target = target;
                    d.sequence = sequence;
                    GameEvent::MagicPurgeBadEnchantments(Box::new(d))
                }
                GameEventOpcode::MagicUpdateSpell => GameEvent::MagicUpdateSpell(Box::new(
                    MagicUpdateSpellEventData::unpack(data, offset)?,
                )),
                GameEventOpcode::MagicRemoveSpell => GameEvent::MagicRemoveSpell(Box::new(
                    MagicRemoveSpellEventData::unpack(data, offset)?,
                )),
                GameEventOpcode::MagicDispelEnchantment => {
                    let mut d = MagicDispelEnchantmentEventData::unpack(data, offset)?;
                    d.target = target;
                    d.sequence = sequence;
                    GameEvent::MagicDispelEnchantment(Box::new(d))
                }
                GameEventOpcode::MagicDispelMultipleEnchantments => {
                    let mut d = MagicDispelMultipleEnchantmentsEventData::unpack(data, offset)?;
                    d.target = target;
                    d.sequence = sequence;
                    GameEvent::MagicDispelMultipleEnchantments(Box::new(d))
                }
                GameEventOpcode::WeenieError => {
                    GameEvent::WeenieError(Box::new(WeenieErrorEventData::unpack(data, offset)?))
                }
                GameEventOpcode::WeenieErrorWithString => GameEvent::WeenieErrorWithString(
                    Box::new(WeenieErrorWithStringEventData::unpack(data, offset)?),
                ),
                GameEventOpcode::UseDone => {
                    GameEvent::UseDone(Box::new(UseDoneEventData::unpack(data, offset)?))
                }
                GameEventOpcode::IdentifyObjectResponse => GameEvent::IdentifyObjectResponse(
                    Box::new(IdentifyObjectResponseEventData::unpack(data, offset)?),
                ),
                GameEventOpcode::InventoryServerSaveFailed => GameEvent::InventoryServerSaveFailed(
                    Box::new(InventoryServerSaveFailedEventData::unpack(data, offset)?),
                ),
                GameEventOpcode::CharacterConfirmationRequest => {
                    GameEvent::CharacterConfirmationRequest(Box::new(
                        CharacterConfirmationRequestEventData::unpack(data, offset)?,
                    ))
                }
                GameEventOpcode::CharacterConfirmationDone => GameEvent::CharacterConfirmationDone(
                    Box::new(CharacterConfirmationDoneEventData::unpack(data, offset)?),
                ),
                GameEventOpcode::CloseGroundContainer => GameEvent::CloseGroundContainer(Box::new(
                    CloseGroundContainerEventData::unpack(data, offset)?,
                )),
                GameEventOpcode::UpdateHealth => {
                    GameEvent::UpdateHealth(Box::new(UpdateHealthEventData::unpack(data, offset)?))
                }
                GameEventOpcode::QueryItemManaResponse => GameEvent::QueryItemManaResponse(
                    Box::new(QueryItemManaResponseEventData::unpack(data, offset)?),
                ),
                GameEventOpcode::FellowshipFullUpdate => GameEvent::FellowshipFullUpdate(Box::new(
                    FellowshipFullUpdateEventData::unpack(data, offset)?,
                )),
                GameEventOpcode::FellowshipDisband => GameEvent::FellowshipDisband,
                GameEventOpcode::FellowshipUpdateFellow => GameEvent::FellowshipUpdateFellow(
                    Box::new(FellowshipUpdateFellowEventData::unpack(data, offset)?),
                ),
                GameEventOpcode::RegisterTrade => GameEvent::RegisterTrade(Box::new(
                    RegisterTradeEventData::unpack(data, offset)?,
                )),
                GameEventOpcode::OpenTrade => {
                    GameEvent::OpenTrade(Box::new(OpenTradeEventData::unpack(data, offset)?))
                }
                GameEventOpcode::CloseTrade => {
                    GameEvent::CloseTrade(Box::new(CloseTradeEventData::unpack(data, offset)?))
                }
                GameEventOpcode::AddToTrade => {
                    GameEvent::AddToTrade(Box::new(AddToTradeEventData::unpack(data, offset)?))
                }
                GameEventOpcode::AcceptTrade => {
                    GameEvent::AcceptTrade(Box::new(AcceptTradeEventData::unpack(data, offset)?))
                }
                GameEventOpcode::DeclineTrade => {
                    GameEvent::DeclineTrade(Box::new(DeclineTradeEventData::unpack(data, offset)?))
                }
                GameEventOpcode::ResetTrade => {
                    GameEvent::ResetTrade(Box::new(ResetTradeEventData::unpack(data, offset)?))
                }
                GameEventOpcode::TradeFailure => {
                    GameEvent::TradeFailure(Box::new(TradeFailureEventData::unpack(data, offset)?))
                }
                GameEventOpcode::ClearTradeAcceptance => GameEvent::ClearTradeAcceptance,
                GameEventOpcode::BookDataResponse => GameEvent::BookDataResponse(Box::new(
                    BookDataResponseEventData::unpack(data, offset)?,
                )),
                GameEventOpcode::BookPageDataResponse => GameEvent::BookPageDataResponse(Box::new(
                    BookPageDataResponseEventData::unpack(data, offset)?,
                )),
                GameEventOpcode::BookModifyPageResponse => GameEvent::BookModifyPageResponse(
                    Box::new(BookModifyPageResponseEventData::unpack(data, offset)?),
                ),
                GameEventOpcode::BookAddPageResponse => GameEvent::BookAddPageResponse(Box::new(
                    BookAddPageResponseEventData::unpack(data, offset)?,
                )),
                GameEventOpcode::BookDeletePageResponse => GameEvent::BookDeletePageResponse(
                    Box::new(BookDeletePageResponseEventData::unpack(data, offset)?),
                ),
                GameEventOpcode::ApproachVendor => GameEvent::ApproachVendor(Box::new(
                    ApproachVendorEventData::unpack(data, offset)?,
                )),
                GameEventOpcode::FellowshipQuit => GameEvent::FellowshipQuit(Box::new(
                    FellowshipQuitEventData::unpack(data, offset)?,
                )),
                GameEventOpcode::FellowshipDismiss => GameEvent::FellowshipDismiss(Box::new(
                    FellowshipDismissEventData::unpack(data, offset)?,
                )),
                GameEventOpcode::FellowshipFellowUpdateDone => {
                    GameEvent::FellowshipFellowUpdateDone
                }
                GameEventOpcode::FellowshipFellowStatsDone => GameEvent::FellowshipFellowStatsDone,
                GameEventOpcode::AllegianceUpdate => GameEvent::AllegianceUpdate(Box::new(
                    AllegianceUpdateEventData::unpack(data, offset)?,
                )),
                GameEventOpcode::AllegianceLoginNotification => {
                    GameEvent::AllegianceLoginNotification(Box::new(
                        AllegianceLoginNotificationEventData::unpack(data, offset)?,
                    ))
                }
                GameEventOpcode::AllegianceInfoResponse => GameEvent::AllegianceInfoResponse(
                    Box::new(AllegianceInfoResponseEventData::unpack(data, offset)?),
                ),
                GameEventOpcode::FriendsListUpdate => GameEvent::FriendsListUpdate(Box::new(
                    FriendsListUpdateEventData::unpack(data, offset)?,
                )),
                GameEventOpcode::SetSquelchDb => GameEvent::SetSquelchDb(Box::new(
                    SetSquelchDbEventData::unpack(data, offset)?,
                )),
                GameEventOpcode::CharacterTitle => GameEvent::CharacterTitle(Box::new(
                    CharacterTitleEventData::unpack(data, offset)?,
                )),
                GameEventOpcode::UpdateTitle => GameEvent::UpdateTitle(Box::new(
                    UpdateTitleEventData::unpack(data, offset)?,
                )),
                GameEventOpcode::HouseStatus => GameEvent::HouseStatus(Box::new(
                    HouseStatusEventData::unpack(data, offset)?,
                )),
                GameEventOpcode::HouseData => GameEvent::HouseData(Box::new(
                    HouseDataEventData::unpack(data, offset)?,
                )),
                GameEventOpcode::HouseProfile => GameEvent::HouseProfile(Box::new(
                    HouseProfileEventData::unpack(data, offset)?,
                )),
                GameEventOpcode::HouseUpdateRestrictions => GameEvent::HouseUpdateRestrictions(
                    Box::new(HouseUpdateRestrictionsEventData::unpack(data, offset)?),
                ),
                GameEventOpcode::SendClientContractTracker => {
                    GameEvent::SendClientContractTracker(Box::new(
                        SendClientContractTrackerEventData::unpack(data, offset)?,
                    ))
                }
                GameEventOpcode::SendClientContractTrackerTable => {
                    GameEvent::SendClientContractTrackerTable(Box::new(
                        SendClientContractTrackerTableEventData::unpack(data, offset)?,
                    ))
                }
                // === Wave 6.C — Portal Storm dispatch (2026-05-28) ===
                GameEventOpcode::MiscPortalStormBrewing => GameEvent::MiscPortalStormBrewing(
                    Box::new(MiscPortalStormBrewingEventData::unpack(data, offset)?),
                ),
                GameEventOpcode::MiscPortalStormImminent => GameEvent::MiscPortalStormImminent(
                    Box::new(MiscPortalStormImminentEventData::unpack(data, offset)?),
                ),
                GameEventOpcode::MiscPortalStorm => GameEvent::MiscPortalStorm,
                GameEventOpcode::MiscPortalStormSubsided => GameEvent::MiscPortalStormSubsided,
                // SG-C1a (2026-06-09): chess minigame events.
                GameEventOpcode::JoinGameResponse => GameEvent::JoinGameResponse(Box::new(
                    JoinGameResponseEventData::unpack(data, offset)?,
                )),
                GameEventOpcode::MoveResponse => {
                    GameEvent::MoveResponse(Box::new(MoveResponseEventData::unpack(data, offset)?))
                }
                GameEventOpcode::OpponentTurn => {
                    GameEvent::OpponentTurn(Box::new(OpponentTurnEventData::unpack(data, offset)?))
                }
                GameEventOpcode::OpponentStalemate => GameEvent::OpponentStalemate(Box::new(
                    OpponentStalemateEventData::unpack(data, offset)?,
                )),
                GameEventOpcode::GameOver => {
                    GameEvent::GameOver(Box::new(GameOverEventData::unpack(data, offset)?))
                }
                // SG-C2 (2026-06-09): item-op self-events.
                GameEventOpcode::SalvageOperationsResult => GameEvent::SalvageOperationsResult(
                    Box::new(SalvageOperationsResultEventData::unpack(data, offset)?),
                ),
                GameEventOpcode::GetInscriptionResponse => GameEvent::InscriptionResponse(Box::new(
                    InscriptionResponseEventData::unpack(data, offset)?,
                )),
                // SG-C3 (2026-06-09): UI-surface self-events.
                GameEventOpcode::QueryAgeResponse => GameEvent::QueryAgeResponse(Box::new(
                    QueryAgeResponseEventData::unpack(data, offset)?,
                )),
                GameEventOpcode::StartBarber => {
                    GameEvent::StartBarber(Box::new(StartBarberEventData::unpack(data, offset)?))
                }
                GameEventOpcode::ChannelList => {
                    GameEvent::ChannelList(Box::new(ChannelListEventData::unpack(data, offset)?))
                }
                GameEventOpcode::ChannelIndex => {
                    GameEvent::ChannelIndex(Box::new(ChannelIndexEventData::unpack(data, offset)?))
                }
                GameEventOpcode::UpdateHar => {
                    GameEvent::UpdateHar(Box::new(UpdateHarEventData::unpack(data, offset)?))
                }
                GameEventOpcode::AvailableHouses => GameEvent::HouseAvailableHouses(Box::new(
                    HouseAvailableHousesEventData::unpack(data, offset)?,
                )),
            },
            None => {
                log::warn!(
                    "<<< Unknown GameEvent Opcode: {:08X} Target: {:08X} Seq: {}",
                    event_type_raw,
                    target,
                    sequence
                );
                let remaining = data[*offset..].to_vec();
                *offset = data.len();
                GameEvent::Unknown(event_type_raw, remaining)
            }
        };

        Some(GameEventMessage {
            target,
            sequence,
            event,
        })
    }
}

impl ProtocolPack for GameEventMessage {
    fn pack(&self, buf: &mut Vec<u8>) {
        self.target.pack(buf);
        buf.write_u32::<LittleEndian>(self.sequence).unwrap();

        match &self.event {
            GameEvent::PlayerDescription(data) => {
                buf.write_u32::<LittleEndian>(GameEventOpcode::PlayerDescription as u32)
                    .unwrap();
                data.pack(buf);
            }
            GameEvent::PingResponse(data) => {
                buf.write_u32::<LittleEndian>(GameEventOpcode::PingResponse as u32)
                    .unwrap();
                data.pack(buf);
            }
            GameEvent::ViewContents(data) => {
                buf.write_u32::<LittleEndian>(GameEventOpcode::ViewContents as u32)
                    .unwrap();
                data.pack(buf);
            }
            GameEvent::InventoryPutObjInContainer(data) => {
                buf.write_u32::<LittleEndian>(GameEventOpcode::InventoryPutObjInContainer as u32)
                    .unwrap();
                data.pack(buf);
            }
            GameEvent::InventoryPutObjectIn3D(data) => {
                buf.write_u32::<LittleEndian>(GameEventOpcode::InventoryPutObjectIn3D as u32)
                    .unwrap();
                data.pack(buf);
            }
            GameEvent::WieldObject(data) => {
                buf.write_u32::<LittleEndian>(GameEventOpcode::WieldObject as u32)
                    .unwrap();
                data.pack(buf);
            }
            GameEvent::Tell(data) => {
                buf.write_u32::<LittleEndian>(GameEventOpcode::Tell as u32)
                    .unwrap();
                data.pack(buf);
            }
            GameEvent::ChannelBroadcast(data) => {
                buf.write_u32::<LittleEndian>(GameEventOpcode::ChannelBroadcast as u32)
                    .unwrap();
                data.pack(buf);
            }
            GameEvent::SetTurbineChatChannels(data) => {
                buf.write_u32::<LittleEndian>(GameEventOpcode::SetTurbineChatChannels as u32)
                    .unwrap();
                data.pack(buf);
            }
            GameEvent::PopupString(data) => {
                buf.write_u32::<LittleEndian>(GameEventOpcode::PopupString as u32)
                    .unwrap();
                data.pack(buf);
            }
            GameEvent::CommunicationTransientString(data) => {
                buf.write_u32::<LittleEndian>(GameEventOpcode::CommunicationTransientString as u32)
                    .unwrap();
                data.pack(buf);
            }
            GameEvent::StartGame => {
                buf.write_u32::<LittleEndian>(GameEventOpcode::StartGame as u32)
                    .unwrap();
            }
            GameEvent::AttackDone(data) => {
                buf.write_u32::<LittleEndian>(GameEventOpcode::AttackDone as u32)
                    .unwrap();
                data.pack(buf);
            }
            GameEvent::AttackerNotification(data) => {
                buf.write_u32::<LittleEndian>(GameEventOpcode::AttackerNotification as u32)
                    .unwrap();
                data.pack(buf);
            }
            GameEvent::DefenderNotification(data) => {
                buf.write_u32::<LittleEndian>(GameEventOpcode::DefenderNotification as u32)
                    .unwrap();
                data.pack(buf);
            }
            GameEvent::EvasionAttackerNotification(data) => {
                buf.write_u32::<LittleEndian>(GameEventOpcode::EvasionAttackerNotification as u32)
                    .unwrap();
                data.pack(buf);
            }
            GameEvent::EvasionDefenderNotification(data) => {
                buf.write_u32::<LittleEndian>(GameEventOpcode::EvasionDefenderNotification as u32)
                    .unwrap();
                data.pack(buf);
            }
            GameEvent::CombatCommenceAttack => {
                buf.write_u32::<LittleEndian>(GameEventOpcode::CombatCommenceAttack as u32)
                    .unwrap();
            }
            GameEvent::VictimNotification(data) => {
                buf.write_u32::<LittleEndian>(GameEventOpcode::VictimNotification as u32)
                    .unwrap();
                data.pack(buf);
            }
            GameEvent::KillerNotification(data) => {
                buf.write_u32::<LittleEndian>(GameEventOpcode::KillerNotification as u32)
                    .unwrap();
                data.pack(buf);
            }
            GameEvent::MagicUpdateEnchantment(data) => {
                buf.write_u32::<LittleEndian>(GameEventOpcode::MagicUpdateEnchantment as u32)
                    .unwrap();
                data.pack(buf);
            }
            GameEvent::MagicUpdateMultipleEnchantments(data) => {
                buf.write_u32::<LittleEndian>(
                    GameEventOpcode::MagicUpdateMultipleEnchantments as u32,
                )
                .unwrap();
                data.pack(buf);
            }
            GameEvent::MagicRemoveEnchantment(data) => {
                buf.write_u32::<LittleEndian>(GameEventOpcode::MagicRemoveEnchantment as u32)
                    .unwrap();
                data.pack(buf);
            }
            GameEvent::MagicRemoveMultipleEnchantments(data) => {
                buf.write_u32::<LittleEndian>(
                    GameEventOpcode::MagicRemoveMultipleEnchantments as u32,
                )
                .unwrap();
                data.pack(buf);
            }
            GameEvent::MagicPurgeEnchantments(data) => {
                buf.write_u32::<LittleEndian>(GameEventOpcode::MagicPurgeEnchantments as u32)
                    .unwrap();
                data.pack(buf);
            }
            GameEvent::MagicPurgeBadEnchantments(data) => {
                buf.write_u32::<LittleEndian>(GameEventOpcode::MagicPurgeBadEnchantments as u32)
                    .unwrap();
                data.pack(buf);
            }
            GameEvent::MagicUpdateSpell(data) => {
                buf.write_u32::<LittleEndian>(GameEventOpcode::MagicUpdateSpell as u32)
                    .unwrap();
                data.pack(buf);
            }
            GameEvent::MagicRemoveSpell(data) => {
                buf.write_u32::<LittleEndian>(GameEventOpcode::MagicRemoveSpell as u32)
                    .unwrap();
                data.pack(buf);
            }
            GameEvent::MagicDispelEnchantment(data) => {
                buf.write_u32::<LittleEndian>(GameEventOpcode::MagicDispelEnchantment as u32)
                    .unwrap();
                data.pack(buf);
            }
            GameEvent::MagicDispelMultipleEnchantments(data) => {
                buf.write_u32::<LittleEndian>(
                    GameEventOpcode::MagicDispelMultipleEnchantments as u32,
                )
                .unwrap();
                data.pack(buf);
            }
            GameEvent::WeenieError(data) => {
                buf.write_u32::<LittleEndian>(GameEventOpcode::WeenieError as u32)
                    .unwrap();
                data.pack(buf);
            }
            GameEvent::WeenieErrorWithString(data) => {
                buf.write_u32::<LittleEndian>(GameEventOpcode::WeenieErrorWithString as u32)
                    .unwrap();
                data.pack(buf);
            }
            GameEvent::UseDone(data) => {
                buf.write_u32::<LittleEndian>(GameEventOpcode::UseDone as u32)
                    .unwrap();
                data.pack(buf);
            }
            GameEvent::IdentifyObjectResponse(data) => {
                buf.write_u32::<LittleEndian>(GameEventOpcode::IdentifyObjectResponse as u32)
                    .unwrap();
                data.pack(buf);
            }
            GameEvent::InventoryServerSaveFailed(data) => {
                buf.write_u32::<LittleEndian>(GameEventOpcode::InventoryServerSaveFailed as u32)
                    .unwrap();
                data.pack(buf);
            }
            GameEvent::CharacterConfirmationRequest(data) => {
                buf.write_u32::<LittleEndian>(GameEventOpcode::CharacterConfirmationRequest as u32)
                    .unwrap();
                data.pack(buf);
            }
            GameEvent::CharacterConfirmationDone(data) => {
                buf.write_u32::<LittleEndian>(GameEventOpcode::CharacterConfirmationDone as u32)
                    .unwrap();
                data.pack(buf);
            }
            GameEvent::CloseGroundContainer(data) => {
                buf.write_u32::<LittleEndian>(GameEventOpcode::CloseGroundContainer as u32)
                    .unwrap();
                data.pack(buf);
            }
            GameEvent::UpdateHealth(data) => {
                buf.write_u32::<LittleEndian>(GameEventOpcode::UpdateHealth as u32)
                    .unwrap();
                data.pack(buf);
            }
            GameEvent::QueryItemManaResponse(data) => {
                buf.write_u32::<LittleEndian>(GameEventOpcode::QueryItemManaResponse as u32)
                    .unwrap();
                data.pack(buf);
            }
            GameEvent::FellowshipFullUpdate(data) => {
                buf.write_u32::<LittleEndian>(GameEventOpcode::FellowshipFullUpdate as u32)
                    .unwrap();
                data.pack(buf);
            }
            GameEvent::FellowshipDisband => {
                buf.write_u32::<LittleEndian>(GameEventOpcode::FellowshipDisband as u32)
                    .unwrap();
            }
            GameEvent::FellowshipUpdateFellow(data) => {
                buf.write_u32::<LittleEndian>(GameEventOpcode::FellowshipUpdateFellow as u32)
                    .unwrap();
                data.pack(buf);
            }
            GameEvent::RegisterTrade(data) => {
                buf.write_u32::<LittleEndian>(GameEventOpcode::RegisterTrade as u32)
                    .unwrap();
                data.pack(buf);
            }
            GameEvent::OpenTrade(data) => {
                buf.write_u32::<LittleEndian>(GameEventOpcode::OpenTrade as u32)
                    .unwrap();
                data.pack(buf);
            }
            GameEvent::CloseTrade(data) => {
                buf.write_u32::<LittleEndian>(GameEventOpcode::CloseTrade as u32)
                    .unwrap();
                data.pack(buf);
            }
            GameEvent::AddToTrade(data) => {
                buf.write_u32::<LittleEndian>(GameEventOpcode::AddToTrade as u32)
                    .unwrap();
                data.pack(buf);
            }
            GameEvent::AcceptTrade(data) => {
                buf.write_u32::<LittleEndian>(GameEventOpcode::AcceptTrade as u32)
                    .unwrap();
                data.pack(buf);
            }
            GameEvent::DeclineTrade(data) => {
                buf.write_u32::<LittleEndian>(GameEventOpcode::DeclineTrade as u32)
                    .unwrap();
                data.pack(buf);
            }
            GameEvent::ResetTrade(data) => {
                buf.write_u32::<LittleEndian>(GameEventOpcode::ResetTrade as u32)
                    .unwrap();
                data.pack(buf);
            }
            GameEvent::TradeFailure(data) => {
                buf.write_u32::<LittleEndian>(GameEventOpcode::TradeFailure as u32)
                    .unwrap();
                data.pack(buf);
            }
            GameEvent::ClearTradeAcceptance => {
                buf.write_u32::<LittleEndian>(GameEventOpcode::ClearTradeAcceptance as u32)
                    .unwrap();
            }
            GameEvent::BookDataResponse(data) => {
                buf.write_u32::<LittleEndian>(GameEventOpcode::BookDataResponse as u32)
                    .unwrap();
                data.pack(buf);
            }
            GameEvent::BookPageDataResponse(data) => {
                buf.write_u32::<LittleEndian>(GameEventOpcode::BookPageDataResponse as u32)
                    .unwrap();
                data.pack(buf);
            }
            GameEvent::BookModifyPageResponse(data) => {
                buf.write_u32::<LittleEndian>(GameEventOpcode::BookModifyPageResponse as u32)
                    .unwrap();
                data.pack(buf);
            }
            GameEvent::BookAddPageResponse(data) => {
                buf.write_u32::<LittleEndian>(GameEventOpcode::BookAddPageResponse as u32)
                    .unwrap();
                data.pack(buf);
            }
            GameEvent::BookDeletePageResponse(data) => {
                buf.write_u32::<LittleEndian>(GameEventOpcode::BookDeletePageResponse as u32)
                    .unwrap();
                data.pack(buf);
            }
            GameEvent::ApproachVendor(data) => {
                buf.write_u32::<LittleEndian>(GameEventOpcode::ApproachVendor as u32)
                    .unwrap();
                data.pack(buf);
            }
            GameEvent::FellowshipQuit(data) => {
                buf.write_u32::<LittleEndian>(GameEventOpcode::FellowshipQuit as u32)
                    .unwrap();
                data.pack(buf);
            }
            GameEvent::FellowshipDismiss(data) => {
                buf.write_u32::<LittleEndian>(GameEventOpcode::FellowshipDismiss as u32)
                    .unwrap();
                data.pack(buf);
            }
            GameEvent::FellowshipFellowUpdateDone => {
                buf.write_u32::<LittleEndian>(GameEventOpcode::FellowshipFellowUpdateDone as u32)
                    .unwrap();
            }
            GameEvent::FellowshipFellowStatsDone => {
                buf.write_u32::<LittleEndian>(GameEventOpcode::FellowshipFellowStatsDone as u32)
                    .unwrap();
            }
            GameEvent::AllegianceUpdate(data) => {
                buf.write_u32::<LittleEndian>(GameEventOpcode::AllegianceUpdate as u32)
                    .unwrap();
                data.pack(buf);
            }
            GameEvent::AllegianceLoginNotification(data) => {
                buf.write_u32::<LittleEndian>(GameEventOpcode::AllegianceLoginNotification as u32)
                    .unwrap();
                data.pack(buf);
            }
            GameEvent::AllegianceInfoResponse(data) => {
                buf.write_u32::<LittleEndian>(GameEventOpcode::AllegianceInfoResponse as u32)
                    .unwrap();
                data.pack(buf);
            }
            GameEvent::FriendsListUpdate(data) => {
                buf.write_u32::<LittleEndian>(GameEventOpcode::FriendsListUpdate as u32)
                    .unwrap();
                data.pack(buf);
            }
            GameEvent::SetSquelchDb(data) => {
                buf.write_u32::<LittleEndian>(GameEventOpcode::SetSquelchDb as u32)
                    .unwrap();
                data.pack(buf);
            }
            GameEvent::CharacterTitle(data) => {
                buf.write_u32::<LittleEndian>(GameEventOpcode::CharacterTitle as u32)
                    .unwrap();
                data.pack(buf);
            }
            GameEvent::UpdateTitle(data) => {
                buf.write_u32::<LittleEndian>(GameEventOpcode::UpdateTitle as u32)
                    .unwrap();
                data.pack(buf);
            }
            GameEvent::HouseStatus(data) => {
                buf.write_u32::<LittleEndian>(GameEventOpcode::HouseStatus as u32)
                    .unwrap();
                data.pack(buf);
            }
            GameEvent::HouseData(data) => {
                buf.write_u32::<LittleEndian>(GameEventOpcode::HouseData as u32)
                    .unwrap();
                data.pack(buf);
            }
            GameEvent::HouseProfile(data) => {
                buf.write_u32::<LittleEndian>(GameEventOpcode::HouseProfile as u32)
                    .unwrap();
                data.pack(buf);
            }
            GameEvent::HouseUpdateRestrictions(data) => {
                buf.write_u32::<LittleEndian>(GameEventOpcode::HouseUpdateRestrictions as u32)
                    .unwrap();
                data.pack(buf);
            }
            GameEvent::SendClientContractTracker(data) => {
                buf.write_u32::<LittleEndian>(
                    GameEventOpcode::SendClientContractTracker as u32,
                )
                .unwrap();
                data.pack(buf);
            }
            GameEvent::SendClientContractTrackerTable(data) => {
                buf.write_u32::<LittleEndian>(
                    GameEventOpcode::SendClientContractTrackerTable as u32,
                )
                .unwrap();
                data.pack(buf);
            }
            // === Wave 6.C — Portal Storm dispatch (2026-05-28) ===
            GameEvent::MiscPortalStormBrewing(data) => {
                buf.write_u32::<LittleEndian>(GameEventOpcode::MiscPortalStormBrewing as u32)
                    .unwrap();
                data.pack(buf);
            }
            GameEvent::MiscPortalStormImminent(data) => {
                buf.write_u32::<LittleEndian>(GameEventOpcode::MiscPortalStormImminent as u32)
                    .unwrap();
                data.pack(buf);
            }
            GameEvent::MiscPortalStorm => {
                buf.write_u32::<LittleEndian>(GameEventOpcode::MiscPortalStorm as u32)
                    .unwrap();
            }
            GameEvent::MiscPortalStormSubsided => {
                buf.write_u32::<LittleEndian>(GameEventOpcode::MiscPortalStormSubsided as u32)
                    .unwrap();
            }
            // SG-C1a (2026-06-09): chess minigame events.
            GameEvent::JoinGameResponse(data) => {
                buf.write_u32::<LittleEndian>(GameEventOpcode::JoinGameResponse as u32)
                    .unwrap();
                data.pack(buf);
            }
            GameEvent::MoveResponse(data) => {
                buf.write_u32::<LittleEndian>(GameEventOpcode::MoveResponse as u32)
                    .unwrap();
                data.pack(buf);
            }
            GameEvent::OpponentTurn(data) => {
                buf.write_u32::<LittleEndian>(GameEventOpcode::OpponentTurn as u32)
                    .unwrap();
                data.pack(buf);
            }
            GameEvent::OpponentStalemate(data) => {
                buf.write_u32::<LittleEndian>(GameEventOpcode::OpponentStalemate as u32)
                    .unwrap();
                data.pack(buf);
            }
            GameEvent::GameOver(data) => {
                buf.write_u32::<LittleEndian>(GameEventOpcode::GameOver as u32)
                    .unwrap();
                data.pack(buf);
            }
            // SG-C2 (2026-06-09): item-op self-events.
            GameEvent::SalvageOperationsResult(data) => {
                buf.write_u32::<LittleEndian>(GameEventOpcode::SalvageOperationsResult as u32)
                    .unwrap();
                data.pack(buf);
            }
            GameEvent::InscriptionResponse(data) => {
                buf.write_u32::<LittleEndian>(GameEventOpcode::GetInscriptionResponse as u32)
                    .unwrap();
                data.pack(buf);
            }
            // SG-C3 (2026-06-09): UI-surface self-events.
            GameEvent::QueryAgeResponse(data) => {
                buf.write_u32::<LittleEndian>(GameEventOpcode::QueryAgeResponse as u32)
                    .unwrap();
                data.pack(buf);
            }
            GameEvent::StartBarber(data) => {
                buf.write_u32::<LittleEndian>(GameEventOpcode::StartBarber as u32)
                    .unwrap();
                data.pack(buf);
            }
            GameEvent::ChannelList(data) => {
                buf.write_u32::<LittleEndian>(GameEventOpcode::ChannelList as u32)
                    .unwrap();
                data.pack(buf);
            }
            GameEvent::ChannelIndex(data) => {
                buf.write_u32::<LittleEndian>(GameEventOpcode::ChannelIndex as u32)
                    .unwrap();
                data.pack(buf);
            }
            GameEvent::UpdateHar(data) => {
                buf.write_u32::<LittleEndian>(GameEventOpcode::UpdateHar as u32)
                    .unwrap();
                data.pack(buf);
            }
            GameEvent::HouseAvailableHouses(data) => {
                buf.write_u32::<LittleEndian>(GameEventOpcode::AvailableHouses as u32)
                    .unwrap();
                data.pack(buf);
            }
            GameEvent::Unknown(opcode, data) => {
                buf.write_u32::<LittleEndian>(*opcode).unwrap();
                buf.extend_from_slice(data);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::messages::game_message::GameMessage;
    use crate::test_helpers::assert_pack_unpack_parity;

    #[test]
    fn test_gamemessage_routing_game_event_start() {
        // Opcode (0xF7B0), Target (0x50000001), Seq (0x0E), Event (0x0282)
        let hex_str = "B0F70000010000500E00000082020000";
        let data = hex::decode(hex_str).expect("Hex decode failed");
        let expected = GameMessage::GameEvent(Box::new(GameEventMessage {
            target: Guid(0x50000001),
            sequence: 0x0E,
            event: GameEvent::StartGame,
        }));
        assert_pack_unpack_parity(&data, &expected);
    }

    #[test]
    fn test_channel_broadcast_unpack_failure() {
        // Hex from user report: B0F7...00
        // Corrected with padded empty string: 00000000 for sender_name
        let hex_str = "B0F70000010000500D00000047010000040000000000000079002B4275646479206861732063726561746564205368697274202830783830303035443235292061742030784441353530303144205B38352E363730333837203130372E3938343732362031392E3939353030315D20302E34373432303020302E30303030303020302E30303030303020302E3838303431372E00";
        let data = hex::decode(hex_str).expect("Hex decode failed");
        let mut offset = 0;
        let msg = GameMessage::unpack(&data, &mut offset).expect("Should unpack ChannelBroadcast");
        if let GameMessage::GameEvent(ev) = msg {
            if let GameEvent::ChannelBroadcast(_cb) = ev.event {
                // Success
            } else {
                panic!("Expected ChannelBroadcast");
            }
        } else {
            panic!("Expected GameEvent");
        }
    }
}
