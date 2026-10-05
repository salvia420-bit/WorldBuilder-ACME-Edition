//! `GameMessage` arms: Login and server identity: character list, create/enter-
//! world responses, the local PlayerCreate, server name, localization
//! interrogation, character errors.
//!
//! Moved verbatim from the inbound `match message` (2026-10-05 recv_loop
//! split); see `session::messages::dispatch_game_message` for the routing.

use crate::*;
use crate::session::{LoopCtx, LoopFlags, LoopFlow};
use holtburger_protocol::messages::{CharacterEnterWorldData, CharacterGenerationVerificationResponse, GameAction, GameMessage};

pub(super) async fn handle(ctx: &mut LoopCtx, message: GameMessage) -> LoopFlow {
    let LoopFlags {
        remote_interp_on,
        remote_root_motion_on,
        remote_jump_arc_on,
        remote_moveto_on,
        remote_sticky_on,
        combat_radii_on,
        server_run_rate_on,
        retail_leash_on,
        leash_echo_gate_on,
        ..
    } = ctx.flags;
    let LoopCtx {
        session,
        queued_events,
        character_list,
        charlist_tx,
        world_bootstrap,
        latest_server_info,
        latest_localization,
        turbine_chat_state,
        world,
        state,
        account_name,
        local_player_kind1_emitted,
        cached_player_description,
        cached_time_sync,
        ..
    } = &mut *ctx;
    match message {
        GameMessage::CharacterList(data) => {
            *account_name = data.account_name.clone();
            let new_list: Vec<CharacterSummary> = data
                .characters
                .iter()
                .map(|entry| CharacterSummary {
                    id: u32::from(entry.guid),
                    name: entry.name.clone(),
                    delete_time: entry.delete_time,
                })
                .collect();
            let count = new_list.len() as u32;
            *character_list.borrow_mut() = new_list;
            // TurbineChat: server advertises Turbine-style
            // chat capability in this packet. When
            // disabled, also clear any stale channel list
            // from a prior session.
            {
                let mut tcs = turbine_chat_state.borrow_mut();
                tcs.enabled = data.use_turbine_chat;
                if !data.use_turbine_chat {
                    tcs.channels = None;
                }
            }
            if let Some(tx) = charlist_tx.take() {
                let _ = tx.send(CharListReady {
                    account_name: account_name.clone(),
                });
            } else {
                // Re-fire after CharacterCreate /
                // CharacterDelete: surface as a kind=0
                // event so JS can call
                // `handle.characterList()` for the
                // updated snapshot.
                queued_events.borrow_mut().push(ClientEvent {
                    kind: CLIENT_EVENT_KIND_CHARACTER_LIST_RECEIVED,
                    string_payload: Some(account_name.clone()),
                    u32_payload: Some(count),
                    u32_payload_2: None,
                    f32_payload: None,
                });
            }
        }
        GameMessage::CharacterCreateResponse(data) => {
            // Phase 4 step 2a.5: surface the response
            // to JS, and on success append the new
            // character to `character_list` locally.
            // ACE does NOT auto-send a CharacterList
            // re-fire after CharacterCreate — the cli
            // (apps/holtburger-cli/src/pages/selection
            // /state.rs::handle_create_response, line
            // 307) pushes a CharacterEntry locally;
            // we mirror that here so JS sees the new
            // entry on the next handle.characterList()
            // call.
            if data.response == CharacterGenerationVerificationResponse::Ok {
                let guid = data.guid.map(u32::from).unwrap_or(0);
                let name = data.name.clone().unwrap_or_default();
                if guid != 0 {
                    character_list.borrow_mut().push(CharacterSummary {
                        id: guid,
                        name: name.clone(),
                        delete_time: 0,
                    });
                }
                queued_events.borrow_mut().push(ClientEvent {
                    kind: CLIENT_EVENT_KIND_CHARACTER_CREATED,
                    string_payload: Some(name),
                    u32_payload: Some(guid),
                    u32_payload_2: None,
                    f32_payload: None,
                });
            } else {
                let code = data.response as u32;
                let label = format!("{:?}", data.response);
                queued_events.borrow_mut().push(ClientEvent {
                    kind: CLIENT_EVENT_KIND_CHARACTER_CREATE_FAILED,
                    string_payload: Some(label),
                    u32_payload: Some(code),
                    u32_payload_2: None,
                    f32_payload: None,
                });
            }
        }
        GameMessage::CharacterEnterWorldServerReady => {
            // Server is acknowledging our CharacterEnterWorldRequest;
            // chain the CharacterEnterWorld reply automatically so
            // JS doesn't have to round-trip through poll_events to
            // drive each step of the spawn handshake.
            if let LoopState::EnteringWorld { guid, account } = &state {
                let msg = GameMessage::CharacterEnterWorld(Box::new(
                    CharacterEnterWorldData {
                        guid: *guid,
                        account: account.clone(),
                    },
                ));
                send_or_disconnect!(
                    queued_events,
                    e,
                    session.send_message(&msg).await,
                    "recv_loop: send CharacterEnterWorld: {e}",
                    "CharacterEnterWorld: {e}",
                    LoopFlow::Exit
                );
            }
        }
        GameMessage::PlayerCreate(data) => {
            // Phase 4 step 2a/2a.6: PlayerCreate is the
            // server's "you're in the world" signal.
            // Mirrors the cli's
            // `crates/holtburger-core/src/client/messages.rs:433-466`
            // path: queue PlayerSpawned for JS, send
            // LoginComplete back to the server (ACE
            // expects this acknowledgement before
            // accepting in-world commands like @telepoi),
            // then transition to InWorld + queue
            // EnteredWorld so JS unhides the Teleport
            // button.
            //
            // The earlier "wait for GameEvent::
            // PlayerDescription / StartGame" gate was
            // wrong — empirically ACE sends a flurry of
            // ObjectCreate / ServerName / etc. and never
            // a parseable GameEvent for our flow, but
            // PlayerCreate ALWAYS arrives, and the cli's
            // path through line 464 makes it the
            // canonical InWorld trigger anyway.
            let player_guid_raw = u32::from(data.guid);
            // Workstream A: idempotent — the SelectCharacter
            // eager-construct path (~line 11270) already
            // emitted kind=1 PlayerSpawned with this same
            // guid; suppress the duplicate so JS doesn't
            // re-run `setLocalPlayerGuid` + status-line
            // flash on a no-op event. The flag is set in
            // whichever arm fires first; the other arm
            // sees it set and skips.
            if !*local_player_kind1_emitted {
                queued_events.borrow_mut().push(ClientEvent {
                    kind: CLIENT_EVENT_KIND_PLAYER_SPAWNED,
                    string_payload: None,
                    u32_payload: Some(player_guid_raw),
                    u32_payload_2: None,
                    f32_payload: None,
                });
                *local_player_kind1_emitted = true;
            }

            let login_complete = GameAction::LoginComplete(Box::new(
                holtburger_protocol::messages::LoginCompleteActionData,
            ));
            send_or_disconnect!(
                queued_events,
                e,
                session.send_action(login_complete).await,
                "recv_loop: send LoginComplete: {e}",
                "LoginComplete: {e}",
                LoopFlow::Exit
            );

            *state = LoopState::InWorld {
                player_guid: data.guid,
            };
            queued_events.borrow_mut().push(ClientEvent {
                kind: CLIENT_EVENT_KIND_ENTERED_WORLD,
                string_payload: None,
                u32_payload: Some(player_guid_raw),
                u32_payload_2: None,
                f32_payload: None,
            });

            // Phase 4 step 3.6: construct the
            // `WorldState` the `MovementSystemHandle`
            // will tick against. Bootstrap was loaded
            // in parallel by start_session; if it isn't
            // ready yet (rare under normal flow), the
            // movement system stays disabled until the
            // next session — log a warning and continue
            // (wire-data EntityUpdate arms keep
            // entities rendering).
            // Phase 4 step 4 follow-on: WorldState is
            // typically constructed eagerly at
            // SelectCharacter time (so PlayerDescription
            // arrivals BEFORE PlayerCreate land on a
            // ready dispatcher). If that didn't happen
            // — bootstrap wasn't loaded yet, or
            // SelectCharacter took a different path —
            // construct here as a fallback.
            // Option C: edition-2024 temp-scoping is load-bearing
            // here — the `world.borrow()` condition temp drops
            // BEFORE this block runs, so the body's
            // `*world.borrow_mut() = Some(new_world)` below does not
            // double-borrow. Under edition 2021 this would panic
            // `already borrowed`.
            if world.borrow().is_none()
                && let Some(bootstrap) = world_bootstrap.borrow().clone()
            {
                let mut new_world =
                    holtburger_world::WorldState::new(bootstrap);
                new_world.player.guid = data.guid;
                let fallback_caps =
                    fallback_self_movement_capabilities();
                new_world.set_self_movement_capabilities_override(
                    fallback_caps.clone(),
                );
                // A2-P2: arm the remote driver once at
                // world creation (composite flag).
                new_world.set_remote_interp_enabled(remote_interp_on);
                // A2-P3 R2: arm remote sticky on top
                // (stickyRetail × remoteInterp ×
                // USE_STICKY_MANAGER compose rule).
                new_world.set_remote_sticky_enabled(remote_sticky_on);
                new_world.scene.set_remote_root_motion_enabled(remote_root_motion_on);
                new_world.scene.set_remote_jump_arc_enabled(remote_jump_arc_on);
                new_world.scene.set_remote_moveto_enabled(remote_moveto_on);
                // COMBAT-RADII (2026-07-28): size-aware
                // standoffs (?combatRadii, default ON).
                new_world.set_combat_radii_enabled(combat_radii_on);
                // MOVE-RUNRATE-105 (2026-08-11): prefer the
                // server's my_run_rate (?serverRunRate, ON).
                new_world.set_server_run_rate_enabled(server_run_rate_on);
                // Physics-parity 2026-07-03: retail
                // LOCAL lattice (?retailLeash=on).
                new_world.set_local_retail_leash(retail_leash_on);
                // Bug-A (2026-07-03): ?leashEchoGate=on.
                new_world.set_leash_echo_gate(leash_echo_gate_on);
                // P4.2 TIMESYNC: seed the server clock before
                // the world goes live so no lifecycle stamp
                // (prune deadlines etc.) is ever taken in the
                // Unix wall-clock fallback domain and later
                // compared in the PortalYearTicks domain.
                if let Some((t, at)) = *cached_time_sync {
                    let _ = new_world.set_server_time_sync(t, at);
                }
                *world.borrow_mut() = Some(new_world);
                console_log_str(&format!(
                    "[step 3.6] WorldState constructed lazily on PlayerCreate (guid=0x{:08X}) — eager-construct path missed",
                    player_guid_raw,
                ));
                // Run-skill plumbing backstop (2026-06-02):
                // this lazy-construct path means the
                // bootstrap wasn't ready at SelectCharacter,
                // so PlayerDescription (which arrives BEFORE
                // PlayerCreate) was dropped by the top-of-loop
                // `world == None` gate. Replay the cached
                // PlayerDescription now so `player.skills`
                // (incl. Run) and attributes/vitals hydrate
                // and `resolve_self_movement_capabilities`
                // can derive the real, skill-accurate run
                // rate instead of the 4.5 fallback.
                if let (Some(cached), Some(w)) =
                    (cached_player_description.as_ref(), world.borrow_mut().as_mut())
                {
                    let mut replay_events: Vec<
                        holtburger_world::WorldEvent,
                    > = Vec::new();
                    holtburger_world::handlers::routing::handle_message(
                        w,
                        cached,
                        &mut replay_events,
                    );
                    w.clear_self_movement_capabilities_override();
                    let real_caps_ok = w
                        .resolve_self_movement_capabilities()
                        .is_ok();
                    console_log_str(&format!(
                        "[run-plumb] replayed cached PlayerDescription into late-built world (PlayerCreate); skills={} real_caps_ok={}",
                        w.player.skills.len(),
                        real_caps_ok,
                    ));
                    if !real_caps_ok {
                        w.set_self_movement_capabilities_override(
                            fallback_caps,
                        );
                    }
                }
            } else if world.borrow().is_some() {
                console_log_str(&format!(
                    "[step 3.6] WorldState already constructed (eager path); PlayerCreate guid=0x{:08X} confirms",
                    player_guid_raw,
                ));
            } else {
                console_log_str(
                    "[step 3.6] WorldBootstrap not yet loaded at PlayerCreate; \
                     MovementSystem disabled this session",
                );
            }
        }
        GameMessage::ServerName(data) => {
            // HUD rec #83 (2026-06-16): ACE pushes the
            // world identity + connection counts as part
            // of the post-login handshake. Stash the
            // snapshot + signal JS with kind=57 so the
            // post-login status line can render
            // "Server: <name> | Players: X/Max".
            let snapshot = ServerInfoJs {
                name: data.name.clone(),
                current_connections: data.current_connections,
                max_connections: data.max_connections,
            };
            *latest_server_info.borrow_mut() = Some(snapshot);
            queued_events.borrow_mut().push(ClientEvent {
                kind: CLIENT_EVENT_KIND_SERVER_INFO,
                string_payload: Some(data.name.clone()),
                u32_payload: Some(data.current_connections),
                u32_payload_2: Some(data.max_connections as u32),
                f32_payload: None,
            });
        }
        GameMessage::DddInterrogation(data) => {
            // HUD rec #68 (2026-06-16): ACE sends the server's
            // language context (name_rule_language +
            // servers_region + supported_languages) during the
            // DDD handshake, before CharacterList. Stash it +
            // signal JS with kind=59 so window.__acLocalization
            // is seeded before string-table preloads run.
            //
            // NOTE: we deliberately do NOT send
            // DddInterrogationResponse here. The web login
            // handshake already completes without it (ACE does
            // not block on the DDD response in this flow — this
            // arm was previously the `_ => {}` fallthrough and
            // login worked); the native core Client models the
            // echo at holtburger-core messages.rs. Adding an
            // unvalidated wire send to the working login
            // handshake is out of scope per [Keep ACE vanilla]
            // + can't-validate-without-1070.
            let snapshot = LocalizationJs {
                lang_id: data.name_rule_language,
                servers_region: data.servers_region,
                product_id: data.product_id,
                supported_languages: data.supported_languages.clone(),
            };
            *latest_localization.borrow_mut() = Some(snapshot);
            queued_events.borrow_mut().push(ClientEvent {
                kind: CLIENT_EVENT_KIND_LOCALIZATION,
                string_payload: None,
                u32_payload: Some(data.name_rule_language),
                u32_payload_2: Some(data.servers_region),
                f32_payload: None,
            });
        }
        GameMessage::CharacterError(data) => {
            // 2026-05-21 — surface to JS so the autoLogin
            // orchestrator can detect "account in use"
            // (CharacterError::Logon) or "character
            // in-world" (EnterGameCharacterInWorld) and
            // trigger the kick-then-reconnect retry
            // path. See CLIENT_EVENT_KIND_CHARACTER_ERROR
            // doc comment for the wire-side context.
            let raw = data.error_id;
            let name = holtburger_protocol::errors::CharacterError::from_repr(raw)
                .map(|e| format!("{:?}", e))
                .unwrap_or_else(|| format!("Unknown({:#x})", raw));
            log::warn!("[character-error] code={:#x} name={}", raw, name);
            queued_events.borrow_mut().push(ClientEvent {
                kind: CLIENT_EVENT_KIND_CHARACTER_ERROR,
                string_payload: Some(name),
                u32_payload: Some(raw),
                u32_payload_2: None,
                f32_payload: None,
            });
        }
        _ => unreachable!("GameMessage routed to the wrong handler module"),
    }
    LoopFlow::Continue
}
