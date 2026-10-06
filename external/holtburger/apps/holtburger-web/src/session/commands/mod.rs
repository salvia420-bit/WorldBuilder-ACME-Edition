//! `SessionCommand` dispatch for the wasm `recv_loop` (2026-10-05 split).
//!
//! The loop's `cmd = cmd_rx.next()` arm used to hold one ~5k-line `match`
//! with an inline arm per variant. The arms now live, verbatim, in one
//! module per concern; this match only routes each variant to its module
//! (exhaustive, so a new variant fails to compile until it is routed).

use crate::SessionCommand;
use crate::session::{LoopCtx, LoopFlow};

mod character;
mod combat;
mod housing;
mod inventory;
mod lifecycle;
mod movement;
mod social;

/// Handle one JS-side command. `LoopFlow::Exit` = the loop must return
/// (a send failed and `CLIENT_EVENT_KIND_DISCONNECTED` was queued).
pub(crate) async fn handle_command(ctx: &mut LoopCtx, cmd: SessionCommand) -> LoopFlow {
    match cmd {
        c @ (SessionCommand::PopulateTerrain { .. }
        | SessionCommand::RecallAllegianceHometown { .. }
        | SessionCommand::TeleToLifestone { .. }
        | SessionCommand::JumpChargeBegin { .. }
        | SessionCommand::JumpChargeCancel { .. }
        | SessionCommand::JumpChargeCommence { .. }
        | SessionCommand::JumpChargeRelease { .. }
        | SessionCommand::JumpChargeAbort { .. }
        | SessionCommand::PursueObject { .. }
        | SessionCommand::MoveToPosition { .. }
        | SessionCommand::PursuitTurnToObject { .. }
        | SessionCommand::PursuitTurnToHeading { .. }
        | SessionCommand::SetAutoRun { .. }
        | SessionCommand::NoteLocalCastWindow { .. }
        | SessionCommand::IngestMotionLengths { .. }
        | SessionCommand::CancelPursuit { .. }
        | SessionCommand::StickToObject { .. }
        | SessionCommand::StopStick { .. }
        | SessionCommand::AnimationDone { .. }
        | SessionCommand::Jump { .. }
        | SessionCommand::SetMovementInput { .. }
        | SessionCommand::KeyAction { .. }
        | SessionCommand::TickMovement { .. }) => movement::handle(ctx, c).await,
        c @ (SessionCommand::ToggleCombatMode { .. }
        | SessionCommand::SetCombatMode { .. }
        | SessionCommand::CastTargetedSpell { .. }
        | SessionCommand::CastUntargetedSpell { .. }
        | SessionCommand::RemoveSpellFromBook { .. }
        | SessionCommand::TargetedMissileAttack { .. }
        | SessionCommand::TargetedMeleeAttack { .. }
        | SessionCommand::CancelAttack { .. }
        | SessionCommand::QueryHealth { .. }) => combat::handle(ctx, c).await,
        c @ (SessionCommand::UseObject { .. }
        | SessionCommand::NoLongerViewingContents { .. }
        | SessionCommand::RequestAppraisal { .. }
        | SessionCommand::UseWithTarget { .. }
        | SessionCommand::SalvageItemsWith { .. }
        | SessionCommand::GiveObject { .. }
        | SessionCommand::BuyFromVendor { .. }
        | SessionCommand::SellToVendor { .. }
        | SessionCommand::OpenTrade { .. }
        | SessionCommand::CloseTrade { .. }
        | SessionCommand::AddToTrade { .. }
        | SessionCommand::AcceptTrade { .. }
        | SessionCommand::DeclineTrade { .. }
        | SessionCommand::ResetTrade { .. }
        | SessionCommand::BookData { .. }
        | SessionCommand::BookAddPage { .. }
        | SessionCommand::BookModifyPage { .. }
        | SessionCommand::BookDeletePage { .. }
        | SessionCommand::SetInscription { .. }
        | SessionCommand::WieldFromPack { .. }
        | SessionCommand::DropItem { .. }
        | SessionCommand::MoveItem { .. }
        | SessionCommand::UnwieldToPack { .. }
        | SessionCommand::SplitStackToWield { .. }
        | SessionCommand::SplitStackToContainer { .. }
        | SessionCommand::SplitStackTo3D { .. }
        | SessionCommand::MergeStacks { .. }
        | SessionCommand::AbandonContract { .. }) => inventory::handle(ctx, c).await,
        c @ (SessionCommand::SendChat { .. }
        | SessionCommand::SendEmote { .. }
        | SessionCommand::SendSoulEmote { .. }
        | SessionCommand::BroadcastEmoteMotion { .. }
        | SessionCommand::SendTell { .. }
        | SessionCommand::SendChannel { .. }
        | SessionCommand::SendTurbineChannel { .. }
        | SessionCommand::FellowshipCreate { .. }
        | SessionCommand::FellowshipQuit { .. }
        | SessionCommand::FellowshipDismiss { .. }
        | SessionCommand::FellowshipRecruit { .. }
        | SessionCommand::FellowshipUpdateRequest { .. }
        | SessionCommand::FellowshipAssignNewLeader { .. }
        | SessionCommand::SwearAllegiance { .. }
        | SessionCommand::ConfirmationResponse { .. }
        | SessionCommand::BreakAllegiance { .. }
        | SessionCommand::AddFriend { .. }
        | SessionCommand::RemoveFriend { .. }
        | SessionCommand::ModifyCharacterSquelch { .. }
        | SessionCommand::ModifyAccountSquelch { .. }
        | SessionCommand::ModifyGlobalSquelch { .. }
        | SessionCommand::SetAllegianceName { .. }
        | SessionCommand::SetAllegianceOfficer { .. }
        | SessionCommand::AllegianceChatGag { .. }
        | SessionCommand::AddAllegianceBan { .. }
        | SessionCommand::RemoveAllegianceBan { .. }
        | SessionCommand::BreakAllegianceBoot { .. }
        | SessionCommand::DoAllegianceLockAction { .. }
        | SessionCommand::AllegianceInfoRequest { .. }) => social::handle(ctx, c).await,
        c @ (SessionCommand::RaiseSkill { .. }
        | SessionCommand::TrainSkill { .. }
        | SessionCommand::RaiseAttribute { .. }
        | SessionCommand::RaiseVital { .. }
        | SessionCommand::SetCharacterOption { .. }
        | SessionCommand::AddShortcut { .. }
        | SessionCommand::RemoveShortcut { .. }
        | SessionCommand::TitleSet { .. }) => character::handle(ctx, c).await,
        c @ (SessionCommand::BuyHouse { .. }
        | SessionCommand::HouseQuery { .. }
        | SessionCommand::AbandonHouse { .. }
        | SessionCommand::RentHouse { .. }
        | SessionCommand::AddPermanentGuest { .. }
        | SessionCommand::BootSpecificHouseGuest { .. }
        | SessionCommand::RemoveAllPermanentGuests { .. }) => housing::handle(ctx, c).await,
        c @ (SessionCommand::ForceKeepalive { .. }
        | SessionCommand::SelectCharacter { .. }
        | SessionCommand::CreateCharacter { .. }
        | SessionCommand::DeleteCharacter { .. }
        | SessionCommand::RestoreCharacter { .. }) => lifecycle::handle(ctx, c).await,
    }
}
