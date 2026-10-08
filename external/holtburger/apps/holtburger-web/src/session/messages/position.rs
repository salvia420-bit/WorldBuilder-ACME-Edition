//! `GameMessage` arms: Positions and motion: teleport,
//! Update/Private/PublicUpdatePosition, UpdateMotion, VectorUpdate.
//!
//! Moved verbatim from the inbound `match message` (2026-10-05 recv_loop
//! split); see `session::messages::dispatch_game_message` for the routing.

use crate::*;
use crate::session::{LoopCtx, LoopFlags, LoopFlow};
use holtburger_protocol::messages::{GameAction, GameMessage};

pub(super) async fn handle(ctx: &mut LoopCtx, message: GameMessage) -> LoopFlow {
    let LoopFlags {
        wire_state_packs_stage1_on,
        routine_pos_guard_on,
        remote_sticky_on,
        teleport_hook_on,
        ..
    } = ctx.flags;
    let LoopCtx {
        session,
        queued_events,
        entity_updates,
        local_player_pose,
        world,
        state,
        movement,
        entity_seeded,
        heartbeat_armed,
        pending_post_teleport_login_complete,
        pending_teleport_arrival_seq,
        ..
    } = &mut *ctx;
    match message {
        GameMessage::PlayerTeleport(data) => {
            // Phase 4 step 3.6: ACE sets player.Teleporting=true
            // on every teleport (e.g. @telepoi) and silently
            // drops AutonomousPosition packets while the flag
            // is set. The cli pattern is to fire LoginComplete
            // back on every PlayerTeleport — that's the action
            // ACE's GameActionLoginComplete invokes
            // OnTeleportComplete on, which clears Teleporting.
            // Without this, AutonomousPosition heartbeats are
            // received but silently dropped, server-side
            // position freezes at the @telepoi destination,
            // and movement looks fine client-side but the
            // server never sees it (the original 3.6 bug
            // pattern at a different layer).
            console_log_str(&format!(
                "[step 3.6] PlayerTeleport received (teleport_seq={}); sending LoginComplete to clear Teleporting",
                data.teleport_sequence,
            ));
            // Workstream G (3D camera/game-feel fix, 2026-05-11):
            // mirror the cli's `holtburger_world::handlers::player.rs:71-78`
            // PlayerTeleport flow on the wasm side. The cli routes
            // PlayerTeleport through `routing::handle_message` →
            // `player::handle_message` which (a) advances the
            // player's teleport_sequence and (b) calls
            // `suspend_runtime_bodies(TeleportOrWorldReset)` so
            // each body's pose snaps to its authoritative_pose
            // and `sampling.mode` flips to `Suspended`. The wasm
            // bundle's `should_route_message_to_world` filter
            // does NOT include `PlayerTeleport` (the recv loop
            // owns the LoginComplete action), so without this
            // mirror the wasm-side WorldState gets:
            //   - teleport_sequence stale (never advanced).
            //   - body.sampling.mode stuck at SimulatingMotionState
            //     (from the entity-seed `set_local_player_runtime_pose`
            //     call), which is then load-bearing for the
            //     subsequent UpdatePosition's
            //     `reconcile_authoritative_body` preserve-runtime
            //     gate: with `Snapshot` + `LocalPlayer` +
            //     SimulatingMotionState, preserve=true and
            //     body.pose is NOT reset to the new (destination)
            //     pose. body.authoritative_pose updates fine via
            //     the wasm-side `set_player_position` path; the
            //     runtime pose silently sticks at the source
            //     landblock. The F-capture diag (2026-05-11)
            //     confirms:
            //       [step 3.6 tick #120] pose=(12.32,-28.48,0.00)
            //         cell=0x860201AD indoor=true ...
            //         auth=(84.00,7.10,94.00) (Holtburg
            //         destination) mode=SimulatingMotionState
            //     With pose stuck at the Academy indoor cell,
            //     the integrator's `advance_local_pose_for_-
            //     manual_drive` hits the academy-rubberband-fix
            //     pre-bake gate (indoor cell with no triangles +
            //     no AABB) and zeros lateral delta — player
            //     can't move at all even when W is pressed.
            //
            // Fix: advance teleport_sequence + suspend bodies
            // here, mirroring the world handler. Then the
            // subsequent UpdatePosition for the destination
            // hits the wasm's reconcile gate, set_player_position
            // fires (Workstream G unconditional-snap below),
            // and `reconcile_authoritative_body` sees
            // mode=Suspended → preserve=false → body.pose snaps
            // to the destination pose. mode flips to
            // AuthoritativeOnly; the integrator's next W press
            // sets it back to SimulatingMotionState.
            // A13-W1 (2026-06-11): under `?wireStatePacks=stage1`
            // the canonical `handlers/player.rs` PlayerTeleport
            // arm (routed above via
            // `should_route_message_to_world`) already performed
            // EXACTLY this pair — `set_teleport_sequence` +
            // `suspend_runtime_bodies(TeleportOrWorldReset)` —
            // so the hand-mirror below is skipped on-path (the
            // duplicated-mirror class this whole workstream
            // retires; survey A13 §3 row 3).
            if !wire_state_packs_stage1_on
                && let Some(w) = world.borrow_mut().as_mut()
            {
                w.player.set_teleport_sequence(data.teleport_sequence);
                let _ = w.suspend_runtime_bodies(
                    holtburger_world::RuntimeBodyResetCause::TeleportOrWorldReset,
                );
                // Soak-11 Layer-1 (2026-07-20): arm the
                // teleport-arrival latch. `set_teleport_sequence`
                // above pre-mirrors the destination stamp, so the
                // follow-up self `UpdatePosition` reads its
                // `teleport_sequence` EQUAL (`is_newer_u16 ==
                // false`) and lands via the Snapshot de-suspend,
                // which does NOT self-latch
                // `pending_arrival_placement` → retail's arrival
                // PLACEMENT (`find_placement_position`,
                // acclient.c:313341) is skipped and an embedded
                // arrival stays stuck at the env-cell seam. Arming
                // here lets the next self `UpdatePosition` latch the
                // placement (consume-once via
                // `take_teleport_arrival`).
                w.player.arm_teleport_arrival();
                console_log_str(&format!(
                    "[workstream-G] PlayerTeleport: advanced teleport_sequence → {} + suspended runtime bodies + armed arrival-placement latch; runtime pose will snap on next UpdatePosition",
                    data.teleport_sequence,
                ));
            }
            // A4-Q3 (2026-06-12): exit-world drain — retail
            // cancels every pending one-shot with
            // `AnimationDone(success=0)` across the portal/
            // teleport transit (`CPhysicsObj::exit_world` →
            // `MotionTableManager::HandleExitWorld` +
            // `MovementManager::HandleExitWorld`,
            // acclient.c:322215-322220 → :329940-329947,
            // :339411-339417). Dual-site with the cli recv arm
            // (client/messages.rs `PlayerTeleport`), the F2-3
            // pattern — `should_route_message_to_world` only
            // routes `PlayerTeleport` under
            // `?wireStatePacks=stage1` and the movement
            // world-event pass ignores `TeleportStarted`, so
            // the recv arm owns the trigger on BOTH stage1
            // states (no double-fire: nothing else drains).
            // Local half is `USE_MOTION_TABLE_QUEUE`-gated;
            // registry half is map-miss-inert. The JS
            // `?mtQueue` overlay-cancellation notify may land
            // before or after this drain — both orders are
            // empty-queue no-ops on the loser
            // (acclient.c:329884 head-null guard). The renderer
            // overlay stop itself is JS-owned (entities.js
            // `_cancelOneShotOverlays`, the
            // `remove_all_link_animations` analogue).
            if let Some(w) = world.borrow().as_ref() {
                movement.handle_exit_world_for(w.player.guid, true);
            }
            // F2-3 (movement bughunt 2026-06-09): sending
            // `LoginComplete` here — the instant `PlayerTeleport`
            // arrives — clears ACE's `Teleporting` flag
            // (`GameActionLoginComplete` → `OnTeleportComplete`)
            // BEFORE the destination `UpdatePosition` has been
            // applied. ACE then accepts AutonomousPosition while
            // we're still streaming the SOURCE landblock pose
            // (the desync ACE flags at `Player_Tick.cs:416`).
            // Retail's `CPlayerSystem::SendLoginCompleteNotification`
            // (`acclient.c 0x562E90`) never sends from the teleport
            // message — it gates on the destination being loaded.
            // When the flag is on, defer to the first post-teleport
            // local-player `UpdatePosition` (handled in the
            // `GameMessage::UpdatePosition` arm); ACE always emits
            // that destination pose via the "fake" SendUpdatePosition
            // in `Player_Location.Teleport`. Default-off; see
            // `holtburger_core::client::DEFER_LOGIN_COMPLETE_AFTER_TELEPORT`.
            if holtburger_core::client::DEFER_LOGIN_COMPLETE_AFTER_TELEPORT {
                *pending_post_teleport_login_complete = true;
                console_log_str(
                    "[F2-3] PlayerTeleport: deferring LoginComplete until first post-teleport UpdatePosition (destination applied)",
                );
            } else {
                let login_complete = GameAction::LoginComplete(Box::new(
                    holtburger_protocol::messages::LoginCompleteActionData,
                ));
                if let Err(e) = session.send_action(login_complete).await {
                    console_log_str(&format!(
                        "[step 3.6] post-teleport LoginComplete send failed: {e}"
                    ));
                }
            }
            // ACPlugin PR-4 (2026-05-27): Character.OnPortalSpaceEntered
            // mirror. `Character.cs:468-471` fires the bus
            // event on every Effects_PlayerTeleport — the
            // loading-screen overlay listens for it.
            // Portal-space exit gate: arm the arrival edge for THIS
            // teleport (a re-teleport before arrival simply re-arms with
            // the newer sequence). Consumed in the self `UpdatePosition`
            // arm below -> kind=66 TeleportArrived.
            *pending_teleport_arrival_seq = Some(data.teleport_sequence);
            queued_events.borrow_mut().push(ClientEvent {
                kind: CLIENT_EVENT_KIND_PORTAL_SPACE_ENTERED,
                string_payload: None,
                u32_payload: Some(u32::from(data.teleport_sequence)),
                u32_payload_2: None,
                f32_payload: None,
            });
        }
        // Phase 4 step 2b: position-bearing messages.
        // Each pushes an EntityUpdate into the entity
        // channel; JS drains via pollEntityUpdates() and
        // applies updates to its `Map<guid, sprite>`.
        // Reference handlers in the cli:
        //   - UpdatePosition:        crates/holtburger-world/src/handlers/player.rs:33-46
        //   - PrivateUpdatePosition: crates/holtburger-world/src/handlers/movement.rs:41-43
        //   - PublicUpdatePosition:  crates/holtburger-world/src/handlers/movement.rs:45-46
        //   - ObjectCreate:          crates/holtburger-world/src/handlers/inventory.rs:19-51
        //   - ObjectDelete:          crates/holtburger-world/src/handlers/inventory.rs:53-56
        GameMessage::UpdatePosition(data) => {
            let pos = &data.pos.pos;
            // Phase 4 step 3: UpdatePosition is the
            // only inbound position message that
            // carries all four sequence numbers
            // (`PositionPack` vs. the bare `WorldPosition`
            // in Public/Private updates). When ACE
            // addresses the local player by guid here,
            // capture the sequences so subsequent
            // outbound MoveToState packets carry a
            // current snapshot.
            if let LoopState::InWorld { player_guid } = &state
                && data.guid == *player_guid
            {
                // A13-W1 (2026-06-11): the `LocalPlayerSnapshot`
                // quartet copy that used to be written here was
                // a write-only dead third copy (survey A13 §3
                // row 7) — the outbound MoveToState /
                // AutonomousPosition / Jump builders all read
                // `w.player.*`. Removed outright (no gate:
                // deleting dead writes is behavior-identical).
                // F2-3: this UpdatePosition is the destination
                // pose after a teleport (its sequences were just
                // captured above, so the client is now at the
                // destination). If a `PlayerTeleport` deferred its
                // `LoginComplete`, send it now — ACE clears
                // `Teleporting` and starts accepting our
                // AutonomousPosition from the correct landblock.
                // Portal-space exit gate (kind=66): the destination pose
                // of the pending teleport has arrived. `wrapping_sub < 0x8000`
                // = same-or-newer u16 sequence (retail's half-range compare).
                if let Some(seq) = *pending_teleport_arrival_seq
                    && data.pos.teleport_sequence.wrapping_sub(seq) < 0x8000
                {
                    *pending_teleport_arrival_seq = None;
                    queued_events.borrow_mut().push(ClientEvent {
                        kind: CLIENT_EVENT_KIND_TELEPORT_ARRIVED,
                        string_payload: None,
                        u32_payload: Some(u32::from(data.pos.pos.landblock_id)),
                        u32_payload_2: Some(u32::from(data.pos.teleport_sequence)),
                        f32_payload: None,
                    });
                    // streaming-teleport-2 (2026-10-08 follow-ups,
                    // `?teleportHook`): the destination pose landed — retail
                    // `HandleReceivedPosition` → `TeleportPlayer` →
                    // `PlayerPositionUpdated(teleporting=1)`
                    // (acclient.c:145196-145198, :144695-144712) runs
                    // `teleport_hook` (CancelMoveTo 0x3C ITeleported,
                    // UnStick) and `CommandInterpreter::PlayerTeleported`
                    // (autorun off + a movement event). Queued for the next
                    // movement tick (it needs world access).
                    if teleport_hook_on {
                        movement.player_teleported();
                    }
                }
                if *pending_post_teleport_login_complete {
                    *pending_post_teleport_login_complete = false;
                    let login_complete = GameAction::LoginComplete(Box::new(
                        holtburger_protocol::messages::LoginCompleteActionData,
                    ));
                    if let Err(e) = session.send_action(login_complete).await {
                        console_log_str(&format!(
                            "[F2-3] deferred post-teleport LoginComplete send failed: {e}"
                        ));
                    } else {
                        console_log_str(
                            "[F2-3] deferred post-teleport LoginComplete sent (destination UpdatePosition applied)",
                        );
                    }
                }
                // Phase 4 step 3.6: UpdatePosition for the
                // local player is the canonical position
                // packet (PrivateUpdatePosition rarely fires
                // in this flow). Seed the WorldState entity
                // here so MovementSystem::tick has a pose
                // and sequences to work with.
                if let Some(w) = world.borrow_mut().as_mut() {
                    let pose = data.pos.pos;
                    if !*entity_seeded {
                        let entity =
                            holtburger_world::entity::Entity::new(
                                *player_guid,
                                String::from("LocalPlayer"),
                                pose,
                            );
                        w.add_entity(entity);
                        let _ = w.set_local_player_runtime_pose(pose);
                        *entity_seeded = true;
                        console_log_str(&format!(
                            "[step 3.6] WorldState player entity seeded via UpdatePosition at landblock=0x{:08X} ({:.1}, {:.1}, {:.1})",
                            u32::from(pose.landblock_id),
                            pose.coords.x, pose.coords.y, pose.coords.z,
                        ));
                    } else if !wire_state_packs_stage1_on {
                        // A13-W1 (2026-06-11): this whole
                        // reconcile branch is the legacy
                        // OFF-path. Under
                        // `?wireStatePacks=stage1` the routed
                        // canonical `handlers/player.rs`
                        // UpdatePosition arm already ran
                        // `apply_position_from_server` (with
                        // `is_newer_u16` acceptance gating the
                        // hand-rolled path never had) + the
                        // SAME B1/D3-SNAP Reset-vs-Snapshot
                        // discriminant +
                        // `set_player_position_with_sync` —
                        // re-running it here would double-apply.
                        //
                        // Workstream G (3D camera/game-feel
                        // fix, 2026-05-11): always call
                        // `set_player_position` for the local
                        // player's UpdatePosition. The
                        // `reconcile_authoritative_body`
                        // implementation (in scene.rs:880-896)
                        // has a `preserve_local_runtime_pose`
                        // gate that fires when
                        //   LocalPlayer ∧ Snapshot ∧
                        //   mode ∈ {SimulatingMotionState,
                        //          SimulatingVelocity}
                        // and preserves body.pose while
                        // updating body.authoritative_pose +
                        // velocity/omega. That gate IS the
                        // load-bearing piece preventing the
                        // 2026-05-10 academy-rubberband
                        // "moves a bit, snaps back" symptom:
                        // during active simulation the
                        // integrator's mode is
                        // SimulatingMotionState so routine
                        // UpdatePosition broadcasts only
                        // refresh the auth pose, leaving the
                        // predicted runtime pose intact.
                        //
                        // The previous wasm-side
                        // `force_advanced || teleport_advanced`
                        // gate was a second-layer defense
                        // that, in retrospect, has a load-
                        // bearing failure mode for teleports:
                        // PlayerTeleport's wasm handler
                        // (above, line ~10387) advances
                        // `w.player.teleport_sequence`, so
                        // the subsequent UpdatePosition for
                        // the destination carries the SAME
                        // teleport_sequence the wasm
                        // mirrored when PlayerTeleport
                        // landed — `teleport_advanced =
                        // is_newer_u16(N, N) = false`. The
                        // gate doesn't fire, set_player_-
                        // position is never called, and
                        // body.pose stays at the source
                        // landblock while body.authoritative_-
                        // pose updates to the destination
                        // (via the implicit reconcile path
                        // through subsequent ObjectCreate /
                        // VectorUpdate / etc.). The
                        // integrator's
                        // `advance_local_pose_for_manual_-
                        // drive` then runs against the
                        // source pose, hits the academy-
                        // rubberband-fix indoor pre-bake
                        // gate if the source is an indoor
                        // cell, and zeros lateral delta —
                        // player can't walk at all.
                        //
                        // PlayerTeleport (above) now ALSO
                        // calls
                        // `suspend_runtime_bodies(Teleport-
                        // OrWorldReset)` which flips
                        // `body.sampling.mode` to Suspended.
                        // On the next UpdatePosition,
                        // unconditional set_player_position
                        // → reconcile_authoritative_body
                        // sees Suspended (NOT Simulating*),
                        // preserve=false, body.pose snaps
                        // to the destination. After that
                        // the integrator's first W press
                        // re-arms SimulatingMotionState
                        // and the preserve gate engages
                        // for routine broadcasts as before.
                        //
                        // The diagnostic log now fires on
                        // every snap so a regression where
                        // routine broadcasts overwrite the
                        // runtime pose would be visible
                        // immediately (look for
                        // `[acad-diag reconcile]` lines
                        // accumulating during active
                        // W-hold — should be empty post-fix).
                        // Only emit a diagnostic when the
                        // snap will actually take effect
                        // (mode ∉ Simulating*). During
                        // active integration the
                        // preserve-runtime-pose gate
                        // fires and the set_player_position
                        // call is a no-op on body.pose;
                        // logging on every routine
                        // broadcast floods the JS
                        // console / postMessage bridge
                        // and observably slows the
                        // recv-loop drain cadence
                        // (verified via F-capture: at-fix
                        // log-on-every-tick ran 4× slower
                        // than log-on-snap-only).
                        use holtburger_world::SpatialSampleMode;
                        let snap_will_apply = w
                            .runtime_body_id_for_guid(w.player.guid)
                            .and_then(|bid| w.runtime_body_view(bid))
                            .is_some_and(|view| {
                                !matches!(
                                    view.sample_mode,
                                    SpatialSampleMode::SimulatingMotionState
                                        | SpatialSampleMode::SimulatingVelocity
                                )
                            });
                        if snap_will_apply && DIAG_VERBOSE {
                            console_log_str(&format!(
                                "[acad-diag reconcile] snapping to server pose: force_seq={} teleport_seq={} pose=({:.2}, {:.2}, {:.2})",
                                data.pos.force_position_sequence,
                                data.pos.teleport_sequence,
                                pose.coords.x,
                                pose.coords.y,
                                pose.coords.z,
                            ));
                        }
                        // B1/D3-SNAP: choose the reconcile
                        // discriminant by sequence class. This
                        // is NOT the removed call-gating
                        // footgun discussed above —
                        // set_player_position_with_sync is
                        // ALWAYS called; we only pick Reset
                        // (hard-snap: retail BlipPlayer /
                        // TeleportPlayer, acclient.c:145196-
                        // 145253) vs Snapshot (blend behind the
                        // Simulating* preserve gate). A missed
                        // teleport advance (stamp already
                        // mirrored by PlayerTeleport) just falls
                        // back to Snapshot, which the Suspended
                        // mode PlayerTeleport set still
                        // hard-snaps — cross-LB teleports are
                        // unaffected. The genuinely new case is
                        // a force_position advance WITHOUT a
                        // PlayerTeleport (the z-hack /PKLite
                        // snapback, ACE Player_Tick.cs:488 /
                        // Player.cs:1148): force_position_-
                        // sequence is strictly newer here, so
                        // the predicted body hard-snaps to
                        // LastGroundPos instead of preserving
                        // the drifted pose beyond the blip
                        // radius (RECON-1). Compared BEFORE the
                        // sequence mirror below, so w.player
                        // still holds the previous stamps.
                        let force_or_teleport_advanced =
                            holtburger_common::sequence::is_newer_u16(
                                data.pos.teleport_sequence,
                                w.player.teleport_sequence,
                            ) || holtburger_common::sequence::is_newer_u16(
                                data.pos.force_position_sequence,
                                w.player.force_position_sequence,
                            );
                        // Soak-11 Layer-1 (2026-07-20): consume the
                        // teleport-arrival latch (consume-once). Armed
                        // by the OFF-path PlayerTeleport handler above;
                        // the take clears it whether or not it fires.
                        // NOTE: the live client runs the canonical
                        // `handlers/player.rs` path (wireStatePacks
                        // default-ON); this legacy OFF-path arm is the
                        // `?wireStatePacks=off` twin — same latch shape.
                        let teleport_arrival_pending =
                            w.player.take_teleport_arrival();
                        if teleport_arrival_pending {
                            // Teleport destination arrival (pre-mirrored
                            // stamp → not `force_or_teleport_advanced`):
                            // de-suspend the body via the Snapshot
                            // reconcile (mode ∉ Simulating* ⇒ no
                            // preserve gate, body snaps to destination),
                            // then latch the retail arrival PLACEMENT
                            // (`find_placement_position`) so the movement
                            // tick de-embeds an env-cell-wall landing.
                            // Additive: the body sync/mode trajectory
                            // matches the canonical `body_suspended` arm.
                            let _ = w.set_player_position_with_sync(
                                pose,
                                holtburger_world::AuthoritativeBodySync::Snapshot,
                            );
                            w.player.latch_arrival_placement();
                        } else if routine_pos_guard_on
                            && !force_or_teleport_advanced
                        {
                            // Movement bughunt 2026-06-19
                            // ("stall → pull-back"): a ROUTINE self
                            // UpdatePosition is the laggy ~20 Hz echo of
                            // our OWN movement; when backlog-delayed it
                            // lands tens of metres behind and the
                            // preserve path eases the avatar backward
                            // (force-position interp). Keep client
                            // prediction; update authoritative
                            // bookkeeping only.
                            let _ =
                                w.set_player_position_authoritative_only(pose);
                        } else {
                            let sync = if force_or_teleport_advanced {
                                holtburger_world::AuthoritativeBodySync::Reset
                            } else {
                                holtburger_world::AuthoritativeBodySync::Snapshot
                            };
                            let _ = w.set_player_position_with_sync(pose, sync);
                        }
                    }
                    // Mirror the quartet sequences onto the
                    // WorldState player so outbound
                    // MoveToState / AutonomousPosition pull
                    // current values. LEGACY OFF-path only:
                    // under `?wireStatePacks=stage1` the
                    // canonical `apply_position_from_server`
                    // (mutations.rs) owns these writes — with
                    // sequence-acceptance gating, plus the
                    // `position_sequence` slot this mirror
                    // always dropped (A13-W1; retail single
                    // owner `CPhysicsObj::update_times[4/5/6/8]`,
                    // acclient.c:718175-718187).
                    if !wire_state_packs_stage1_on {
                        w.player.instance_sequence =
                            data.pos.instance_sequence;
                        w.player.teleport_sequence =
                            data.pos.teleport_sequence;
                        w.player.force_position_sequence =
                            data.pos.force_position_sequence;
                    }
                    if !*heartbeat_armed && *entity_seeded {
                        let now = web_time::Instant::now();
                        movement.arm_heartbeat_schedule(now, w);
                        *heartbeat_armed = true;
                        console_log_str(
                            "[step 3.6] AutonomousPosition heartbeat armed",
                        );
                    }
                    // B3-WI4 (2026-07-21): publish the pose
                    // shadow at the UpdatePosition tail so the
                    // JS cell reflects the just-applied
                    // authoritative pose the SAME tick it
                    // arrives (death/portal reconcile) instead
                    // of waiting for the next TickMovement
                    // publish. Uses the live `&mut w`
                    // (reborrowed shared) and the distinct
                    // `local_player_pose` cell — no RefCell
                    // double-borrow. The retention rule inside
                    // keeps a good prior cell if the runtime
                    // pose is transiently NULL/absent here.
                    publish_local_player_pose(w, &local_player_pose);
                }
            }
            // OpenAC comparison 2026-10-04 (remote motion D3):
            // retail drops a stale / reordered remote position
            // entirely (`SmartBox::HandleReceivedPosition`,
            // acclient.c:145125-145240). The routed world
            // handler already ran that gate
            // (`apply_entity_position_pack`); when it REJECTED
            // this frame the entity still holds its previous
            // pose — don't hand the stale pose to JS, whose
            // setPose would retarget the heading, drop the
            // sticky glue and ease toward it.
            let remote_rejected = wire_state_packs_stage1_on
                && !matches!(&state, LoopState::InWorld { player_guid } if data.guid == *player_guid)
                && world.borrow().as_ref().is_some_and(|w| {
                    w.entities
                        .get(data.guid)
                        .is_some_and(|e| e.position != *pos)
                });
            if !remote_rejected {
            entity_updates.borrow_mut().push(EntityUpdate {
                kind: ENTITY_UPDATE_KIND_POSITION,
                guid: u32::from(data.guid),
                model_id: 0,
                landblock_id: u32::from(pos.landblock_id),
                x: pos.coords.x,
                y: pos.coords.y,
                z: pos.coords.z,
                qw: pos.rotation.w,
                qx: pos.rotation.x,
                qy: pos.rotation.y,
                qz: pos.rotation.z,
                wcid: 0,
                item_type: 0,
                name: String::new(),
                obj_scale: 1.0,
                icon_id: 0,
                palette_id: 0,
                mtable_id: 0,
                model_changes: Vec::new(),
                texture_changes: Vec::new(),
                sub_palettes: Vec::new(),
                placement_id: 0,
                portal_destination: String::new(),
                vx: 0.0,
                vy: 0.0,
                vz: 0.0,
                omega_z: 0.0,
                motion_command: 0,
                motion_stance: 0,
                physics_script_did: 0,
                sound_table_did: 0,
                obj_desc_flags: 0,
                weenie_flags: 0,
                // A1 (2026-05-29): non-MOTION updates carry no
                // playback speed — identity (no anim scaling).
                motion_speed: 1.0,
                physics_translucency: 0.0,
                is_autonomous: false,
            });
            }
        }
        GameMessage::PrivateUpdatePosition(data) => {
            // PrivateUpdatePosition has no guid in the
            // payload (the wire message implies "the
            // local player"). Substitute the
            // LoopState::InWorld player_guid; if we
            // somehow get a Private update before
            // PlayerCreate landed, the message has no
            // owner — drop it.
            let local_guid = match &state {
                LoopState::InWorld { player_guid } => Some(*player_guid),
                _ => None,
            };
            if let Some(guid) = local_guid {
                let pos = &data.pos;
                // (A13-W1: the `LocalPlayerSnapshot` position
                // cache formerly written here was a write-only
                // dead copy — removed.)
                // Phase 4 step 3.6: seed the WorldState
                // player entity on the first inbound
                // position (we now know the spawn pose),
                // then arm the AutonomousPosition
                // heartbeat. Subsequent updates push
                // through `set_player_position` so the
                // outbound MovementSystem tick reads
                // current sequences + pose.
                if let Some(w) = world.borrow_mut().as_mut() {
                    if !*entity_seeded {
                        let entity = holtburger_world::entity::Entity::new(
                            guid,
                            String::from("LocalPlayer"),
                            *pos,
                        );
                        w.add_entity(entity);
                        let _ = w.set_local_player_runtime_pose(*pos);
                        *entity_seeded = true;
                        console_log_str(&format!(
                            "[step 3.6] WorldState player entity seeded at landblock=0x{:08X} ({:.1}, {:.1}, {:.1})",
                            u32::from(pos.landblock_id),
                            pos.coords.x, pos.coords.y, pos.coords.z,
                        ));
                    } else {
                        // 2026-05-10 reconciliation gate:
                        // PrivateUpdatePosition has no
                        // sequence numbers in its payload
                        // (`PrivateUpdatePositionData`
                        // ships only `pos: WorldPosition`),
                        // so we can't gate on force /
                        // teleport seqs here. Conservative
                        // choice: trust the integrator's
                        // prediction unconditionally for
                        // `position_type == Location`
                        // (the routine local-player
                        // broadcast). UpdatePosition's
                        // sequence-aware gate above is
                        // where genuine force-repositions
                        // come through. If a regression
                        // shows up where ACE does send a
                        // force via PrivateUpdatePosition,
                        // wire `data.position_type` into
                        // a separate snap branch here.
                        // Diagnostic: log when we'd
                        // previously have snapped, so a
                        // future regression is visible
                        // before it bites.
                        if let Some(client_pose) =
                            w.local_player_runtime_pose()
                        {
                            let dx = client_pose.coords.x - pos.coords.x;
                            let dy = client_pose.coords.y - pos.coords.y;
                            let dz = client_pose.coords.z - pos.coords.z;
                            let dist_sq = dx * dx + dy * dy + dz * dz;
                            // 5 m drift tolerance — ACE
                            // typically broadcasts within
                            // a meter of client prediction;
                            // larger drifts indicate the
                            // integrator has gotten lost.
                            if dist_sq > 25.0 {
                                if routine_pos_guard_on {
                                    // Movement bughunt 2026-06-19
                                    // ("stall → pull-back"):
                                    // PrivateUpdatePosition carries
                                    // no force/teleport sequences →
                                    // always ROUTINE. A backlog-stale
                                    // echo drifts >5 m behind; the old
                                    // `set_player_position` snap eased
                                    // the avatar backward. Keep client
                                    // prediction; bookkeeping only.
                                    let _ = w
                                        .set_player_position_authoritative_only(
                                            *pos,
                                        );
                                } else {
                                    if DIAG_VERBOSE {
                                        console_log_str(&format!(
                                            "[acad-diag reconcile] PrivateUpdatePosition drift {:.2} m → snapping to server",
                                            dist_sq.sqrt(),
                                        ));
                                    }
                                    let _ = w.set_player_position(*pos);
                                }
                            }
                        }
                    }
                    if !*heartbeat_armed && *entity_seeded {
                        let now = web_time::Instant::now();
                        movement.arm_heartbeat_schedule(now, w);
                        *heartbeat_armed = true;
                        console_log_str(
                            "[step 3.6] AutonomousPosition heartbeat armed",
                        );
                    }
                }
                entity_updates.borrow_mut().push(EntityUpdate {
                    kind: ENTITY_UPDATE_KIND_POSITION,
                    guid: u32::from(guid),
                    model_id: 0,
                    landblock_id: u32::from(pos.landblock_id),
                    x: pos.coords.x,
                    y: pos.coords.y,
                    z: pos.coords.z,
                    qw: pos.rotation.w,
                    qx: pos.rotation.x,
                    qy: pos.rotation.y,
                    qz: pos.rotation.z,
                    wcid: 0,
                    item_type: 0,
                    name: String::new(),
                    obj_scale: 1.0,
                    icon_id: 0,
                    palette_id: 0,
                    mtable_id: 0,
                    model_changes: Vec::new(),
                    texture_changes: Vec::new(),
                    sub_palettes: Vec::new(),
                    placement_id: 0,
                    portal_destination: String::new(),
                    vx: 0.0,
                    vy: 0.0,
                    vz: 0.0,
                    omega_z: 0.0,
                    motion_command: 0,
                    motion_stance: 0,
                    physics_script_did: 0,
                    sound_table_did: 0,
                    obj_desc_flags: 0,
                    weenie_flags: 0,
                // A1 (2026-05-29): non-MOTION updates carry no
                // playback speed — identity (no anim scaling).
                motion_speed: 1.0,
                physics_translucency: 0.0,
                    is_autonomous: false,
                });
            }
        }
        GameMessage::PublicUpdatePosition(data) => {
            let pos = &data.pos;
            // (A13-W1: the `LocalPlayerSnapshot` position
            // cache formerly refreshed here on a local-player
            // echo was a write-only dead copy — removed.)
            // A2-P3 (W3+ S9): minimal TargetManager-subset
            // pose feed for the LOCAL sticky target —
            // remote entities are NOT world-routed on the
            // default wasm path (S8/A8-M2 territory), so
            // the sticky target's live pose is stashed
            // here (retail StickyManager::HandleUpdateTarget,
            // acclient.c:388691-388720). One inert compare
            // unless sticky is active (never, with
            // USE_STICKY_MANAGER off).
            if let Some(w) = world.borrow_mut().as_mut()
                && w.scene.local_sticky_target() == Some(data.guid)
            {
                w.scene.sticky_pose_feed(data.guid, data.pos);
            }
            entity_updates.borrow_mut().push(EntityUpdate {
                kind: ENTITY_UPDATE_KIND_POSITION,
                guid: u32::from(data.guid),
                model_id: 0,
                landblock_id: u32::from(pos.landblock_id),
                x: pos.coords.x,
                y: pos.coords.y,
                z: pos.coords.z,
                qw: pos.rotation.w,
                qx: pos.rotation.x,
                qy: pos.rotation.y,
                qz: pos.rotation.z,
                wcid: 0,
                item_type: 0,
                name: String::new(),
                obj_scale: 1.0,
                icon_id: 0,
                palette_id: 0,
                mtable_id: 0,
                model_changes: Vec::new(),
                texture_changes: Vec::new(),
                sub_palettes: Vec::new(),
                placement_id: 0,
                portal_destination: String::new(),
                vx: 0.0,
                vy: 0.0,
                vz: 0.0,
                omega_z: 0.0,
                motion_command: 0,
                motion_stance: 0,
                physics_script_did: 0,
                sound_table_did: 0,
                obj_desc_flags: 0,
                weenie_flags: 0,
                // A1 (2026-05-29): non-MOTION updates carry no
                // playback speed — identity (no anim scaling).
                motion_speed: 1.0,
                physics_translucency: 0.0,
                is_autonomous: false,
            });
        }
        GameMessage::UpdateMotion(data) => {
            // OpenAC comparison 2026-10-04 (remote motion D8):
            // the routed world handler applies retail's
            // CPhysics::SetObjectMovement stamp gate and
            // records an accepted stamp. A REMOTE UpdateMotion
            // whose stamp it did not record was stale or
            // reordered — don't animate it (a replayed swing,
            // a snap back to Ready mid-run).
            let remote_motion_stale = wire_state_packs_stage1_on
                && !matches!(&state, LoopState::InWorld { player_guid } if data.guid == *player_guid)
                && world.borrow().as_ref().is_some_and(|w| {
                    w.entities
                        .get(data.guid)
                        .is_some_and(|e| e.movement_sequence() != data.movement_sequence)
                });
            if !remote_motion_stale {
            // Phase 4 step 3 wire validation: ACE
            // broadcasts UpdateMotion in response to
            // our outbound MoveToState (see
            // `Player_Networking.cs::BroadcastMovement`
            // line 365 — `EnqueueBroadcast(true, ...)`
            // includes the originator). Receiving this
            // confirms ACE accepted our packet and is
            // simulating motion. The local player's
            // sprite still won't slide — retail AC
            // expects the client to predict locally —
            // but the round-trip is observable here.
            if DIAG_VERBOSE {
                console_log_str(&format!(
                    "[step3-trace] UpdateMotion guid=0x{:08X} (ACE accepted MoveToState)",
                    u32::from(data.guid),
                ));
            }
            // Animation-gate hint: derive the active
            // forward locomotion command so JS can
            // gate walk-cycle animation on a server-
            // authoritative state instead of the
            // EMA-on-position-deltas heuristic. Source
            // of truth varies by `MovementType`:
            //   - StopCompletely → STOP (definitive idle)
            //   - Invalid (the autonomous/raw envelope
            //     player movement uses): pull
            //     `state.forward_command` if the flag
            //     bit is set; else 0 (no signal).
            //   - MoveToObject / MoveToPosition → server
            //     pathing; treat as RUN_FORWARD (these
            //     carry a `run_rate` but no command code,
            //     and AI-pathed creatures default to run
            //     speed in retail).
            //   - TurnToObject / TurnToHeading → no
            //     forward locomotion; 0 lets JS keep
            //     the EMA gate's current state.
            use holtburger_protocol::messages::movement::{
                InterpretedMotionCommand, MovementType, MovementTypeData,
            };
            let motion_command_u16: u16 = match (data.movement_type, &data.data) {
                (MovementType::StopCompletely, _) => {
                    InterpretedMotionCommand::STOP.raw()
                }
                (_, MovementTypeData::Invalid(inv)) => inv
                    .state
                    .forward_command
                    .map(|c| c.raw())
                    // Wave 2 (2026-06-08, review B6) — SINGLE-ROUTE
                    // guarantee. A use-action (Eat 0x4000001A /
                    // Drink 0x4000001B) rides the `forward_command`
                    // slot on a stock ACE server, and the Wave-2
                    // action surfacing now picks it up here as a
                    // `KIND_MOTION_ACTION` one-shot. If we ALSO let
                    // it fall through to the locomotion
                    // `motion_command`, a REMOTE eater would play
                    // the eat clip TWICE (KIND_MOTION classifies
                    // 0x1A/0x1B as an INTERACTION LoopOnce overlay,
                    // and KIND_MOTION_ACTION plays it again). Drop
                    // it from the locomotion path so it plays on
                    // KIND_MOTION_ACTION ONLY. Locomotion / stance /
                    // state forward_commands are NOT actions and
                    // pass through unchanged (the gait still drives
                    // off the server echo for remotes).
                    .filter(|raw| {
                        !holtburger_world::player::expand_motion_command_low16(*raw)
                            .is_some_and(holtburger_world::player::is_action_motion_command)
                    })
                    .unwrap_or(0),
                (
                    MovementType::MoveToObject | MovementType::MoveToPosition,
                    mtd,
                ) => {
                    // C1 (2026-06-03): gate the walk/run cycle on
                    // the MoveToParameters MovementParams flags
                    // instead of hardcoding RunForward — a
                    // walk-only creature now hints Walk. See
                    // `moveto_locomotion_hint`.
                    // F6 (2026-07-27): the distance branch of
                    // retail's hold-key rule (acclient.c:346217)
                    // is evaluated too — `origin` is the
                    // destination and the mover's last-known pose
                    // reconstructs `curr_distance`.
                    let params = match mtd {
                        MovementTypeData::MoveToObject(m) => {
                            Some((&m.params, &m.origin))
                        }
                        MovementTypeData::MoveToPosition(m) => {
                            Some((&m.params, &m.origin))
                        }
                        _ => None,
                    };
                    match params {
                        Some((mp, origin)) => {
                            let curr_distance = world
                                .borrow()
                                .as_ref()
                                .and_then(|w| {
                                    w.entities.get(data.guid).map(|e| e.position)
                                })
                                .map(|mover| {
                                    mover.distance_to(
                                        &holtburger_common::position::WorldPosition {
                                            landblock_id: origin.cell_id,
                                            coords: origin.position,
                                            rotation:
                                                holtburger_common::Quaternion::identity(),
                                        },
                                    )
                                });
                            moveto_locomotion_hint(
                                mp.movement_parameters,
                                curr_distance,
                                mp.distance_to_object,
                                mp.walk_run_threshold,
                            )
                        }
                        None => InterpretedMotionCommand::RUN_FORWARD.raw(),
                    }
                }
                _ => 0,
            };
            // Render-completeness Waves-2 A1 (2026-05-29):
            // surface the per-motion playback speed
            // (`InterpretedMotionState.forward_speed`,
            // `movement/types.rs:233`) so JS can scale the
            // locomotion animation framerate (retail
            // `Framerate *= speed`). Only the interpreted
            // (`Invalid`) envelope carries a forward speed;
            // server-pathed Move/Turn variants don't, so they
            // fall through to the `1.0` identity (no scaling —
            // fail-soft, matching the field's non-MOTION
            // default). Non-positive / non-finite values are
            // clamped to `1.0` so a bad scalar can't freeze the
            // rig.
            // F15-2 (2026-06-09): preserve the SIGN. A backstep
            // is WalkForward with `forward_speed` negated upstream
            // (× -0.65); the old `*s > 0.0` filter dropped the
            // negative and fell back to 1.0, so a remote backstep
            // played the forward walk at full speed = moonwalk.
            // Keep finite NON-ZERO values (incl. negative); JS
            // clamps the magnitude for the gait/velScale getter and
            // only USES the sign (reverse clip playback) under the
            // default-off `?signedMotionSpeed` flag, so the default
            // wire→JS behavior is unchanged.
            let motion_speed_f32: f32 = match &data.data {
                MovementTypeData::Invalid(inv) => inv
                    .state
                    .forward_speed
                    .filter(|s| s.is_finite() && *s != 0.0)
                    .unwrap_or(1.0),
                _ => 1.0,
            };
            // F3-4 (bughunt 2026-06-09) — sticky target. ACE
            // STOPS broadcasting a monster's position while it
            // is sticky-attacking (`Monster_Tick` calls
            // `UpdatePosition(false)` — netsend FALSE — relying
            // on the retail client's StickyManager to keep the
            // attacker glued to the moving target). We never
            // consumed sticky, so melee mobs froze in place when
            // the player kited. Surface the sticky target guid
            // so the JS tick can pin the mob to it. Two wire
            // sources: the `Invalid` (case-0) `sticky_object`,
            // and a `MoveToObject` carrying the MovementParams
            // `sticky` bit (0x80, acclient.h bit 7 — ACE sets it
            // on every chase, Creature_Navigation.cs:307). `0`
            // (no sticky / a fresh non-sticky command) clears it
            // JS-side. Carried on `model_id` (zeroed for
            // KIND_MOTION — same per-kind field-reuse as
            // KIND_ATTACH's parent-guid).
            let sticky_target: u32 = match &data.data {
                MovementTypeData::Invalid(inv) => {
                    inv.sticky_object.map(u32::from).unwrap_or(0)
                }
                MovementTypeData::MoveToObject(m)
                    if moveto_is_sticky(m.params.movement_parameters) =>
                {
                    u32::from(m.target)
                }
                _ => 0,
            };
            // R3 moveto-1 (2026-10-08) — the REMOTE sticky
            // source. The MoveToObject half above predates the
            // client-side remote MoveTo: retail
            // `unpack_movement` (acclient.c:339492) sticks
            // only from the case-0 `sticky_object`; a sticky-
            // bit MoveToObject sticks ON ARRIVAL
            // (BeginNextNode :345521), which
            // `drive_remote_movetos` already does. Sticking at
            // arm time zeroed the D5 chase walk and dragged
            // the mob at the sticky pull speed. While that
            // pump owns the arrival stick
            // (`remote_moveto_active()` + the remote sticky
            // lane), a remote MoveToObject unsticks (the
            // per-unpack preamble) and KIND_MOTION carries 0
            // (no JS glue lunge); otherwise the legacy F3-4
            // source stays. The LOCAL branch below keeps
            // `sticky_target` (player charges; the local
            // driver also sticks on arrival — follow-up).
            let rust_moveto_sticks = remote_sticky_on
                && world
                    .borrow()
                    .as_ref()
                    .is_some_and(|w| w.scene.remote_moveto_active());
            let remote_sticky_target: u32 =
                holtburger_world::handlers::movement::remote_motion_sticky_target(
                    &data.data,
                    rust_moveto_sticks,
                );
            // A2-P3 (2026-06-12, W3+ S9; RULINGS item 4)
            // — LOCAL-player sticky install on the
            // DEFAULT wasm path (NOT ?wireStatePacks-
            // gated), mirroring how the JS arm consumes
            // the same `model_id` field for remotes.
            // Retail `unpack_movement` sticks the
            // addressed object UNCONDITIONALLY — incl.
            // the local player (acclient.c:339546-339560
            // after the :339518-339519 unstick
            // preamble); the player's own melee-swing
            // echo carries the bit + guid (ACE
            // Player_Melee.cs:420-427; live-server
            // MovementInvalid.cs:45-46). `0` ⇒ unstick.
            // The JS local-guid exclusion at
            // loop.js:1951/:2222 STAYS — the local rig
            // is never JS-glued; its pose comes from the
            // wasm pose getters (spec S9 §3 L1 step 2).
            // COMBAT-RADII (2026-07-28): the target
            // radius is retail's `CPartArray::GetRadius`
            // (acclient.c:319755) via
            // `combat_sticky_radius`; `?combatRadii=off`
            // restores the 0.0 CPartArray-null fallback.
            if holtburger_world::spatial::USE_STICKY_MANAGER
                && let Some(w) = world.borrow_mut().as_mut()
                && w.player.guid != holtburger_common::Guid::NULL
                && data.guid == w.player.guid
            {
                if sticky_target != 0 {
                    let target =
                        holtburger_common::Guid(sticky_target);
                    let target_radius =
                        w.combat_sticky_radius(target);
                    w.scene.stick_local_player_to(
                        target,
                        target_radius,
                    );
                } else {
                    w.scene.unstick_local_player();
                }
            }
            // A2-P3 R2 (2026-06-12, W3+ S9 Stage R2;
            // ?stickyRetail=on) — REMOTE sticky install
            // from the SAME ride-along, on the S8
            // remote bodies. Retail sticks whatever
            // object the message addresses
            // (acclient.c:339546-339560); `0` ⇒ the
            // per-unpack preamble unstick subset
            // (:339518-339519). The JS F3-4 arms stay
            // untouched — ownership hands over per
            // sticky-flagged pollRemotePoses row
            // (drainRemotePoses clears the glue), so
            // every degrade case self-restores to the
            // glue path. Inert unless the full compose
            // rule holds (remote_sticky_on).
            if remote_sticky_on
                && let Some(w) = world.borrow_mut().as_mut()
                && w.player.guid != holtburger_common::Guid::NULL
                && data.guid != w.player.guid
            {
                if remote_sticky_target != 0 {
                    // Retail sticky keeps cylinder distance
                    // between the two BODIES (radius each,
                    // remote motion D6); same radius source
                    // as the local lane's `?combatRadii`.
                    let target = holtburger_common::Guid(remote_sticky_target);
                    let holder_radius = w.combat_part_dims(data.guid).0;
                    let target_radius = w.combat_sticky_radius(target);
                    w.scene.stick_remote_entity_to(
                        data.guid,
                        target,
                        holder_radius,
                        target_radius,
                    );
                } else {
                    w.scene.unstick_remote_entity(data.guid);
                }
            }
            // F3-5 (bughunt 2026-06-09) — per-creature run rate.
            // A MoveTo* envelope carries the mover's OWN run_rate
            // (`MoveToObject/MoveToPosition.run_rate`, ACE sets a
            // genuine per-creature rate on every chase —
            // Creature_Navigation.cs:300). Retail stores it into
            // that object's `motion_interpreter->my_run_rate` and
            // scales its gait from it (acclient.c:339571,343502).
            // We dropped it: the JS velScale path fed the LOCAL
            // player's run rate to EVERY remote rig, so a whole
            // field of mobs animated at YOUR tempo and changed
            // with YOUR buffs. Surface it on the spare `vx` field
            // (zeroed for KIND_MOTION; distinct from `motion_speed`
            // which stays the forward_speed/anim-framerate scalar)
            // so JS can stash a per-entity rate. `0` = no rate this
            // event (JS keeps the last / falls back to a neutral
            // 1.0 for non-local, NOT the local player's rate).
            let entity_run_rate: f32 = match &data.data {
                MovementTypeData::MoveToObject(m) => m.run_rate,
                MovementTypeData::MoveToPosition(m) => m.run_rate,
                _ => 0.0,
            }
            .max(0.0);
            if entity_run_rate > 0.0
                && let Some(w) = world.borrow_mut().as_mut()
            {
                w.scene.set_remote_run_rate(data.guid, entity_run_rate);
            }
            entity_updates.borrow_mut().push(EntityUpdate {
                kind: ENTITY_UPDATE_KIND_MOTION,
                guid: u32::from(data.guid),
                // F3-4: sticky target guid (0 = none/clear).
                // R3 moveto-1: the remote source — 0 for a
                // chase MoveToObject while the Rust pump sticks
                // on arrival (JS ignores the local guid).
                model_id: remote_sticky_target,
                landblock_id: 0,
                x: 0.0,
                y: 0.0,
                z: 0.0,
                qw: 1.0,
                qx: 0.0,
                qy: 0.0,
                qz: 0.0,
                wcid: 0,
                item_type: 0,
                name: String::new(),
                obj_scale: 0.0,
                icon_id: 0,
                palette_id: 0,
                mtable_id: 0,
                model_changes: Vec::new(),
                texture_changes: Vec::new(),
                sub_palettes: Vec::new(),
                placement_id: 0,
                portal_destination: String::new(),
                // F3-5: per-creature run rate (0 = none); JS
                // stashes it for the velScale gait tempo.
                vx: entity_run_rate,
                vy: 0.0,
                vz: 0.0,
                omega_z: 0.0,
                motion_command: u32::from(motion_command_u16),
                motion_stance: u32::from(data.current_style),
                physics_script_did: 0,
                sound_table_did: 0,
                obj_desc_flags: 0,
                weenie_flags: 0,
                // A1 (2026-05-29): per-motion playback speed
                // (`forward_speed`) → JS anim framerate scale.
                motion_speed: motion_speed_f32,
                physics_translucency: 0.0,
                is_autonomous: data.is_autonomous,
            });
            // F3-3 (bughunt 2026-06-09) — TurnTo execution. Both
            // TurnToHeading and TurnToObject carry an ABSOLUTE
            // target `desired_heading` (ACE pre-computes the
            // toward-target heading), so emit a KIND_TURN with the
            // heading as an AC z-up quaternion + the turn speed.
            // The JS heading-ease then slerps the rig to face it —
            // previously this envelope was decoded then dropped and
            // NPCs never turned to face the player. The KIND_MOTION
            // above (motion_command 0 for TurnTo) still carries the
            // stance; this is an additional event.
            let turn_directive: Option<(f32, f32)> = match &data.data {
                MovementTypeData::TurnToHeading(t) => {
                    Some((t.params.desired_heading, t.params.speed))
                }
                MovementTypeData::TurnToObject(t) => {
                    Some((t.desired_heading, t.params.speed))
                }
                _ => None,
            };
            if let Some((heading, turn_speed)) = turn_directive {
                let half = heading * 0.5;
                entity_updates.borrow_mut().push(EntityUpdate {
                    kind: ENTITY_UPDATE_KIND_TURN,
                    guid: u32::from(data.guid),
                    model_id: 0,
                    landblock_id: 0,
                    x: 0.0,
                    y: 0.0,
                    z: 0.0,
                    qw: half.cos(),
                    qx: 0.0,
                    qy: 0.0,
                    qz: half.sin(),
                    wcid: 0,
                    item_type: 0,
                    name: String::new(),
                    obj_scale: 0.0,
                    icon_id: 0,
                    palette_id: 0,
                    mtable_id: 0,
                    model_changes: Vec::new(),
                    texture_changes: Vec::new(),
                    sub_palettes: Vec::new(),
                    placement_id: 0,
                    portal_destination: String::new(),
                    vx: 0.0,
                    vy: 0.0,
                    vz: 0.0,
                    omega_z: turn_speed,
                    motion_command: 0,
                    motion_stance: 0,
                    physics_script_did: 0,
                    sound_table_did: 0,
                    obj_desc_flags: 0,
                    weenie_flags: 0,
                    motion_speed: 1.0,
                    physics_translucency: 0.0,
                    is_autonomous: false,
                });
            }
            // Wave 2 (2026-06-08) — MAIN-PATH action command.
            // The `commands` list carries the one-shot
            // Action-class command (creature attack swing B10,
            // local eat/drink B6, emote/gesture) that the
            // locomotion `motion_command` emit above DROPS
            // (`forward_command` and the action list are
            // independent slots on the wire). Surface the FIRST
            // (wire-order) Action-class command — §A6; already
            // EXPANDED to its full
            // 32-bit `MotionCommand` by the shared Wave-2 expander
            // (the MotionTable link inner key is the full value,
            // C3) — as a dedicated `KIND_MOTION_ACTION`
            // EntityUpdate. This is the SINGLE playback route for
            // it (C2): the JS arm plays it as a LoopOnce overlay
            // for EVERY guid, INCLUDING the local player, WITHOUT
            // carrying a locomotion command, so the local-gait
            // skip stays intact (C1). The extraction reuses the
            // canonical `EntityMotionSnapshot` so the wasm and
            // non-wasm (cli/TUI) paths agree byte-for-byte.
            let action_snapshot =
                holtburger_world::entity::EntityMotionSnapshot::from_movement_event(
                    &data,
                );
            // §A6: the snapshot's action is the HEAD of the wire
            // list, so a multi-scarab windup starts with scarab 1.
            let main_path_action = action_snapshot
                .and_then(|s| s.action_command.map(|cmd| (cmd, s)));
            // 15-bit stamp-dedup: only emit when this action's
            // sequence is NEWER than the last one played for this
            // guid, so a re-broadcast UpdateMotion doesn't restart
            // the swing/eat clip. An action with no sequence
            // (shouldn't happen — the snapshot pairs them) emits.
            //
            // Bug 2 (2026-10-07): the snapshot's sequence comes from one of
            // TWO unrelated counters — a command-list action carries its own
            // per-item motion stamp (retail `server_action_stamp`,
            // acclient.c:344388-344418), while a forward-slot action (eat /
            // drink, ACE's non-PK windups) is stamped with the broadcast's
            // `movement_sequence`. One table for both compared one counter
            // against the other, so after any forward-slot action a later
            // command-list action (a PK caster's windup run, a recall
            // gesture) could be judged "older" and dropped. Each source now
            // has its own table.
            let action_from_commands = matches!(
                &data.data,
                holtburger_protocol::messages::movement::MovementTypeData::Invalid(inv)
                    if inv.state.commands.iter().any(|item| {
                        holtburger_world::player::expand_motion_command_low16(item.command.raw())
                            .is_some_and(holtburger_world::player::is_action_motion_command)
                    })
            );
            let action_is_new = match &main_path_action {
                Some((_, snap)) => match snap.action_sequence {
                    Some(seq) => {
                        let check = |m: &std::cell::RefCell<std::collections::HashMap<u32, u16>>| {
                            let mut m = m.borrow_mut();
                            let guid_key = u32::from(data.guid);
                            let fresh = m
                                .get(&guid_key)
                                .map(|&prev| {
                                    holtburger_common::sequence::is_newer_u16(seq, prev)
                                })
                                .unwrap_or(true);
                            if fresh {
                                m.insert(guid_key, seq);
                            }
                            fresh
                        };
                        if action_from_commands {
                            MOTION_ACTION_STAMPS.with(check)
                        } else {
                            MOTION_FORWARD_ACTION_STAMPS.with(check)
                        }
                    }
                    None => true,
                },
                None => false,
            };
            if let Some((action_cmd, snap)) =
                main_path_action.filter(|_| action_is_new)
            {
                let action_speed = snap
                    .action_speed
                    .map(|s| s.to_f32())
                    .filter(|s| s.is_finite() && *s > 0.0)
                    .unwrap_or(1.0);
                entity_updates.borrow_mut().push(EntityUpdate {
                    kind: ENTITY_UPDATE_KIND_MOTION_ACTION,
                    guid: u32::from(data.guid),
                    model_id: 0,
                    landblock_id: 0,
                    x: 0.0,
                    y: 0.0,
                    z: 0.0,
                    qw: 1.0,
                    qx: 0.0,
                    qy: 0.0,
                    qz: 0.0,
                    wcid: 0,
                    item_type: 0,
                    name: String::new(),
                    obj_scale: 0.0,
                    icon_id: 0,
                    palette_id: 0,
                    mtable_id: 0,
                    model_changes: Vec::new(),
                    texture_changes: Vec::new(),
                    sub_palettes: Vec::new(),
                    placement_id: 0,
                    portal_destination: String::new(),
                    vx: 0.0,
                    vy: 0.0,
                    vz: 0.0,
                    omega_z: 0.0,
                    // C3: full 32-bit command, no masking.
                    motion_command: action_cmd,
                    motion_stance: u32::from(data.current_style),
                    physics_script_did: 0,
                    sound_table_did: 0,
                    obj_desc_flags: 0,
                    weenie_flags: 0,
                    motion_speed: action_speed,
                    physics_translucency: 0.0,
                    is_autonomous: false,
                });
            }
            // Multi-action queue (2026-06-06, approach B):
            // surface the Action-class `commands` Vec
            // (emotes/gestures) the single `motion_command` emit
            // above DROPS, so JS can FIFO-play them with
            // stamp-dedup. Only the Invalid (autonomous) envelope
            // carries `InterpretedMotionState.commands`. The
            // `len() > 1` log is the reachability probe (does
            // vanilla ACE ever pack >=2?).
            //
            // Wave 2 (2026-06-08, C2): the main-path Action-class
            // command already plays via `KIND_MOTION_ACTION`
            // above, so SKIP it here — otherwise the
            // side-channel (when `?multiAction=on`) and the main
            // path would double-play the same swing/eat. That
            // item is identified by its 15-bit sequence.
            // Remaining items keep their WIRE order (§A6 — the
            // multi-scarab windup run), and are appended to the
            // FIFO the JS drain reads after the entity drain.
            #[cfg(target_arch = "wasm32")]
            {
                if let MovementTypeData::Invalid(inv) = &data.data {
                    let actions = &inv.state.commands;
                    if DIAG_VERBOSE && actions.len() > 1 {
                        console_log_str(&format!(
                            "[multi-action] guid=0x{:08X} commands={} (>=2 reachable)",
                            u32::from(data.guid),
                            actions.len(),
                        ));
                    }
                    let rows = motion_action_queue_rows(
                        actions,
                        main_path_action.as_ref().and_then(|(_, s)| s.action_sequence),
                        u32::from(data.guid),
                        u32::from(data.current_style),
                    );
                    if !rows.is_empty() {
                        MOTION_ACTIONS.with(|q| {
                            q.borrow_mut().extend_from_slice(&rows);
                        });
                    }
                    // Casting-ingredient axes: surface the remote
                    // sidestep + turn axes the forward_command emit
                    // above drops (strafe-cast footwork + turn-in-
                    // place cycle). 5 u32: [guid, stance,
                    // sidestep_low, turn_low, forward_idle].
                    let side_cmd = inv
                        .state
                        .sidestep_command
                        .map(|c| u32::from(c.raw()))
                        .unwrap_or(0);
                    let turn_cmd = inv
                        .state
                        .turn_command
                        .map(|c| u32::from(c.raw()))
                        .unwrap_or(0);
                    if side_cmd != 0 || turn_cmd != 0 {
                        let guid = u32::from(data.guid);
                        let stance = u32::from(data.current_style);
                        let forward_idle =
                            u32::from(inv.state.forward_command.is_none());
                        MOTION_AXES.with(|q| {
                            q.borrow_mut().extend_from_slice(&[
                                guid,
                                stance,
                                side_cmd,
                                turn_cmd,
                                forward_idle,
                            ]);
                        });
                    }
                }
            }
            }
        }
        GameMessage::VectorUpdate(data) => {
            // Remote-airborne heuristic. ACE
            // broadcasts VectorUpdate immediately after
            // a player jumps (Player.cs:954
            // `EnqueueBroadcast(new GameMessageVectorUpdate(this))`)
            // with the jump velocity, and again on the
            // physics-state change when motion settles
            // back to ~zero vertical velocity. A
            // simple |vz| threshold turns that into a
            // grounded↔airborne signal for the JS-side
            // jump pose. Skips the local player
            // (authoritative state already wired in the
            // Jump cmd / TickMovement arms).
            //
            // Threshold is conservative — walking on
            // terrain produces vz ≈ 0; even up/down a
            // slope wouldn't reach 1.0 m/s vertical.
            let remote_guid = u32::from(data.guid);
            let local_guid = world.borrow().as_ref()
                .map(|w| u32::from(w.player.guid))
                .unwrap_or(0);
            // OpenAC comparison 2026-10-04 (remote motion D7, critic wave 1
            // issue 2): when the remote body flies its own arc, the
            // airborne edges come from that body's leave-ground / hit-ground
            // (retail CMotionInterp::LeaveGround / HitGround,
            // acclient.c:344457 / :344429), drained by the tick
            // (`take_remote_airborne_changes`). The |vz| edge below never
            // grounded a jumper: ACE sends no VectorUpdate on landing (only
            // Player.cs:954 at the jump), so the arms-up pose stuck.
            let arc_owned = remote_guid != local_guid
                && remote_guid != 0
                && world.borrow_mut().as_mut().is_some_and(|w| {
                    if !w.scene.remote_jump_arc_active() {
                        return false;
                    }
                    // The routed world handler ran the vector-stamp gate
                    // (DoVectorUpdate :143459-143470); it stored the
                    // velocity only when it accepted the frame.
                    let wire = data.velocity.finite_or_zero();
                    // `calc_acceleration` gravity needs GRAVITY_PS (0x400,
                    // acclient.c:317787) — the arc only flies for such a body.
                    let accepted = w
                        .entities
                        .get(data.guid)
                        .filter(|e| e.velocity == wire)
                        .map(|e| {
                            e.physics_state
                                .contains(holtburger_common::properties::PhysicsState::GRAVITY)
                        });
                    if let Some(gravity) = accepted {
                        w.scene.remote_vector_update(data.guid, wire, gravity);
                    }
                    true
                });
            if !arc_owned && remote_guid != local_guid && remote_guid != 0 {
                const VZ_THRESHOLD: f32 = 1.0;
                let now_airborne = data.velocity.z.abs() > VZ_THRESHOLD;
                let fire = REMOTE_AIRBORNE_STATE.with(|m| {
                    let mut s = m.borrow_mut();
                    let was = *s.get(&remote_guid).unwrap_or(&false);
                    if was != now_airborne {
                        s.insert(remote_guid, now_airborne);
                        true
                    } else {
                        false
                    }
                });
                if fire {
                    queued_events.borrow_mut().push(ClientEvent {
                        kind: CLIENT_EVENT_KIND_ENTITY_AIRBORNE_CHANGED,
                        string_payload: None,
                        u32_payload: Some(remote_guid),
                        u32_payload_2: Some(
                            if now_airborne { 1 } else { 0 },
                        ),
                        f32_payload: None,
                    });
                }
            }
            // Velocity-extrapolation polish: ACE
            // broadcasts VectorUpdate whenever an
            // entity's physics state changes
            // (start/stop walking, change direction).
            // The recv loop dropped these in the
            // catch-all arm pre-this commit; surfacing
            // them as kind=4 EntityUpdate lets JS
            // extrapolate sprite position past the
            // catch-up lerp so motion stays smooth
            // across the ~100-300 ms gap between
            // PublicUpdatePosition echoes.
            //
            // Position fields are zeroed — only
            // (guid, vx/y/z, omega_z) carry data on
            // kind=4. JS reads via the velocity
            // getters and stores `velX/Y/UpdatedMs`
            // on the entityMap entry.
            entity_updates.borrow_mut().push(EntityUpdate {
                kind: ENTITY_UPDATE_KIND_VELOCITY,
                guid: u32::from(data.guid),
                model_id: 0,
                landblock_id: 0,
                x: 0.0,
                y: 0.0,
                z: 0.0,
                qw: 1.0,
                qx: 0.0,
                qy: 0.0,
                qz: 0.0,
                wcid: 0,
                item_type: 0,
                name: String::new(),
                obj_scale: 0.0,
                icon_id: 0,
                palette_id: 0,
                mtable_id: 0,
                model_changes: Vec::new(),
                texture_changes: Vec::new(),
                sub_palettes: Vec::new(),
                placement_id: 0,
                portal_destination: String::new(),
                vx: data.velocity.x,
                vy: data.velocity.y,
                vz: data.velocity.z,
                // AC is z-up; entity rotation is
                // yaw-only (one quat axis), so the
                // x/y omega components are dropped
                // — only the z-axis angular velocity
                // matters for the top-down renderer.
                omega_z: data.omega.z,
                motion_command: 0,
                motion_stance: 0,
                physics_script_did: 0,
                sound_table_did: 0,
                obj_desc_flags: 0,
                weenie_flags: 0,
                // A1 (2026-05-29): non-MOTION updates carry no
                // playback speed — identity (no anim scaling).
                motion_speed: 1.0,
                physics_translucency: 0.0,
                is_autonomous: false,
            });
        }
        _ => unreachable!("GameMessage routed to the wrong handler module"),
    }
    LoopFlow::Continue
}
