//! `SessionCommand` arms: Social: chat/emotes/tells/channels, fellowship,
//! allegiance, friends, squelch, confirmation dialogs.
//!
//! Moved verbatim from the `recv_loop` command `select!` arm (2026-10-05
//! split); see `session::commands::handle_command` for the routing.

use crate::*;
use crate::session::{LoopCtx, LoopFlow};
use holtburger_protocol::messages::{GameAction, GameMessage, TalkActionData};

pub(super) async fn handle(ctx: &mut LoopCtx, cmd: SessionCommand) -> LoopFlow {
    let LoopCtx {
        session,
        queued_events,
        turbine_chat_state,
        world,
        state,
        movement,
        entity_seeded,
        latest_friends,
        ..
    } = &mut *ctx;
    match cmd {
        SessionCommand::SendChat { message } => {
            // Phase 4 step 2a.6: the cli routes chat
            // through `session.send_action(GameAction::Talk(...))`
            // (see `apps/holtburger-cli/src/.../commands.rs`
            // ClientCommand::Talk arm). ACE's command
            // parser treats any incoming Talk that starts
            // with `@` as a command — including
            // `@telepoi Holtburg` for the Training-Academy
            // bypass. `/`-prefixed slash commands are
            // NOT parsed by GameActionTalk; the JS-side
            // chat panel routes them to sendTell /
            // sendChannel instead (see `plugins/chat-panel.js`
            // submitChat).
            let action = GameAction::Talk(Box::new(TalkActionData { message }));
            send_or_disconnect!(
                queued_events,
                e,
                send_ordered!(movement, session, action),
                "recv_loop: send_action(Talk): {e}",
                "send_chat: {e}",
                LoopFlow::Exit
            );
        }
        SessionCommand::SendEmote { message } => {
            // Wave 9 Phase 9.2 (2026-05-26). Free-form text
            // emote (`/me <action>`) → `GameAction::Emote`
            // sub-opcode 0x01DF. ACE rebroadcasts as
            // `GameMessageEmoteText` (0x01E0) for nearby
            // players to see; no motion is played.
            use holtburger_protocol::messages::chat::actions::EmoteActionData;
            let action = GameAction::Emote(Box::new(EmoteActionData { message }));
            send_or_disconnect!(
                queued_events,
                e,
                send_ordered!(movement, session, action),
                "recv_loop: send_action(Emote): {e}",
                "send_emote: {e}",
                LoopFlow::Exit
            );
        }
        SessionCommand::SendSoulEmote { message } => {
            // Wave 9 Phase 9.2 (2026-05-26). Pose / soul
            // emote (`/bow`, `/wave`, etc.) →
            // `GameAction::SoulEmote` sub-opcode 0x01E1.
            // ACE rebroadcasts the chat text via
            // `GameMessageSoulEmote` (0x01E2). The
            // matching motion is sent separately via
            // `Movement_MoveToState` from the JS layer's
            // local-prediction path (mirrors retail's
            // `cmdinterp` local play at
            // `~/ac-headers/acclient.c:425567`).
            use holtburger_protocol::messages::chat::actions::SoulEmoteActionData;
            let action = GameAction::SoulEmote(Box::new(SoulEmoteActionData {
                message,
            }));
            send_or_disconnect!(
                queued_events,
                e,
                send_ordered!(movement, session, action),
                "recv_loop: send_action(SoulEmote): {e}",
                "send_soul_emote: {e}",
                LoopFlow::Exit
            );
        }
        SessionCommand::BroadcastEmoteMotion { motion_full } => {
            // Wave 9.5 (2026-05-26). Queue a transient
            // MoveToState pulse so PVS-visible players
            // see the emote animation, not just the
            // chat text. The cli's MovementSystem
            // serializes this on the next TickMovement
            // arm via `send_transient_motion_pulse` →
            // `RawMotionState.commands = [MotionItem]`
            // → ACE `ApplyMotion` Action branch →
            // `BroadcastMovement` to all observers.
            //
            // Mirrors the canonical cli path at
            // `crates/holtburger-core/src/client/
            // commands.rs:376-385` (soul-emote slash
            // command in the CLI client).
            //
            // Pre-EnteredWorld / pre-entity-seeded calls
            // drop silently — same defense as
            // SetMovementInput (lib.rs:~27250). The JS
            // side gates `routeSlashCommand` on
            // `enteredWorld` already so this is just
            // belt-and-suspenders.
            let world_guard = world.borrow();
            let Some(w) = world_guard.as_ref() else {
                console_log_str(
                    "[wave9.5] BroadcastEmoteMotion before WorldState ready — dropping",
                );
                return LoopFlow::Continue;
            };
            if !*entity_seeded {
                console_log_str(
                    "[wave9.5] BroadcastEmoteMotion before player entity seeded — dropping",
                );
                return LoopFlow::Continue;
            }
            // Extract low-16 substate for InterpretedMotionCommand.
            // The wire `MotionItem` carries the substate u16; the
            // class high-bits (0x13 for one-shots, 0x43 for held
            // States) are reapplied during packing per retail's
            // `RawMotionState::Pack` (acclient.c offset 0x0051F820)
            // and the cli's `MotionItem::pack` at
            // `crates/holtburger-protocol/src/messages/movement/
            // types.rs:431-441`.
            let cmd_u16 = (motion_full & 0xFFFF) as u16;
            let interpreted = holtburger_protocol::messages::movement::
                InterpretedMotionCommand::from(cmd_u16);
            // PreserveServer keeps the player's last server-
            // echoed stance (last_server_motion_style). The
            // emote shouldn't toggle stance — bow while in
            // sword combat stays in sword stance.
            let motion_style =
                holtburger_core::client::movement_types::MotionStyle::PreserveServer;
            movement.enqueue_transient_motion(interpreted, motion_style);
            let _ = w;
            console_log_str(&format!(
                "[wave9.5] queued transient emote motion full=0x{motion_full:08X} \
                 low=0x{cmd_u16:04X} style=PreserveServer",
            ));
        }
        SessionCommand::SendTell { target, message } => {
            use holtburger_protocol::messages::chat::actions::TellActionData;
            let action = GameAction::Tell(Box::new(TellActionData {
                target,
                message,
            }));
            send_or_disconnect!(
                queued_events,
                e,
                send_ordered!(movement, session, action),
                "recv_loop: send_action(Tell): {e}",
                "send_tell: {e}",
                LoopFlow::Exit
            );
        }
        SessionCommand::SendChannel { channel, message } => {
            use holtburger_protocol::messages::chat::actions::ChatChannelActionData;
            use holtburger_protocol::messages::ChatChannelId;
            let action = GameAction::ChatChannel(Box::new(ChatChannelActionData {
                channel: ChatChannelId::from_raw(channel),
                message,
            }));
            send_or_disconnect!(
                queued_events,
                e,
                send_ordered!(movement, session, action),
                "recv_loop: send_action(ChatChannel): {e}",
                "send_channel: {e}",
                LoopFlow::Exit
            );
        }
        SessionCommand::SendTurbineChannel { chat_type, message } => {
            // Mirror holtburger-core's
            // resolve_turbine_channel + send-TurbineChat
            // path (crates/holtburger-core/src/client/
            // commands.rs:294-321). Look up the
            // pre-advertised channel for chat_type, fail
            // gracefully if turbine chat is disabled or
            // the channel hasn't been advertised yet.
            use holtburger_protocol::messages::chat::turbine::{
                TurbineChatBlobType, TurbineChatDispatchType,
                TurbineChatMessageData, TurbineChatPayload, TurbineChatType,
                TurbineChatTypeId,
            };
            let chat_type_enum = match TurbineChatType::from_repr(chat_type) {
                Some(t) => t,
                None => {
                    queued_events.borrow_mut().push(ClientEvent {
                        kind: CLIENT_EVENT_KIND_CHAT_RECEIVED,
                        string_payload: Some(format!(
                            "send_turbine_channel: unknown chat_type 0x{chat_type:X}"
                        )),
                        u32_payload: None,
                        u32_payload_2: None,
                        f32_payload: None,
                    });
                    return LoopFlow::Continue;
                }
            };
            // R-chat chat-1 (2026-10-08): retail binds `a` / `guild` /
            // `gu` to the Turbine allegiance room only once
            // StartupTurbineChatSystem has run (acclient.c:424334); with
            // turbine chat disabled `a` stays DoStupidChannelHack, i.e.
            // the legacy AllegianceBroadcast channel (0x02000000).
            let is_allegiance = matches!(chat_type_enum, TurbineChatType::Allegiance);
            let turbine_enabled = turbine_chat_state.borrow().enabled;
            if is_allegiance && !turbine_enabled {
                use holtburger_protocol::messages::chat::actions::ChatChannelActionData;
                use holtburger_protocol::messages::ChatChannelId;
                let action = GameAction::ChatChannel(Box::new(ChatChannelActionData {
                    channel: ChatChannelId::from_raw(0x0200_0000),
                    message,
                }));
                send_or_disconnect!(
                    queued_events,
                    e,
                    send_ordered!(movement, session, action),
                    "recv_loop: send_action(ChatChannel AB fallback): {e}",
                    "send_turbine_channel: {e}",
                    LoopFlow::Exit
                );
                return LoopFlow::Continue;
            }
            // Snapshot resolved state OUT of the borrow so
            // the mutable next_context_id update doesn't
            // re-enter the cell.
            let resolved = {
                let mut tcs = turbine_chat_state.borrow_mut();
                if !tcs.enabled {
                    None
                } else if let Some(channels) = tcs.channels.as_ref() {
                    if let Some(room_id) =
                        channels.channel_for_type(chat_type_enum)
                    {
                        let context_id = tcs.next_context_id;
                        tcs.next_context_id =
                            tcs.next_context_id.wrapping_add(1).max(1);
                        Some((room_id, context_id))
                    } else {
                        None
                    }
                } else {
                    None
                }
            };
            let Some((room_id, context_id)) = resolved else {
                // R-chat chat-1: retail DoTurbineChat_Allegiance with no
                // allegiance room → HandleFailureEvent(0x414
                // YouAreNotInAllegiance) — no legacy fallback while
                // turbine chat is on.
                let allegiance_room_missing = is_allegiance
                    && turbine_chat_state
                        .borrow()
                        .channels
                        .as_ref()
                        .map(|c| c.allegiance.is_none())
                        .unwrap_or(false);
                let text = if allegiance_room_missing {
                    "You are not in an allegiance!".to_string()
                } else {
                    format!(
                        "send_turbine_channel: channel {chat_type_enum:?} not advertised (turbine chat may be disabled or not yet bootstrapped)"
                    )
                };
                queued_events.borrow_mut().push(ClientEvent {
                    kind: CLIENT_EVENT_KIND_CHAT_RECEIVED,
                    string_payload: Some(text),
                    u32_payload: None,
                    u32_payload_2: None,
                    f32_payload: None,
                });
                return LoopFlow::Continue;
            };
            // Player guid from the LoopState — we're only
            // dispatching this command after InWorld in
            // the JS-side router, but defend anyway.
            let sender_id = if let LoopState::InWorld { player_guid } = &state {
                u32::from(*player_guid)
            } else {
                queued_events.borrow_mut().push(ClientEvent {
                    kind: CLIENT_EVENT_KIND_CHAT_RECEIVED,
                    string_payload: Some(
                        "send_turbine_channel: not in world yet".to_string(),
                    ),
                    u32_payload: None,
                    u32_payload_2: None,
                    f32_payload: None,
                });
                return LoopFlow::Continue;
            };
            let tc_msg = TurbineChatMessageData {
                blob_type: TurbineChatBlobType::RequestBinary,
                dispatch_type: TurbineChatDispatchType::SendToRoomById,
                target_type: 1,
                target_id: 0,
                transport_type: 0,
                transport_id: 0,
                cookie: 0,
                payload: TurbineChatPayload::RequestSendToRoomById {
                    context_id,
                    room_id,
                    message,
                    extra_data_size: 0x0C,
                    sender_id,
                    hresult: 0,
                    chat_type: TurbineChatTypeId::Known(chat_type_enum),
                },
            };
            send_or_disconnect!(
                queued_events,
                e,
                session
                    .send_message(&GameMessage::TurbineChat(Box::new(tc_msg)))
                    .await,
                "recv_loop: send_message(TurbineChat): {e}",
                "send_turbine_channel: {e}",
                LoopFlow::Exit
            );
        }
        SessionCommand::FellowshipCreate { name, share_xp } => {
            use holtburger_protocol::messages::{
                FellowshipCreateActionData, GameAction,
            };
            let log_name = name.clone();
            let action = GameAction::FellowshipCreate(Box::new(
                FellowshipCreateActionData { name, share_xp },
            ));
            send_or_disconnect!(
                queued_events,
                e,
                send_ordered!(movement, session, action),
                "recv_loop: send_action(FellowshipCreate): {e}",
                "fellowship_create: {e}",
                LoopFlow::Exit
            );
            console_log_str(&format!(
                "[fellowship/create] name={log_name:?} share_xp={share_xp}",
            ));
        }
        SessionCommand::FellowshipQuit { disband } => {
            use holtburger_protocol::messages::{
                FellowshipQuitActionData, GameAction,
            };
            let action = GameAction::FellowshipQuit(Box::new(
                FellowshipQuitActionData { disband },
            ));
            send_or_disconnect!(
                queued_events,
                e,
                send_ordered!(movement, session, action),
                "recv_loop: send_action(FellowshipQuit): {e}",
                "fellowship_quit: {e}",
                LoopFlow::Exit
            );
            console_log_str(&format!(
                "[fellowship/quit] disband={disband}",
            ));
        }
        SessionCommand::FellowshipDismiss { member_guid } => {
            use holtburger_common::Guid;
            use holtburger_protocol::messages::{
                FellowshipDismissActionData, GameAction,
            };
            let action = GameAction::FellowshipDismiss(Box::new(
                FellowshipDismissActionData {
                    player_guid: Guid(member_guid),
                },
            ));
            send_or_disconnect!(
                queued_events,
                e,
                send_ordered!(movement, session, action),
                "recv_loop: send_action(FellowshipDismiss): {e}",
                "fellowship_dismiss: {e}",
                LoopFlow::Exit
            );
            console_log_str(&format!(
                "[fellowship/dismiss] member=0x{member_guid:08X}",
            ));
        }
        SessionCommand::FellowshipRecruit { target_guid } => {
            use holtburger_common::Guid;
            use holtburger_protocol::messages::{
                FellowshipRecruitActionData, GameAction,
            };
            let action = GameAction::FellowshipRecruit(Box::new(
                FellowshipRecruitActionData {
                    player_guid: Guid(target_guid),
                },
            ));
            send_or_disconnect!(
                queued_events,
                e,
                send_ordered!(movement, session, action),
                "recv_loop: send_action(FellowshipRecruit): {e}",
                "fellowship_recruit: {e}",
                LoopFlow::Exit
            );
            console_log_str(&format!(
                "[fellowship/recruit] target=0x{target_guid:08X}",
            ));
        }
        SessionCommand::FellowshipUpdateRequest { want_updates } => {
            use holtburger_protocol::messages::{
                FellowshipUpdateRequestActionData, GameAction,
            };
            let action = GameAction::FellowshipUpdateRequest(Box::new(
                FellowshipUpdateRequestActionData {
                    panel_open: want_updates,
                },
            ));
            send_or_disconnect!(
                queued_events,
                e,
                send_ordered!(movement, session, action),
                "recv_loop: send_action(FellowshipUpdateRequest): {e}",
                "fellowship_update_request: {e}",
                LoopFlow::Exit
            );
            console_log_str(&format!(
                "[fellowship/update-request] want_updates={want_updates}",
            ));
        }
        SessionCommand::FellowshipAssignNewLeader {
            new_leader_guid,
        } => {
            use holtburger_common::Guid;
            use holtburger_protocol::messages::{
                FellowshipAssignNewLeaderActionData, GameAction,
            };
            let action = GameAction::FellowshipAssignNewLeader(Box::new(
                FellowshipAssignNewLeaderActionData {
                    new_leader_guid: Guid(new_leader_guid),
                },
            ));
            send_or_disconnect!(
                queued_events,
                e,
                send_ordered!(movement, session, action),
                "recv_loop: send_action(FellowshipAssignNewLeader): {e}",
                "fellowship_assign_new_leader: {e}",
                LoopFlow::Exit
            );
            console_log_str(&format!(
                "[fellowship/assign-leader] new_leader=0x{new_leader_guid:08X}",
            ));
        }
        SessionCommand::FellowshipChangeOpenness { open } => {
            // Retail gmFellowshipUI Open button →
            // `CM_Fellowship::Event_ChangeFellowOpeness` (0x0291,
            // u32 open). ACE `HandleActionFellowshipChangeOpenness`
            // is leader-only, refuses a locked fellowship, and on
            // success sends every member a FullUpdate.
            use holtburger_protocol::messages::{
                FellowshipChangeOpennessActionData, GameAction,
            };
            let action = GameAction::FellowshipChangeOpenness(Box::new(
                FellowshipChangeOpennessActionData { open },
            ));
            send_or_disconnect!(
                queued_events,
                e,
                send_ordered!(movement, session, action),
                "recv_loop: send_action(FellowshipChangeOpenness): {e}",
                "fellowship_change_openness: {e}",
                LoopFlow::Exit
            );
            console_log_str(&format!("[fellowship/openness] open={open}"));
        }
        SessionCommand::SwearAllegiance { target_guid } => {
            use holtburger_common::Guid;
            use holtburger_protocol::messages::{
                GameAction, SwearAllegianceActionData,
            };
            let action = GameAction::SwearAllegiance(Box::new(
                SwearAllegianceActionData {
                    target_guid: Guid(target_guid),
                },
            ));
            send_or_disconnect!(
                queued_events,
                e,
                send_ordered!(movement, session, action),
                "recv_loop: send_action(SwearAllegiance): {e}",
                "swear_allegiance: {e}",
                LoopFlow::Exit
            );
            console_log_str(&format!(
                "[allegiance/swear] target=0x{target_guid:08X}",
            ));
        }
        SessionCommand::ConfirmationResponse {
            confirmation_type,
            context,
            accepted,
        } => {
            use holtburger_common::ConfirmationType;
            use holtburger_protocol::messages::{
                ConfirmationResponseActionData, GameAction,
            };
            match ConfirmationType::from_repr(confirmation_type) {
                None => log::warn!(
                    "recv_loop: ConfirmationResponse: unknown confirmation_type {confirmation_type}"
                ),
                Some(ctype) => {
                    let action = GameAction::ConfirmationResponse(Box::new(
                        ConfirmationResponseActionData {
                            confirmation_type: ctype,
                            context,
                            accepted,
                        },
                    ));
                    send_or_disconnect!(
                        queued_events,
                        e,
                        send_ordered!(movement, session, action),
                        "recv_loop: send_action(ConfirmationResponse): {e}",
                        "confirmation_response: {e}",
                        LoopFlow::Exit
                    );
                    console_log_str(&format!(
                        "[confirm/respond] type={confirmation_type} ctx={context} accepted={accepted}"
                    ));
                }
            }
        }
        SessionCommand::BreakAllegiance { target_guid } => {
            use holtburger_common::Guid;
            use holtburger_protocol::messages::{
                BreakAllegianceActionData, GameAction,
            };
            let action = GameAction::BreakAllegiance(Box::new(
                BreakAllegianceActionData {
                    target_guid: Guid(target_guid),
                },
            ));
            send_or_disconnect!(
                queued_events,
                e,
                send_ordered!(movement, session, action),
                "recv_loop: send_action(BreakAllegiance): {e}",
                "break_allegiance: {e}",
                LoopFlow::Exit
            );
            console_log_str(&format!(
                "[allegiance/break] target=0x{target_guid:08X}",
            ));
        }
        SessionCommand::AddFriend { friend_name } => {
            use holtburger_protocol::messages::{
                AddFriendActionData, GameAction,
            };
            let name_for_log = friend_name.clone();
            let action = GameAction::AddFriend(Box::new(AddFriendActionData {
                friend_name,
            }));
            send_or_disconnect!(
                queued_events,
                e,
                send_ordered!(movement, session, action),
                "recv_loop: send_action(AddFriend): {e}",
                "add_friend: {e}",
                LoopFlow::Exit
            );
            console_log_str(&format!("[friends/add] name={name_for_log}"));
        }
        SessionCommand::RemoveFriend { friend_guid } => {
            use holtburger_common::Guid;
            use holtburger_protocol::messages::{
                GameAction, RemoveFriendActionData,
            };
            let action = GameAction::RemoveFriend(Box::new(
                RemoveFriendActionData {
                    friend_guid: Guid(friend_guid),
                },
            ));
            send_or_disconnect!(
                queued_events,
                e,
                send_ordered!(movement, session, action),
                "recv_loop: send_action(RemoveFriend): {e}",
                "remove_friend: {e}",
                LoopFlow::Exit
            );
            console_log_str(&format!(
                "[friends/remove] target=0x{friend_guid:08X}",
            ));
        }
        SessionCommand::ClearFriends => {
            // social-lists-1 (2026-10-08, round 4): retail
            // `/friends remove -all` → CM_Social::Event_ClearFriends
            // (0x0025). ACE (HandleActionRemoveAllFriends) clears the
            // DB and pushes nothing, so flush the local list like retail
            // gmFriendsUI::RecvNotice_ChatCommand_RemoveAllFriends and
            // raise friendsUpdated.
            use holtburger_protocol::messages::{
                GameAction, RemoveAllFriendsActionData,
            };
            let action = GameAction::RemoveAllFriends(Box::new(RemoveAllFriendsActionData {}));
            send_or_disconnect!(
                queued_events,
                e,
                send_ordered!(movement, session, action),
                "recv_loop: send_action(RemoveAllFriends): {e}",
                "clear_friends: {e}",
                LoopFlow::Exit
            );
            *latest_friends.borrow_mut() = Some(FriendsSnapshot { friends: Vec::new() });
            queued_events.borrow_mut().push(ClientEvent {
                kind: CLIENT_EVENT_KIND_FRIENDS_UPDATED,
                string_payload: None,
                u32_payload: None,
                u32_payload_2: None,
                f32_payload: None,
            });
            console_log_str("[friends/clear]");
        }
        SessionCommand::ModifyCharacterSquelch {
            target_guid,
            target_name,
            add,
            message_type,
        } => {
            use holtburger_common::Guid;
            use holtburger_protocol::messages::{
                GameAction, ModifyCharacterSquelchActionData,
            };
            let action = GameAction::ModifyCharacterSquelch(Box::new(
                ModifyCharacterSquelchActionData {
                    add,
                    target_guid: Guid(target_guid),
                    target_name,
                    message_type,
                },
            ));
            send_or_disconnect!(
                queued_events,
                e,
                send_ordered!(movement, session, action),
                "recv_loop: send_action(ModifyCharacterSquelch): {e}",
                "modify_character_squelch: {e}",
                LoopFlow::Exit
            );
            console_log_str(&format!(
                "[squelch/character] target=0x{target_guid:08X} add={add} mask=0x{message_type:08X}",
            ));
        }
        SessionCommand::ModifyAccountSquelch {
            account_name,
            add,
            message_type,
        } => {
            use holtburger_protocol::messages::{
                GameAction, ModifyAccountSquelchActionData,
            };
            let name_for_log = account_name.clone();
            let action = GameAction::ModifyAccountSquelch(Box::new(
                ModifyAccountSquelchActionData { add, account_name },
            ));
            send_or_disconnect!(
                queued_events,
                e,
                send_ordered!(movement, session, action),
                "recv_loop: send_action(ModifyAccountSquelch): {e}",
                "modify_account_squelch: {e}",
                LoopFlow::Exit
            );
            // `message_type` is logged but not on the wire; ACE
            // wire is (bool, name) only for this opcode.
            console_log_str(&format!(
                "[squelch/account] name={name_for_log} add={add} mask=0x{message_type:08X}",
            ));
        }
        SessionCommand::ModifyGlobalSquelch { add, message_type } => {
            use holtburger_protocol::messages::{
                GameAction, ModifyGlobalSquelchActionData,
            };
            let action = GameAction::ModifyGlobalSquelch(Box::new(
                ModifyGlobalSquelchActionData { add, message_type },
            ));
            send_or_disconnect!(
                queued_events,
                e,
                send_ordered!(movement, session, action),
                "recv_loop: send_action(ModifyGlobalSquelch): {e}",
                "modify_global_squelch: {e}",
                LoopFlow::Exit
            );
            console_log_str(&format!(
                "[squelch/global] add={add} mask=0x{message_type:08X}",
            ));
        }
        SessionCommand::SetAllegianceName { new_name } => {
            use holtburger_protocol::messages::{
                GameAction, SetAllegianceNameActionData,
            };
            let name_for_log = new_name.clone();
            let action = GameAction::SetAllegianceName(Box::new(
                SetAllegianceNameActionData { new_name },
            ));
            send_or_disconnect!(
                queued_events,
                e,
                send_ordered!(movement, session, action),
                "recv_loop: send_action(SetAllegianceName): {e}",
                "set_allegiance_name: {e}",
                LoopFlow::Exit
            );
            console_log_str(&format!(
                "[allegiance/set-name] name=\"{name_for_log}\"",
            ));
        }
        SessionCommand::SetAllegianceOfficer {
            target_name,
            officer_level,
        } => {
            use holtburger_protocol::messages::{
                GameAction, SetAllegianceOfficerActionData,
            };
            let name_for_log = target_name.clone();
            let action = GameAction::SetAllegianceOfficer(Box::new(
                SetAllegianceOfficerActionData {
                    target_name,
                    officer_level,
                },
            ));
            send_or_disconnect!(
                queued_events,
                e,
                send_ordered!(movement, session, action),
                "recv_loop: send_action(SetAllegianceOfficer): {e}",
                "set_allegiance_officer: {e}",
                LoopFlow::Exit
            );
            console_log_str(&format!(
                "[allegiance/officer] target=\"{name_for_log}\" level={officer_level}",
            ));
        }
        SessionCommand::AllegianceChatGag {
            target_name,
            gag_on,
        } => {
            use holtburger_protocol::messages::{
                AllegianceChatGagActionData, GameAction,
            };
            let name_for_log = target_name.clone();
            let action = GameAction::AllegianceChatGag(Box::new(
                AllegianceChatGagActionData {
                    target_name,
                    gag_on,
                },
            ));
            send_or_disconnect!(
                queued_events,
                e,
                send_ordered!(movement, session, action),
                "recv_loop: send_action(AllegianceChatGag): {e}",
                "allegiance_chat_gag: {e}",
                LoopFlow::Exit
            );
            console_log_str(&format!(
                "[allegiance/chat-gag] target=\"{name_for_log}\" gag={gag_on}",
            ));
        }
        SessionCommand::AddAllegianceBan { target_name } => {
            use holtburger_protocol::messages::{
                AddAllegianceBanActionData, GameAction,
            };
            let name_for_log = target_name.clone();
            let action = GameAction::AddAllegianceBan(Box::new(
                AddAllegianceBanActionData { target_name },
            ));
            send_or_disconnect!(
                queued_events,
                e,
                send_ordered!(movement, session, action),
                "recv_loop: send_action(AddAllegianceBan): {e}",
                "add_allegiance_ban: {e}",
                LoopFlow::Exit
            );
            console_log_str(&format!(
                "[allegiance/add-ban] target=\"{name_for_log}\"",
            ));
        }
        SessionCommand::RemoveAllegianceBan { target_name } => {
            use holtburger_protocol::messages::{
                GameAction, RemoveAllegianceBanActionData,
            };
            let name_for_log = target_name.clone();
            let action = GameAction::RemoveAllegianceBan(Box::new(
                RemoveAllegianceBanActionData { target_name },
            ));
            send_or_disconnect!(
                queued_events,
                e,
                send_ordered!(movement, session, action),
                "recv_loop: send_action(RemoveAllegianceBan): {e}",
                "remove_allegiance_ban: {e}",
                LoopFlow::Exit
            );
            console_log_str(&format!(
                "[allegiance/remove-ban] target=\"{name_for_log}\"",
            ));
        }
        SessionCommand::BreakAllegianceBoot {
            target_name,
            account_boot,
        } => {
            use holtburger_protocol::messages::{
                BreakAllegianceBootActionData, GameAction,
            };
            let name_for_log = target_name.clone();
            let action = GameAction::BreakAllegianceBoot(Box::new(
                BreakAllegianceBootActionData {
                    target_name,
                    account_boot,
                },
            ));
            send_or_disconnect!(
                queued_events,
                e,
                send_ordered!(movement, session, action),
                "recv_loop: send_action(BreakAllegianceBoot): {e}",
                "break_allegiance_boot: {e}",
                LoopFlow::Exit
            );
            console_log_str(&format!(
                "[allegiance/boot] target=\"{name_for_log}\" account_boot={account_boot}",
            ));
        }
        SessionCommand::DoAllegianceLockAction { lock_action } => {
            use holtburger_protocol::messages::{
                DoAllegianceLockActionActionData, GameAction,
            };
            let action = GameAction::DoAllegianceLockAction(Box::new(
                DoAllegianceLockActionActionData { lock_action },
            ));
            send_or_disconnect!(
                queued_events,
                e,
                send_ordered!(movement, session, action),
                "recv_loop: send_action(DoAllegianceLockAction): {e}",
                "do_allegiance_lock_action: {e}",
                LoopFlow::Exit
            );
            console_log_str(&format!("[allegiance/lock] action={lock_action}"));
        }
        SessionCommand::AllegianceInfoRequest { target_name } => {
            // Wave F.3 follow-on (2026-05-27):
            // AllegianceInfoRequest (0x027B). ACE:
            // `Player.HandleActionAllegianceInfoRequest` →
            // permission-checks ≥ Seneschal, looks up the
            // player by name, enqueues an
            // `AllegianceInfoResponse` (0x027C) which the
            // recv-loop caches in `latest_allegiance_info`
            // (kind 41) — not `latest_allegiance`.
            use holtburger_protocol::messages::{
                AllegianceInfoRequestActionData, GameAction,
            };
            let action = GameAction::AllegianceInfoRequest(Box::new(
                AllegianceInfoRequestActionData {
                    target_name: target_name.clone(),
                },
            ));
            send_or_disconnect!(
                queued_events,
                e,
                send_ordered!(movement, session, action),
                "recv_loop: send_action(AllegianceInfoRequest): {e}",
                "allegiance_info_request: {e}",
                LoopFlow::Exit
            );
            console_log_str(&format!(
                "[allegiance/info-request] target={target_name:?}",
            ));
        }
        SessionCommand::AllegianceUpdateRequest { on } => {
            // Retail `CM_Allegiance::Event_UpdateRequest`
            // (0x001F, u32 on): sent on PlayerDescription
            // receipt and on allegiance-panel show/hide. ACE
            // `GameActionAllegianceUpdateRequest` replies with
            // `AllegianceUpdate` + `AllegianceUpdateDone`.
            use holtburger_protocol::messages::{
                AllegianceUpdateRequestActionData, GameAction,
            };
            let action = GameAction::AllegianceUpdateRequest(Box::new(
                AllegianceUpdateRequestActionData { on },
            ));
            send_or_disconnect!(
                queued_events,
                e,
                send_ordered!(movement, session, action),
                "recv_loop: send_action(AllegianceUpdateRequest): {e}",
                "allegiance_update_request: {e}",
                LoopFlow::Exit
            );
            console_log_str(&format!("[allegiance/update-request] on={on}"));
        }
        _ => unreachable!("SessionCommand routed to the wrong handler module"),
    }
    LoopFlow::Continue
}
