//! `SessionCommand` arms: Character sheet: XP spends, skill training, character
//! options, shortcut bar, titles.
//!
//! Moved verbatim from the `recv_loop` command `select!` arm (2026-10-05
//! split); see `session::commands::handle_command` for the routing.

use crate::*;
use crate::session::{LoopCtx, LoopFlow};

pub(super) async fn handle(ctx: &mut LoopCtx, cmd: SessionCommand) -> LoopFlow {
    let LoopCtx { session, queued_events, latest_stats, world, movement, .. } = &mut *ctx;
    match cmd {
        // === Wave 4.A — Train Skills wasm exports (2026-05-28) ===
        //
        // Wire arms for the two progression GameActions. Both
        // mirror `ClientCommand::{RaiseSkill,TrainSkill}` already
        // routed in `holtburger-core` (commands.rs:178-179,
        // 862-878) — same `send_action(GameAction::...)` shape
        // as RemoveSpellFromBook above. ACE owns all validation
        // (skill exists, sufficient XP / credits, training
        // class transition legality); failures land back as
        // chat-message `WeenieError`s and the server's
        // `PrivateUpdateSkill` echo keeps the JS stats panel
        // honest. No optimistic local-side mutation — same
        // server-broadcast-of-truth pattern as setWielded
        // (lib.rs:35672-35720).
        SessionCommand::RaiseSkill { skill_type, xp_spent } => {
            use holtburger_protocol::messages::{
                GameAction, RaiseSkillActionData,
            };
            let action = GameAction::RaiseSkill(Box::new(
                RaiseSkillActionData { skill_type, xp_spent },
            ));
            send_or_disconnect!(
                queued_events,
                e,
                send_ordered!(movement, session, action),
                "recv_loop: send_action(RaiseSkill): {e}",
                "raise_skill: {e}",
                LoopFlow::Exit
            );
            console_log_str(&format!(
                "[raise_skill] skill_type={skill_type} xp_spent={xp_spent}",
            ));
        }
        SessionCommand::TrainSkill { skill_type, credits } => {
            use holtburger_protocol::messages::{
                GameAction, TrainSkillActionData,
            };
            let action = GameAction::TrainSkill(Box::new(
                TrainSkillActionData {
                    skill_type,
                    credits_spent: credits as i32,
                },
            ));
            send_or_disconnect!(
                queued_events,
                e,
                send_ordered!(movement, session, action),
                "recv_loop: send_action(TrainSkill): {e}",
                "train_skill: {e}",
                LoopFlow::Exit
            );
            console_log_str(&format!(
                "[train_skill] skill_type={skill_type} credits={credits}",
            ));
        }
        // 2026-05-30 — RaiseAttribute / RaiseVital (parallel to
        // RaiseSkill above). ACE owns validation; result lands
        // back as a PrivateUpdateAttribute / Attribute2nd echo.
        SessionCommand::RaiseAttribute { attribute_type, xp_spent } => {
            use holtburger_protocol::messages::{
                GameAction, RaiseAttributeActionData,
            };
            let action = GameAction::RaiseAttribute(Box::new(
                RaiseAttributeActionData { attribute_type, xp_spent },
            ));
            send_or_disconnect!(
                queued_events,
                e,
                send_ordered!(movement, session, action),
                "recv_loop: send_action(RaiseAttribute): {e}",
                "raise_attribute: {e}",
                LoopFlow::Exit
            );
            console_log_str(&format!(
                "[raise_attribute] attribute_type={attribute_type} xp_spent={xp_spent}",
            ));
        }
        SessionCommand::RaiseVital { vital_type, xp_spent } => {
            use holtburger_protocol::messages::{
                GameAction, RaiseVitalActionData,
            };
            let action = GameAction::RaiseVital(Box::new(
                RaiseVitalActionData { vital_type, xp_spent },
            ));
            send_or_disconnect!(
                queued_events,
                e,
                send_ordered!(movement, session, action),
                "recv_loop: send_action(RaiseVital): {e}",
                "raise_vital: {e}",
                LoopFlow::Exit
            );
            console_log_str(&format!(
                "[raise_vital] vital_type={vital_type} xp_spent={xp_spent}",
            ));
        }
        SessionCommand::SetCharacterOption { option, value } => {
            // Wave 11 Phase 33 (2026-05-26): mirror
            // ClientCommand::SetCharacterOption from
            // holtburger-core/src/client/commands.rs:603-614 —
            // build and send a GameAction::SetSingleCharacterOption.
            //
            // 2026-06-05 update (P0-2 follow-up): ACE does NOT
            // echo CharacterOptions1/2 back via PropertyInt
            // (`PropertyInt.cs:639-640` are commented out —
            // 9003/9004), so the prior "let the player-stats
            // pipeline pick up the echo" path was a no-op. The
            // server-authoritative state arrives via
            // `PlayerDescription`'s `options1`/`options2`
            // fields on (re)login. To make the options-panel
            // checkboxes reflect user intent IMMEDIATELY
            // mid-session, we optimistically apply the same
            // bitflag mutation locally + re-publish the stats
            // snapshot so JS getters see the new state.
            //
            // charopt-1 (2026-10-08): retail `CPlayerModule::OnChanged`
            // keeps IgnoreFellowshipRequests / FellowshipAutoAccept-
            // Requests mutually exclusive — enabling one first clears
            // and sends the other. `apply_character_option` applies the
            // local bits and returns the sends in wire order. The
            // RefCell borrow is dropped before any send.
            use holtburger_protocol::messages::{
                GameAction, SetSingleCharacterOptionActionData,
            };
            let sends: Vec<(holtburger_common::CharacterOption, bool)> =
                match world.borrow_mut().as_mut() {
                    Some(w) => w.player.apply_character_option(option, value),
                    None => vec![(option, value)],
                };
            for (send_option, send_value) in sends {
                let action = GameAction::SetSingleCharacterOption(Box::new(
                    SetSingleCharacterOptionActionData {
                        option: send_option,
                        value: send_value,
                    },
                ));
                send_or_disconnect!(
                    queued_events,
                    e,
                    send_ordered!(movement, session, action),
                    "recv_loop: send_action(SetSingleCharacterOption {send_option:?} = {send_value}): {e}",
                    "set_character_option: {e}",
                    LoopFlow::Exit
                );
                console_log_str(&format!(
                    "[character-option] set: {send_option:?} = {send_value}",
                ));
            }
            if let Some(w) = world.borrow().as_ref() {
                publish_player_stats_snapshot(w, &latest_stats);
            }
        }
        SessionCommand::AddShortcut { index, object_guid, spell_id, layer } => {
            // P1-6 follow-up: send GameAction::AddShortcut
            // (sub-opcode 0x019C) to ACE. The server persists
            // (index, objectId) to the Character table —
            // bindings survive logout. spell_id + layer are
            // wire-only fields ACE doesn't store; we still
            // ship them so the packet matches the retail
            // ACE.Network ReadShortcut() shape.
            use holtburger_common::Guid;
            use holtburger_protocol::messages::{
                GameAction, AddShortcutActionData,
                player::shortcuts::Shortcut,
            };
            let action = GameAction::AddShortcut(Box::new(AddShortcutActionData {
                shortcut: Shortcut {
                    index,
                    object_id: Guid(object_guid),
                    spell_id,
                    layer,
                },
            }));
            send_or_disconnect!(
                queued_events,
                e,
                send_ordered!(movement, session, action),
                "recv_loop: send_action(AddShortcut idx={index} guid=0x{object_guid:08X}): {e}",
                "add_shortcut: {e}",
                LoopFlow::Exit
            );
            console_log_str(&format!(
                "[shortcut] add: idx={index} guid=0x{object_guid:08X} spell={spell_id} layer={layer}",
            ));
        }
        SessionCommand::RemoveShortcut { index } => {
            use holtburger_protocol::messages::{
                GameAction, RemoveShortcutActionData,
            };
            let action = GameAction::RemoveShortcut(Box::new(RemoveShortcutActionData {
                index,
            }));
            send_or_disconnect!(
                queued_events,
                e,
                send_ordered!(movement, session, action),
                "recv_loop: send_action(RemoveShortcut idx={index}): {e}",
                "remove_shortcut: {e}",
                LoopFlow::Exit
            );
            console_log_str(&format!("[shortcut] remove: idx={index}"));
        }
        SessionCommand::AddSpellFavorite { spell_id, index, list } => {
            // input-options-2 (2026-10-13): retail
            // SpellCastSubMenu::AddSpellToPlayerModule — update the local
            // PlayerModule lists (spell_favorites, ACE's rules), then
            // CM_Character::Event_AddSpellFavorite. The RefCell borrow is
            // dropped before the send.
            use holtburger_protocol::messages::{AddSpellFavoriteActionData, GameAction};
            if let Some(w) = world.borrow_mut().as_mut() {
                let known = w.player.spells.contains_key(&spell_id);
                crate::spell_favorites::add_spell_favorite(
                    &mut w.player.hotbar_spells,
                    spell_id,
                    index,
                    list,
                    known,
                );
            }
            let action = GameAction::AddSpellFavorite(Box::new(AddSpellFavoriteActionData {
                spell_id,
                index,
                list,
            }));
            send_or_disconnect!(
                queued_events,
                e,
                send_ordered!(movement, session, action),
                "recv_loop: send_action(AddSpellFavorite spell={spell_id} idx={index} list={list}): {e}",
                "add_spell_favorite: {e}",
                LoopFlow::Exit
            );
        }
        SessionCommand::RemoveSpellFavorite { spell_id, list } => {
            // input-options-2: retail
            // SpellCastSubMenu::RemoveSpellFromPlayerModule →
            // CM_Character::Event_RemoveSpellFavorite.
            use holtburger_protocol::messages::{GameAction, RemoveSpellFavoriteActionData};
            if let Some(w) = world.borrow_mut().as_mut() {
                crate::spell_favorites::remove_spell_favorite(
                    &mut w.player.hotbar_spells,
                    spell_id,
                    list,
                );
            }
            let action = GameAction::RemoveSpellFavorite(Box::new(
                RemoveSpellFavoriteActionData { spell_id, list },
            ));
            send_or_disconnect!(
                queued_events,
                e,
                send_ordered!(movement, session, action),
                "recv_loop: send_action(RemoveSpellFavorite spell={spell_id} list={list}): {e}",
                "remove_spell_favorite: {e}",
                LoopFlow::Exit
            );
        }
        SessionCommand::SpellbookFilter { filters } => {
            // input-options-2: retail gmSpellbookUI::UpdateFilter
            // (acclient.c:198845) stores the word in the PlayerModule, then
            // sends CM_Character::Event_SpellbookFilterEvent.
            use holtburger_protocol::messages::{GameAction, SpellbookFilterActionData};
            if let Some(w) = world.borrow_mut().as_mut() {
                w.player.spellbook_filters = filters;
            }
            let action =
                GameAction::SpellbookFilter(Box::new(SpellbookFilterActionData { filters }));
            send_or_disconnect!(
                queued_events,
                e,
                send_ordered!(movement, session, action),
                "recv_loop: send_action(SpellbookFilter 0x{filters:08X}): {e}",
                "spellbook_filter: {e}",
                LoopFlow::Exit
            );
        }
        SessionCommand::TitleSet { title_id } => {
            use holtburger_protocol::messages::{GameAction, TitleSetActionData};
            let action =
                GameAction::TitleSet(Box::new(TitleSetActionData { title_id }));
            send_or_disconnect!(
                queued_events,
                e,
                send_ordered!(movement, session, action),
                "recv_loop: send_action(TitleSet): {e}",
                "title_set: {e}",
                LoopFlow::Exit
            );
            console_log_str(&format!("[title/set] id={title_id}"));
        }
        SessionCommand::FinishBarber { fields } => {
            // maps-chargen-barber-1 (2026-10-13): gmBarberUI Apply →
            // CM_Character::Event_FinishBarber (acclient.c:270300). ACE
            // HandleActionFinishBarber answers a valid request with an
            // ObjDescEvent (applied by the existing appearance path) and
            // drops an invalid one silently; plugins/barber-panel.js runs
            // the ported ACE checks before calling finishBarber.
            use holtburger_protocol::messages::{FinishBarberActionData, GameAction};
            let action = GameAction::FinishBarber(Box::new(
                FinishBarberActionData::from_fields(&fields),
            ));
            send_or_disconnect!(
                queued_events,
                e,
                send_ordered!(movement, session, action),
                "recv_loop: send_action(FinishBarber): {e}",
                "finish_barber: {e}",
                LoopFlow::Exit
            );
            console_log_str(&format!(
                "[barber] FinishBarber setup=0x{:08X} option1={}",
                fields[13], fields[14],
            ));
        }
        SessionCommand::QueryAge => {
            // chat-errors-8 (2026-10-13): `/age` → CM_Character::
            // Event_QueryAge (acclient.c:697985), target 0 (DoAge sends the
            // selection only for a PSR). ACE answers QueryAgeResponse
            // (0x01C3); messages/game_event.rs prints the retail line.
            use holtburger_protocol::messages::{GameAction, QueryAgeActionData};
            let action = GameAction::QueryAge(Box::new(QueryAgeActionData { target: 0 }));
            send_or_disconnect!(
                queued_events,
                e,
                send_ordered!(movement, session, action),
                "recv_loop: send_action(QueryAge): {e}",
                "query_age: {e}",
                LoopFlow::Exit
            );
        }
        SessionCommand::QueryBirth => {
            // chat-errors-8: `/birth` → CM_Character::Event_QueryBirth
            // (acclient.c:698035), target 0 (retail DoBirth). ACE answers
            // with its own Broadcast line.
            use holtburger_protocol::messages::{GameAction, QueryBirthActionData};
            let action = GameAction::QueryBirth(Box::new(QueryBirthActionData { target: 0 }));
            send_or_disconnect!(
                queued_events,
                e,
                send_ordered!(movement, session, action),
                "recv_loop: send_action(QueryBirth): {e}",
                "query_birth: {e}",
                LoopFlow::Exit
            );
        }
        _ => unreachable!("SessionCommand routed to the wrong handler module"),
    }
    LoopFlow::Continue
}
