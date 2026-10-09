//! `SessionCommand` arms: Session lifecycle: the forced keepalive ping and the
//! character-select screen (enter world, create, delete, restore).
//!
//! Moved verbatim from the `recv_loop` command `select!` arm (2026-10-05
//! split); see `session::commands::handle_command` for the routing.

use crate::*;
use crate::session::{LoopCtx, LoopFlags, LoopFlow};
use holtburger_protocol::messages::GameMessage;

pub(super) async fn handle(ctx: &mut LoopCtx, cmd: SessionCommand) -> LoopFlow {
    let LoopFlags {
        remote_interp_on,
        remote_root_motion_on,
        remote_jump_arc_on,
        remote_moveto_on,
        remote_motion_keep_on,
        remote_turn_on,
        remote_sticky_on,
        combat_radii_on,
        server_run_rate_on,
        retail_leash_on,
        leash_echo_gate_on,
        lifecycle_stamp_gates_on,
        object_blob_queue_on,
        open_sea_wall_on,
        fallback_water_retail_on,
        ..
    } = ctx.flags;
    let LoopCtx {
        session,
        queued_events,
        world_bootstrap,
        world,
        state,
        account_name,
        local_player_kind1_emitted,
        cached_player_description,
        cached_time_sync,
        ..
    } = &mut *ctx;
    match cmd {
        SessionCommand::ForceKeepalive => {
            // Robustness mitigation (2026-07-04): forced
            // PingRequest driven by a JS wall-clock
            // setInterval, bypassing the 5s gate above so
            // packets keep flowing when the rAF net pump is
            // paused (tab occluded / main thread saturated).
            // Gated to InWorld OR EnteringWorld (keepaliveFix
            // 2026-07-07 relaxed this from InWorld-only) so the
            // worker heartbeat also keeps packets flowing during
            // long portal/dungeon loads. Pre-login / charlist
            // calls (Idle) remain silent no-ops. A PingRequest
            // sent before the player exists is dropped by ACE's
            // inbound state gate yet still resets the 60s server
            // timeout. Failures are logged, never fatal, so the
            // loop keeps running and JS can observe an eventual
            // real disconnect through `recv_message`.
            if matches!(
                state,
                LoopState::InWorld { .. } | LoopState::EnteringWorld { .. }
            ) {
                use holtburger_protocol::messages::misc::actions::PingRequestActionData;
                use holtburger_protocol::messages::GameAction;
                // Stamp send time so the PingResponse arm can
                // compute RTT (same bookkeeping as the 5s
                // gate above); cleared on send failure.
                PING_SEND_INSTANT.with(|c| {
                    *c.borrow_mut() = Some(web_time::Instant::now());
                });
                if let Err(e) = session
                    .send_action(GameAction::PingRequest(Box::new(
                        PingRequestActionData,
                    )))
                    .await
                {
                    PING_SEND_INSTANT.with(|c| { *c.borrow_mut() = None; });
                    log::warn!(
                        "recv_loop: forced keepalive PingRequest send failed: {e}"
                    );
                }
            }
        }
        SessionCommand::SelectCharacter { guid } => {
            let guid = holtburger_common::Guid::from(guid);
            *state = LoopState::EnteringWorld {
                guid,
                account: account_name.clone(),
            };

            // Phase 4 step 4 follow-on: construct WorldState
            // EAGERLY here, not lazily on PlayerCreate. ACE's
            // spawn flow ships `GameEvent::PlayerDescription`
            // BEFORE `PlayerCreate` (verified in capture
            // logs); deferring construction means the
            // canonical world-handler dispatcher's first
            // call at the top of the recv loop sees
            // `world == None` and silently drops the
            // PlayerDescription, leaving WorldState.player.{
            // vitals,attributes,skills} empty forever.
            // Constructing here (we have the guid + the
            // bootstrap is loaded in parallel by
            // start_session) puts WorldState in place
            // before any spawn-flow message arrives. The
            // PlayerCreate arm later updates seeded entity
            // pose + arms heartbeat — those are step 3.6
            // bookkeeping that don't depend on WorldState
            // having been constructed in PlayerCreate
            // specifically.
            // Option C: edition-2024 temp-scoping is load-bearing here —
            // the `world.borrow()` condition temp drops BEFORE this block
            // runs, so the body's `*world.borrow_mut() = Some(new_world)`
            // below does not double-borrow. Under edition 2021 this would
            // panic `already borrowed`.
            if world.borrow().is_none()
                && let Some(bootstrap) = world_bootstrap.borrow().clone()
            {
                let mut new_world =
                    holtburger_world::WorldState::new(bootstrap);
                new_world.player.guid = guid;
                // Install the same bootstrap-time fallback
                // movement caps as the PlayerCreate arm's
                // step 3.6 logic — so movement still works
                // before PlayerDescription lands and clears
                // them in step 3.7's recv arm. Real biota
                // resolution clears the override.
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
                // NETSYNC-1: remote bodies keep their motion
                // state across position corrections
                // (?remoteMotionKeep, default ON).
                new_world
                    .scene
                    .set_remote_motion_keep_enabled(remote_motion_keep_on);
                // NETSYNC-3: remote bodies turn by their
                // interpreted turn axis (?remoteTurn, default ON).
                new_world.scene.set_remote_turn_enabled(remote_turn_on);
                // COMBAT-RADII (2026-07-28): size-aware
                // standoffs (?combatRadii, default ON).
                new_world.set_combat_radii_enabled(combat_radii_on);
                // MOVE-RUNRATE-105 (2026-08-11): prefer the
                // server's my_run_rate (?serverRunRate, ON).
                new_world.set_server_run_rate_enabled(server_run_rate_on);
                // createobj-5 (2026-10-08 follow-ups): retail
                // SmartBox::Handle* stamp gates (?lifecycleStampGates, ON).
                new_world.set_lifecycle_stamp_gates_enabled(lifecycle_stamp_gates_on);
                // held-3 (2026-10-08 follow-ups): retail QueueBlobForObject
                // for ParentEvent / PickupEvent (?objectBlobQueue, ON).
                new_world.set_object_blob_queue_enabled(object_blob_queue_on);
                // landdefs-terrain-1 / -3 (2026-10-08 follow-ups): retail
                // open-sea wall + heightfield-fallback water model
                // (?openSeaWall / ?fallbackWaterRetail, both ON).
                new_world.scene.set_open_sea_wall_enabled(open_sea_wall_on);
                new_world.set_fallback_water_retail(fallback_water_retail_on);
                // Physics-parity 2026-07-03: retail LOCAL
                // lattice (?retailLeash=on).
                new_world.set_local_retail_leash(retail_leash_on);
                // Bug-A (2026-07-03): ?leashEchoGate=on.
                new_world.set_leash_echo_gate(leash_echo_gate_on);
                // P4.2 TIMESYNC: seed the server clock before the
                // world goes live (symmetric with the
                // PlayerCreate arm above).
                if let Some((t, at)) = *cached_time_sync {
                    let _ = new_world.set_server_time_sync(t, at);
                }
                *world.borrow_mut() = Some(new_world);
                console_log_str(&format!(
                    "[step4-follow-on] WorldState constructed eagerly on SelectCharacter (guid=0x{:08X})",
                    u32::from(guid),
                ));
                // Run-skill plumbing backstop (2026-06-02):
                // symmetric with the PlayerCreate arm. At
                // SelectCharacter (a JS command) the spawn-flow
                // PlayerDescription has usually not arrived yet,
                // so the cache is normally empty and this is a
                // no-op. It only fires on a re-login within the
                // same recv loop where an earlier
                // PlayerDescription is still cached — replaying it
                // hydrates skills/attributes/vitals into the
                // freshly built world and clears the fallback caps
                // when the real biota resolves.
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
                    let real_caps_ok =
                        w.resolve_self_movement_capabilities().is_ok();
                    console_log_str(&format!(
                        "[run-plumb] replayed cached PlayerDescription into eager world (SelectCharacter); skills={} real_caps_ok={}",
                        w.player.skills.len(),
                        real_caps_ok,
                    ));
                    if !real_caps_ok {
                        w.set_self_movement_capabilities_override(
                            fallback_caps,
                        );
                    }
                }
            }

            // Workstream A (3D camera/game-feel fix): emit
            // `ClientEvent::PlayerSpawned` (kind=1) eagerly on
            // SelectCharacter so the JS `drainEvents` handler
            // always sees the guid before the spawn handshake
            // races to PlayerCreate. The wire-level PlayerCreate
            // arm at ~line 9645 mirrors this emission gated by
            // the same `local_player_kind1_emitted` flag so the
            // duplicate gets dropped. KIND_SPAWN (KIND_SPAWN=1)
            // can't fire here because we don't yet have pose —
            // it lands on the first message that carries a pose
            // for the local player (PlayerCreate /
            // PrivateUpdatePosition / UpdatePosition / ObjectCreate).
            if !*local_player_kind1_emitted {
                queued_events.borrow_mut().push(ClientEvent {
                    kind: CLIENT_EVENT_KIND_PLAYER_SPAWNED,
                    string_payload: None,
                    u32_payload: Some(u32::from(guid)),
                    u32_payload_2: None,
                    f32_payload: None,
                });
                *local_player_kind1_emitted = true;
                console_log_str(&format!(
                    "[workstream-A] eagerly emitted kind=1 PlayerSpawned on SelectCharacter (guid=0x{:08X})",
                    u32::from(guid),
                ));
            }

            let msg = GameMessage::CharacterEnterWorldRequest(Box::new(
                holtburger_protocol::messages::CharacterEnterWorldRequestData {
                    guid,
                },
            ));
            send_or_disconnect!(
                queued_events,
                e,
                session.send_message(&msg).await,
                "recv_loop: send CharacterEnterWorldRequest: {e}",
                "CharacterEnterWorldRequest: {e}",
                LoopFlow::Exit
            );
        }
        SessionCommand::CreateCharacter { mut request } => {
            // Stamp the session's account name onto the
            // request just before sending — mirrors the
            // cli's `character_selection.create_character`
            // pattern, so the wasm boundary doesn't need
            // to know about account names.
            request.account_name = account_name.clone();
            let msg = GameMessage::CharacterCreate(request);
            send_or_disconnect!(
                queued_events,
                e,
                session.send_message(&msg).await,
                "recv_loop: send CharacterCreate: {e}",
                "CharacterCreate: {e}",
                LoopFlow::Exit
            );
        }
        SessionCommand::DeleteCharacter { character_slot } => {
            use holtburger_protocol::messages::CharacterDeleteRequestData;
            let req = CharacterDeleteRequestData {
                account_name: account_name.clone(),
                character_slot,
            };
            let msg = GameMessage::CharacterDeleteRequest(Box::new(req));
            send_or_disconnect!(
                queued_events,
                e,
                session.send_message(&msg).await,
                "recv_loop: send CharacterDeleteRequest: {e}",
                "CharacterDeleteRequest: {e}",
                LoopFlow::Exit
            );
        }
        SessionCommand::RestoreCharacter { guid } => {
            use holtburger_common::Guid;
            use holtburger_protocol::messages::CharacterRestoreRequestData;
            let req = CharacterRestoreRequestData { guid: Guid(guid) };
            let msg = GameMessage::CharacterRestoreRequest(Box::new(req));
            send_or_disconnect!(
                queued_events,
                e,
                session.send_message(&msg).await,
                "recv_loop: send CharacterRestoreRequest: {e}",
                "CharacterRestoreRequest: {e}",
                LoopFlow::Exit
            );
        }
        SessionCommand::LogOff => {
            // login-1 (2026-10-08, round 4): retail
            // CPlayerSystem::RequestLogOff → Proto_UI::LogOffCharacter
            // (0xF653). ACE ignores the payload, so the bare opcode.
            let msg = GameMessage::CharacterLogOff;
            send_or_disconnect!(
                queued_events,
                e,
                session.send_message(&msg).await,
                "recv_loop: send CharacterLogOff: {e}",
                "CharacterLogOff: {e}",
                LoopFlow::Exit
            );
            console_log_str("[logoff] CharacterLogOff sent");
        }
        SessionCommand::Disconnect => {
            // 2026-10-09: retail quit teardown — ACE terminates the session on
            // a DISCONNECT (0x8000) packet (NetworkSession.ProcessPacket), so
            // the next login (a page reload) is not "Account In Use".
            if let Err(e) = session.send_disconnect().await {
                console_log_str(&format!("[disconnect] send failed: {e}"));
            } else {
                console_log_str("[disconnect] Disconnect sent");
            }
            return LoopFlow::Exit;
        }
        _ => unreachable!("SessionCommand routed to the wrong handler module"),
    }
    LoopFlow::Continue
}
