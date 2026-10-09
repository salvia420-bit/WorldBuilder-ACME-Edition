//! `SessionCommand` arms: Local-player movement: terrain feed, jump charge,
//! MoveTo/pursuit/sticky, autorun, raw input, the per-frame TickMovement
//! integrator step, and the lifestone/allegiance-hometown recalls.
//!
//! Moved verbatim from the `recv_loop` command `select!` arm (2026-10-05
//! split); see `session::commands::handle_command` for the routing.

use crate::*;
use crate::session::{LoopCtx, LoopFlags, LoopFlow};

/// Minimum spacing of `collision_scene` shadow refreshes (see the
/// TickMovement arm).
const SHADOW_REFRESH_MIN_INTERVAL: std::time::Duration = std::time::Duration::from_millis(100);

thread_local! {
    /// When the TickMovement arm last refreshed the `collision_scene` shadow.
    static SHADOW_REFRESHED_AT: std::cell::Cell<Option<web_time::Instant>> =
        const { std::cell::Cell::new(None) };
}

pub(super) async fn handle(ctx: &mut LoopCtx, cmd: SessionCommand) -> LoopFlow {
    let LoopFlags {
        unified_tick_on,
        maint_prune_on,
        pose_publish_post_tick_on,
        remote_interp_on,
        ..
    } = ctx.flags;
    let LoopCtx {
        session,
        queued_events,
        entity_updates,
        cell_scene_snapshot,
        local_player_pose,
        local_player_can_jump,
        local_player_jump_charge_level,
        local_player_pursuit_status,
        collision_scene,
        world,
        movement,
        tick_spine,
        entity_seeded,
        last_diag_force_seq,
        local_player_spawn_emitted,
        last_local_player_position_emit,
        js_spawned_guids,
        ..
    } = &mut *ctx;
    match cmd {
        SessionCommand::PopulateTerrain {
            landblock_id,
            heights,
            terrain_codes,
        } => {
            // Install the 81-float height grid into the
            // world's terrain cache. Used by the manual-
            // drive integrator to snap pose Z to terrain
            // (no client-side cliff/wall collision yet —
            // just terrain following so heartbeats carry
            // a Z that ACE physics doesn't interpret as
            // "player floating above ground").
            let mut world_guard = world.borrow_mut();
            let Some(w) = world_guard.as_mut() else {
                console_log_str(
                    "[terrain] PopulateTerrain before WorldState ready — dropping",
                );
                return LoopFlow::Continue;
            };
            // Length pre-validated by SessionHandle::populate_terrain
            // but recheck defensively for the array-indexed
            // try_into below.
            let arr: [f32; 81] = match heights.try_into() {
                Ok(a) => a,
                Err(_) => {
                    console_log_str(
                        "[terrain] PopulateTerrain heights length != 81; dropping",
                    );
                    return LoopFlow::Continue;
                }
            };
            w.populate_terrain_heights(landblock_id, arr);
            // Phase D / WS8 (2026-06-28): mirror the 9x9 height grid
            // into the spatial scene. The WorldState copy above feeds
            // the approximate heightfield path; THIS copy is what the
            // faithful OUTDOOR path reads — the ring/dispatch gate on
            // `scene.terrain_landblock_resident` (faithful_bridge.rs)
            // and the land-cell triangles are built on demand from
            // `scene.terrain_cell_heights` (WS2/WS3). `arr` is `[f32;
            // 81]` (Copy), so reusing it here is a copy, not a move.
            w.scene.populate_terrain_heights(landblock_id, arr);
            // NOTE: no overlap-bake enqueue here — the outdoor static
            // populate path is the sole enqueuer, and the drain's
            // retain-retry keeps a statics-before-terrain landblock
            // queued until these heights make it terrain-resident, so
            // a terrain-first load still bakes once the statics drain.
            // F4-4: cache per-vertex water flags from the terrain
            // type codes (no-op when not 81 — fail-soft).
            w.populate_terrain_water(landblock_id, &terrain_codes);
            // Phase E3.6 (2026-06-29): feed the SAME terrain-type codes
            // into the spatial scene so the FAITHFUL outdoor path
            // classifies per-cell water (build_outdoor_cell →
            // SceneObjCell water_type/get_water_depth). The WorldState
            // copy above only feeds the legacy ?faithfulOutdoor=off
            // path; the faithful (default-on) path reads the scene.
            // Fail-soft when not 81 (mirrors populate_terrain_water).
            if let Ok(codes) = <[u8; 81]>::try_from(terrain_codes.as_slice()) {
                w.scene.populate_terrain_water_codes(landblock_id, codes);
            }
            console_log_str(&format!(
                "[terrain] populated landblock 0x{landblock_id:08X} ({} cached total)",
                w.terrain_height_cache_len(),
            ));
        }
        SessionCommand::RecallAllegianceHometown => {
            use holtburger_protocol::messages::{
                GameAction, RecallAllegianceHometownActionData,
            };
            let action = GameAction::RecallAllegianceHometown(Box::new(
                RecallAllegianceHometownActionData {},
            ));
            send_or_disconnect!(
                queued_events,
                e,
                send_ordered!(movement, session, action),
                "recv_loop: send_action(RecallAllegianceHometown): {e}",
                "recall_allegiance_hometown: {e}",
                LoopFlow::Exit
            );
            console_log_str("[allegiance/recall]");
        }
        // === Wave 6.B / Agent 6.B — Lifestone bind/recall UI (2026-05-28) ===
        SessionCommand::TeleToLifestone => {
            use holtburger_protocol::messages::{
                GameAction, TeleToLifestoneActionData,
            };
            let action = GameAction::TeleToLifestone(Box::new(
                TeleToLifestoneActionData,
            ));
            send_or_disconnect!(
                queued_events,
                e,
                send_ordered!(movement, session, action),
                "recv_loop: send_action(TeleToLifestone): {e}",
                "tele_to_lifestone: {e}",
                LoopFlow::Exit
            );
            console_log_str("[lifestone/recall]");
        }
        SessionCommand::JumpChargeBegin => {
            // G-7 / F1-6 — set the standstill charge. JS already
            // verified no movement keys are held; re-check
            // grounded so a mid-air space press can't root the
            // landing.
            if let Some(w) = world.borrow_mut().as_mut()
                && *entity_seeded
                && !w.player.is_airborne
            {
                w.player.standing_long_jump_charge = true;
            }
        }
        SessionCommand::JumpChargeCancel => {
            if let Some(w) = world.borrow_mut().as_mut() {
                w.player.standing_long_jump_charge = false;
            }
        }
        SessionCommand::JumpChargeCommence => {
            // A14-I4 (W3+ S11, ?jumpParity=on) — press-time
            // half: arm the movement-crate charge clock
            // (retail CommenceJump, acclient.c:408033-408078).
            // The standstill root is decided wasm-side from
            // the active manual drive's axes. A press-time
            // refusal surfaces as chat-scroll text via the
            // JUMP_REFUSED event (retail
            // acclient.c:408050-408059); the legacy arms
            // above stay byte-untouched.
            if let Some(w) = world.borrow_mut().as_mut()
                && *entity_seeded
                && let Err(code) =
                    movement.jump_charge_commence(web_time::Instant::now(), w)
            {
                queued_events.borrow_mut().push(ClientEvent {
                    kind: CLIENT_EVENT_KIND_JUMP_REFUSED,
                    string_payload: None,
                    u32_payload: Some(code as u32),
                    u32_payload_2: None,
                    f32_payload: None,
                });
            }
        }
        SessionCommand::JumpChargeRelease => {
            // A14-I4 — release-time half: the whole legacy
            // Jump-arm pipeline (gates → vz/stamina →
            // begin_jump → pack → send) MOVED into
            // `MovementSystem::execute_jump_release`, with
            // the pack built by `movement/common.rs::
            // build_jump` (the A13 single-builder boundary).
            use holtburger_core::JumpOutcome;
            let mut world_guard = world.borrow_mut();
            let Some(w) = world_guard.as_mut() else {
                console_log_str(
                    "[jumpParity] release before WorldState ready — dropping",
                );
                return LoopFlow::Continue;
            };
            if !*entity_seeded {
                console_log_str(
                    "[jumpParity] release before player entity seeded — dropping",
                );
                return LoopFlow::Continue;
            }
            match movement
                .execute_jump_release(web_time::Instant::now(), w, &mut *session)
                .await
            {
                Ok(JumpOutcome::NotCharging) => {}
                Ok(JumpOutcome::Refused(code)) => {
                    // Retail release-time scroll text
                    // (acclient.c:408193-408203).
                    queued_events.borrow_mut().push(ClientEvent {
                        kind: CLIENT_EVENT_KIND_JUMP_REFUSED,
                        string_payload: None,
                        u32_payload: Some(code as u32),
                        u32_payload_2: None,
                        f32_payload: None,
                    });
                }
                Ok(JumpOutcome::Jumped {
                    extent: _,
                    vz,
                    jump_skill,
                    burden,
                }) => {
                    // Keep the legacy `[jump]` console-log
                    // shape so diagnostics stay greppable.
                    console_log_str(&format!(
                        "[jump] skill={jump_skill} burden={burden:.2} → vz={vz:.2} m/s",
                    ));
                }
                Err(e) => {
                    // Send failure — mirror the legacy Jump
                    // arm's disconnect handling.
                    log::warn!("recv_loop: execute_jump_release: {e}");
                    queued_events.borrow_mut().push(ClientEvent {
                        kind: CLIENT_EVENT_KIND_DISCONNECTED,
                        string_payload: Some(format!("jump: {e}")),
                        u32_payload: None,
                        u32_payload_2: None,
                        f32_payload: None,
                    });
                    return LoopFlow::Exit;
                }
            }
        }
        SessionCommand::JumpChargeAbort => {
            // A14-I4 — blur analog (retail FinishJump,
            // acclient.c:435853-435863): drop the charge +
            // standstill root without jumping.
            if let Some(w) = world.borrow_mut().as_mut() {
                movement.jump_charge_abort(w);
            }
        }
        SessionCommand::PursueObject {
            target_guid,
            object_radius,
            object_height,
            run,
        } => {
            // A14-I2 (W3+ S10, ?wasmPursuit=on) — input-lane
            // MoveToObject entry (retail PerformMovement case
            // 6, acclient.c:346129-346131). Same WorldState /
            // player-seeded guards as SetMovementInput; the
            // intent is applied (and the manager preamble
            // CancelMoveTo(0x36) runs) on the next
            // TickMovement.
            if world.borrow().is_none() || !*entity_seeded {
                console_log_str(
                    "[wasmPursuit] PursueObject before player seeded — dropping",
                );
                return LoopFlow::Continue;
            }
            movement.enqueue_drive_intent(
                holtburger_core::client::movement_types::PlayerDriveIntent::PursueObject {
                    target: holtburger_common::Guid(target_guid),
                    object_radius,
                    object_height,
                    run,
                },
                web_time::Instant::now(),
            );
            // Optimistic ACTIVE so a JS poll between this arm
            // and the next tick's publish can't read a stale
            // completion from a previous pursuit.
            *local_player_pursuit_status.borrow_mut() = 1;
        }
        SessionCommand::MoveToPosition {
            landblock_id,
            x,
            y,
            z,
            run,
        } => {
            // rynth Phase-1 — input-lane MoveToPosition
            // (retail PerformMovement case 7,
            // acclient.c:346133-346135). Same WorldState /
            // player-seeded guards as PursueObject.
            if world.borrow().is_none() || !*entity_seeded {
                console_log_str(
                    "[rynth] MoveToPosition before player seeded — dropping",
                );
                return LoopFlow::Continue;
            }
            movement.enqueue_drive_intent(
                holtburger_core::client::movement_types::PlayerDriveIntent::MoveToPosition {
                    cell_id: holtburger_common::Guid(landblock_id),
                    position: holtburger_common::math::Vector3::new(x, y, z),
                    run,
                },
                web_time::Instant::now(),
            );
            // Optimistic ACTIVE — same latch rationale as
            // the PursueObject arm.
            *local_player_pursuit_status.borrow_mut() = 1;
        }
        SessionCommand::PursuitTurnToObject { target_guid } => {
            // A14-I2 — TurnToObject (retail case 8,
            // acclient.c:346137-346139).
            if world.borrow().is_none() || !*entity_seeded {
                console_log_str(
                    "[wasmPursuit] TurnToObject before player seeded — dropping",
                );
                return LoopFlow::Continue;
            }
            movement.enqueue_drive_intent(
                holtburger_core::client::movement_types::PlayerDriveIntent::TurnToObject {
                    target: holtburger_common::Guid(target_guid),
                },
                web_time::Instant::now(),
            );
            *local_player_pursuit_status.borrow_mut() = 1;
        }
        SessionCommand::PursuitTurnToHeading { heading } => {
            // A14-I2 — TurnToHeading (retail case 9,
            // acclient.c:346141-346143). RADIANS here;
            // degrees at the core ingest boundary.
            if world.borrow().is_none() || !*entity_seeded {
                console_log_str(
                    "[wasmPursuit] TurnToHeading before player seeded — dropping",
                );
                return LoopFlow::Continue;
            }
            movement.enqueue_drive_intent(
                holtburger_core::client::movement_types::PlayerDriveIntent::TurnToHeading {
                    heading,
                },
                web_time::Instant::now(),
            );
            *local_player_pursuit_status.borrow_mut() = 1;
        }
        SessionCommand::SetAutoRun { on } => {
            // A14-I3 (?retailRunKeys=on) — retail SetAutoRun
            // (acclient.c:718254-718292): flip the movement
            // crate's auto_run + re-apply movement. The
            // "AutoRun ON/OFF" notice is printed JS-side at
            // the keydown site (retail ECM_UI::SendNotice,
            // :718270-718287). No world/seed guard needed —
            // the state is pure movement-crate bookkeeping
            // and the drive only emits once ticks run.
            movement.set_auto_run(on);
        }
        SessionCommand::NoteLocalCastWindow { active } => {
            // WS04 (?castHoldReclaim) — the JS cast chain's local
            // cast-window signal. Pure movement-crate bookkeeping
            // (the forward lock reads it in the use_time reclaim);
            // no world/seed guard needed.
            movement.note_local_cast_window(active);
        }
        SessionCommand::IngestMotionLengths { mtable_id } => {
            // P13/P16-H2 — authored one-shot lengths for the
            // completion-clock shim (variant doc above). The
            // table is in the source cache by construction
            // (the local player's spawn bake prefetched it);
            // a cache miss just logs and keeps the 2.0 s
            // fallback — never an error path.
            match global_source::try_global_source() {
                Some(source) => {
                    let entries = resolve_authored_motion_lengths(
                        source.as_ref(),
                        mtable_id,
                    );
                    if entries.is_empty() {
                        console_log_str(&format!(
                            "[mtlen] 0x{mtable_id:08X}: no from-Ready link lengths resolved — keeping 2.0s fallback",
                        ));
                    } else {
                        console_log_str(&format!(
                            "[mtlen] 0x{mtable_id:08X}: ingested {} authored one-shot lengths",
                            entries.len(),
                        ));
                        movement.ingest_authored_motion_lengths(&entries);
                    }
                }
                None => console_log_str(
                    "[mtlen] resource source not ready — keeping 2.0s fallback",
                ),
            }
        }
        SessionCommand::CancelPursuit => {
            // A14-I2 — abort (retail CancelMoveTo(0x36)).
            // The failure latch (3 | 0x36<<16) publishes on
            // the next tick; the JS caller initiated the
            // cancel and stops polling regardless.
            movement.enqueue_drive_intent(
                holtburger_core::client::movement_types::PlayerDriveIntent::CancelPursuit,
                web_time::Instant::now(),
            );
        }
        SessionCommand::StickToObject { target_guid } => {
            // 2026-07-06 — client melee = engage the LOCAL
            // StickyManager on the target. Once armed, the
            // per-frame `step_local_sticky` (system.rs) runs the
            // player UP to it (closing the 0.30 EDGE gap) and holds
            // + re-faces it — approach + stick as one.
            // COMBAT-RADII (2026-07-28): the target radius is
            // retail's `CPartArray::GetRadius` (`setup->radius *
            // scale.z`, acclient.c:325382-325384) resolved by
            // `combat_sticky_radius`, so the standoff is
            // `my_radius + target_radius + 0.3` — outside the
            // model. `?combatRadii=off` restores the old 0.0 pair
            // (0.3 m from the target's CENTRE). Needs the target
            // resident in the spatial scene (worldLifecycle
            // default-on).
            if let Some(w) = world.borrow_mut().as_mut() {
                if w.player.guid != holtburger_common::Guid::NULL {
                    let target = holtburger_common::Guid(target_guid);
                    let target_radius = w.combat_sticky_radius(target);
                    w.scene.stick_local_player_to(target, target_radius);
                } else {
                    console_log_str(
                        "[sticky-melee] stickToEntity before player seeded — dropping",
                    );
                }
            }
        }
        SessionCommand::StopStick => {
            // 2026-07-06 — release the LOCAL StickyManager.
            if let Some(w) = world.borrow_mut().as_mut() {
                w.scene.unstick_local_player();
            }
        }
        SessionCommand::AnimationDone { guid, success } => {
            // A4-Q2 (W3+ S5) + A4/SA4F (per-entity feed) —
            // renderer overlay-completion signal, routed
            // PER-GUID (retail per-OBJECT chain, no local
            // filter: AnimDoneHook::Execute targets one
            // object's own MotionTableManager,
            // acclient.c:342336-342338 → :317087 →
            // :325080-325086 → :329873; the former local-guid
            // drop was a staging artifact, retired by SA4F).
            // `is_local` keeps the landed local-instance route
            // (USE_MOTION_TABLE_QUEUE-gated + S9 unstick
            // bubble); non-local guids reach their registry
            // MovementManager — map-miss no-op (despawn-
            // pruned), inert unless a default-off lane created
            // the manager. Spec OQ-5 ordering note: this
            // command arrives on the same FIFO cmd channel as
            // TickMovement, but the two are SENT from two
            // independent rAF callbacks (index.html's
            // drainEvents loop sends TickMovement; the scene3d
            // loop's `entityManager.tick` fires the notify), so
            // a completion may be pumped the tick after the
            // visual clip end — ≤1 rAF skew, accepted (spec §5
            // risk 4, now per-entity; retail drains same-frame
            // via process_hooks, acclient.c:320035).
            // Empty-queue notifies no-op on both routes
            // (acclient.c:329884 head-null guard).
            if let Some(w) = world.borrow().as_ref()
                && *entity_seeded
            {
                let is_local = w.player.guid.0 == guid;
                movement.notify_animation_done_for(
                    holtburger_common::Guid(guid),
                    is_local,
                    success,
                );
            }
        }
        SessionCommand::Jump { power } => {
            // Mirror ACE's jump pipeline:
            //   1. Compute upward velocity via
            //      MovementSystem.GetJumpHeight + sqrt(h*19.6)
            //      using current Jump skill + default burden +
            //      power=1.0.
            //   2. Stamp ballistic state on world.player.
            //   3. Send GameAction::Jump (opcode 0xF61B) wire
            //      packet so ACE accepts the airborne pose
            //      and applies stamina cost.
            //
            // Wire shape: JumpActionData {
            //   extent, velocity, sequences x4, object_guid, spell_id
            // }. See ACE Network/Structure/JumpPack.cs.
            use holtburger_protocol::messages::{
                GameAction, movement::actions::JumpActionData,
            };
            use holtburger_common::Vector3;
            let mut world_guard = world.borrow_mut();
            let Some(w) = world_guard.as_mut() else {
                console_log_str(
                    "[jump] before WorldState ready — dropping",
                );
                return LoopFlow::Continue;
            };
            if !*entity_seeded {
                console_log_str(
                    "[jump] before player entity seeded — dropping",
                );
                return LoopFlow::Continue;
            }
            if w.player.is_airborne {
                // ACE doesn't permit double-jumps.
                return LoopFlow::Continue;
            }
            // Wave 10 Phase 10.2 (2026-05-26) — PhatSDK
            // `CMotionInterp::motion_allows_jump`
            // (`external/GDL/PhatSDK/MovementManager.cpp:
            // 427-438`) blocks jumps from interactive /
            // held-pose / cast-windup substates. Without
            // this gate, the wasm fires
            // `GameAction::Jump` and ACE rejects it with
            // `WeenieError::YouCantJumpFromThisPosition
            // = 0x0048`, but the JS spacebar handler has
            // already called `em.setAirborne(true)` for
            // the local-prediction arms-up overlay
            // (Wave 1.7). The result is a visible desync
            // until the next server reconciliation
            // (typically 200-500 ms).
            //
            // Gating the wire send here keeps wasm in
            // lockstep with retail and lets us suppress
            // the JS-side overlay via a wasm getter
            // (deferred follow-on — for now the JS
            // optimistically fires the overlay and the
            // next `kind=18` touchdown signal would
            // clear it; the substate check at least
            // stops the wire-packet/server-response
            // mismatch).
            if !holtburger_world::player::motion_allows_jump(
                w.player.current_substate,
            ) {
                if DIAG_VERBOSE {
                    console_log_str(&format!(
                        "[jump] blocked by motion_allows_jump (substate=0x{:08X}) — mirrors retail \"You can't jump from this position.\"",
                        w.player.current_substate,
                    ));
                }
                return LoopFlow::Continue;
            }
            // Burden, skill, and stamina are pulled live.
            // Burden flows from ACE's
            // `EncumbranceSystem.GetBurden(encumbrance,
            // capacity)` via holtburger's
            // `WorldContextExt::player_burden` (capacity is
            // 150*Str + 30*Str*augs, burden = enc/cap).
            // Fallback 0.5 keeps BurdenMod = 1.0 (ACE's
            // `< 1.0` branch) when the player hasn't
            // hydrated attributes yet.
            use holtburger_common::stats::SkillType;
            use holtburger_world::context::WorldContextExt;
            let jump_skill = w
                .player
                .skills
                .get(&SkillType::Jump)
                .map(|s| s.current as u32)
                .unwrap_or(100);
            let burden = w.player_burden().unwrap_or(0.5);
            // Clamp the JS-supplied power to the wire-valid
            // range. ACE's HandleActionJump already clamps
            // server-side via `Math.Clamp(jump.Extent, 0, 1)`
            // but we mirror it client-side so the local
            // stamina deduction matches what ACE will compute.
            let power: f32 = power.clamp(0.0, 1.0);
            // Stamina cost (ACE non-PK formula —
            // `MovementSystem.JumpStaminaCost`). PK gate
            // requires reading `PKTimerActive`, which we
            // don't track yet; default to non-PK.
            let cost = holtburger_world::player::PlayerState::jump_stamina_cost(
                power, burden, false,
            );
            // Gate on stamina availability — ACE's
            // `HandleActionJump` has a commented-out
            // adjust-power branch; the active behavior
            // is "if no stamina, jumpSkill is treated as
            // 0 in InqJumpVelocity → min-clamp 0.35m
            // hop". Reproduce that fallback so an
            // exhausted player still pops a tiny jump.
            let stamina_current = w
                .player
                .vitals
                .get(&holtburger_common::stats::VitalType::Stamina)
                .map(|v| v.current)
                .unwrap_or(0);
            let exhausted = stamina_current == 0;
            let effective_skill = if exhausted { 0 } else { jump_skill };
            let vz = holtburger_world::player::PlayerState::compute_jump_velocity_z(
                power, burden, effective_skill,
            );
            // G-7 / F1-6 — capture the charge BEFORE begin_jump
            // consumes it; the launch-velocity choice below keys
            // off it.
            let charged_long_jump = w.player.standing_long_jump_charge;
            w.player.begin_jump(vz);
            // Wave 1 Phase 1.2 (2026-05-26) deleted the
            // JS-side `kind=18 EntityAirborneChanged`
            // handler at `index.html:8469-8485` — it was
            // the visual airborne tween (paused mixer +
            // arms-spread overlay) that froze the real
            // Jump clip at frame 0. The Jump clip is now
            // dispatched locally from the JS keyup handler
            // at `index.html:7755` via
            // `em.setMotion(localGuid, JUMP_MOTION_CMD,
            // stance)`, so the kind=18 emit here is no
            // longer load-bearing for any visual effect.
            // Wave 5 Phase 5.1 (2026-05-26) replaces the
            // remaining kind=18 emissions with EntityUpdate
            // motion-commands (Falling / Fallen) in the
            // TickMovement diff arm below. The Jump arm
            // does NOT need a wasm-side motion emit — JS
            // already handles it for the local player.
            // Deduct stamina locally (server is canonical;
            // ACE will broadcast a vital update soon after).
            // `vital_id = 3` is VitalType::Stamina per
            // holtburger-common/stats.rs.
            if !exhausted {
                let new_current =
                    (stamina_current as i32 - cost as i32).max(0) as u32;
                w.player.update_vital_current(
                    holtburger_common::stats::VitalType::Stamina as u32,
                    new_current,
                    &mut Vec::new(),
                );
            }
            // Read sequences + player guid + current pose
            // for the wire packet. ACE validates these in
            // HandleActionJump (Player.cs:866).
            let player_guid = w.player.guid;
            let instance_sequence = w.player.instance_sequence;
            let server_control_sequence = w.player.server_control_sequence;
            let teleport_sequence = w.player.teleport_sequence;
            let force_position_sequence = w.player.force_position_sequence;
            // G-7 / F1-6 — standing long jump: while the charge
            // rooted the integrator, the planar store is ~0; the
            // retail launch velocity is the interpreted INTENT
            // (`get_leave_ground_velocity = get_state_velocity()`)
            // — what the held keys at release WOULD produce. Note
            // begin_jump (above) already consumed the charge
            // flag, so we captured `charged` before it ran; it
            // also deliberately leaves current_planar_velocity
            // untouched, so install the intent there for the
            // airborne trajectory lock.
            let lateral_velocity = if charged_long_jump
                && let Some(intent_v) =
                    movement.charged_jump_launch_velocity(w)
            {
                w.player.current_planar_velocity =
                    Vector3::new(intent_v.x, intent_v.y, 0.0);
                Vector3::new(intent_v.x, intent_v.y, vz)
            } else {
                w.local_player_runtime_kinematics()
                    .map(|(_, v, _)| Vector3::new(v.x, v.y, vz))
                    .unwrap_or(Vector3::new(0.0, 0.0, vz))
            };
            drop(world_guard);
            let action = GameAction::Jump(Box::new(JumpActionData {
                extent: power,
                velocity: lateral_velocity,
                instance_sequence,
                server_control_sequence,
                teleport_sequence,
                force_position_sequence,
                object_guid: player_guid,
                spell_id: 0,
            }));
            send_or_disconnect!(
                queued_events,
                e,
                send_ordered!(movement, session, action),
                "recv_loop: send_action(Jump): {e}",
                "jump: {e}",
                LoopFlow::Exit
            );
            console_log_str(&format!(
                "[jump] skill={jump_skill} burden={burden:.2} → vz={vz:.2} m/s",
            ));
        }
        SessionCommand::SetMovementInput {
            forward,
            strafe,
            turn,
            run,
        } => {
            // Phase 4 step 3.6: input → high-level
            // MotionState → MovementSystemHandle drive
            // intent. The actual outbound packet (MoveToState
            // and/or AutonomousPosition heartbeat) fires from
            // the next TickMovement arm via
            // `MovementSystemHandle::tick`. Pre-3.6 the recv
            // loop built MoveToState here directly and never
            // sent AutonomousPosition — the bug fixed by 3.6.
            let world_guard = world.borrow();
            let Some(w) = world_guard.as_ref() else {
                console_log_str(
                    "[step 3.6] SetMovementInput before WorldState ready — dropping",
                );
                return LoopFlow::Continue;
            };
            if !*entity_seeded {
                console_log_str(
                    "[step 3.6] SetMovementInput before player entity seeded — dropping",
                );
                return LoopFlow::Continue;
            }
            let _ = w;
            let motion_state = motion_state_for_input(forward, strafe, turn, run);
            let now = web_time::Instant::now();
            movement.enqueue_drive_intent(
                holtburger_core::client::movement_types::PlayerDriveIntent::ManualHeld(
                    motion_state,
                ),
                now,
            );
            if DIAG_VERBOSE {
                console_log_str(&format!(
                    "[step3.6-trace] enqueue_drive_intent ManualHeld(forward={forward} strafe={strafe} turn={turn} run={run})",
                ));
            }
        }
        SessionCommand::KeyAction { action, down } => {
            // Wave-1 step 4 — the `?cmdInterp=on` interpreter
            // lane: same readiness guards as SetMovementInput
            // (the interpreter needs an in-world player).
            if world.borrow().is_none() || !*entity_seeded {
                console_log_str(
                    "[cmdInterp] KeyAction before world/player ready — dropping",
                );
                return LoopFlow::Continue;
            }
            movement.enqueue_key_action(action, down);
        }
        SessionCommand::TickMovement { now } => {
            // Phase 4 step 3.6: pumps the cli's
            // MovementSystem state machine. Reads
            // queued drive intents (from SetMovementInput),
            // emits MoveToState on motion-state edges, and
            // emits AutonomousPosition heartbeats while the
            // player is moving — the load-bearing fix
            // making server-side player position actually
            // advance. Pre-EnteredWorld / pre-entity-seeded
            // ticks are no-ops (nothing to read poses from).
            let mut world_guard = world.borrow_mut();
            let Some(w) = world_guard.as_mut() else { return LoopFlow::Continue };
            if !*entity_seeded {
                return LoopFlow::Continue;
            }
            // Drain pending SetupModel collision radii
            // queued by `fetch_entity_model_render`. Runs
            // before the integrator tick so the next
            // `entity_collision_radius` query for any
            // entity referencing this setup sees the real
            // cyl-sphere radius (ACE
            // `PhysicsObj.GetPhysicsRadius`) instead of
            // the PLAYER_CAPSULE_RADIUS fallback.
            let _drained_radii = drain_pending_setup_radii_into(w);
            // Objects in the transition: the full CSetup cylsphere / sphere
            // lists, same parse, same cadence.
            let _drained_shapes = crate::drain_pending_setup_shapes_into(&mut w.scene);
            // COMBAT-RADII (2026-07-28): same cadence for
            // the raw CPartArray `(radius, height)` dims the
            // sticky standoff + MoveTo cylinder metric read.
            let _drained_part_dims = drain_pending_setup_part_dims_into(w);
            // COL-03 (2026-07-27): same cadence for the
            // precise per-SetupModel physics geometry the
            // entity BSP arm sweeps. Drain first so a walk
            // that finished since the last tick is live for
            // this tick's clamp, then claim any newly
            // arrived HAS_PHYSICS_BSP entities.
            let drained_bsps =
                drain_pending_setup_physics_geometry_into(w);
            if drained_bsps > 0 {
                console_log_str(&format!(
                    "[col03] {drained_bsps} SetupModel physics geometr\
                     {} resident ({} total) — entity BSP arm live",
                    if drained_bsps == 1 { "y" } else { "ies" },
                    w.setup_physics_geometry_len()
                ));
            }
            kick_entity_physics_geometry_loads(w);
            // Phase 6 collision-leak fix (2026-05-29): purge any
            // landblocks the JS LRU just evicted BEFORE the
            // insert-drains below, so an evict+re-enter in the same
            // window REPLACES rather than appends (the cell/building
            // inserts are append-only). LRU `evict` enqueues via
            // `enqueueClearLandblockCollision`. clear_cells_* purges
            // portal edges/AABBs/triangles/polygons;
            // clear_building_aabbs_* purges building AABBs + origins
            // + building-interior physics triangles.
            let purged_lbs = LANDBLOCK_CLEAR_PENDING.with(|c| {
                let mut buf = c.borrow_mut();
                let n = buf.len();
                if n > 0 {
                    // P5/R-12 (2026-07-10): ONE batched clear for
                    // the whole drain — one Arc-COW clone + one
                    // retain scan per table regardless of how many
                    // LBs this tick evicted (the sealed purge's
                    // first-burst tick can carry 100+; the per-LB
                    // forms paid a full clone-eligible scan each).
                    // Covers the same four families the per-LB
                    // loop did: cells (portal graph/AABBs/physics/
                    // BSPs/membership/polygons), building AABBs +
                    // origins + interior physics, static AABBs
                    // (Track B4), static physics BSPs (B4 Tier-2)
                    // — all append-only, so evict+re-enter must
                    // REPLACE rather than append.
                    let lbs: Vec<u32> = buf.drain(..).collect();
                    let _ = w.scene.clear_landblocks_collision(&lbs);
                }
                n
            });
            if purged_lbs > 0 {
                console_log_str(&format!(
                    "[phase6.U] purged collision for {purged_lbs} evicted \
                     landblock(s) (graph now {} cells, {} cell AABBs, \
                     {} building AABBs)",
                    w.scene.cell_portal_graph_len(),
                    w.scene.cell_aabb_count(),
                    w.scene.building_aabb_count(),
                ));
            }
            // Phase 6 step B follow-up: drain any
            // building-AABB inserts queued by JS-side
            // `populateBuildingAabbsForLandblock` calls.
            // Runs before the integrator tick so the
            // first sweep against new AABBs sees them.
            let drained = drain_pending_building_aabbs_into(&mut w.scene);
            if drained > 0 {
                console_log_str(&format!(
                    "[phase6.B] drained {drained} pending building AABBs into scene \
                     (total now {} across all cells)",
                    w.scene.building_aabb_count(),
                ));
            }
            // Track B4 outdoor-static collision (Tier 1,
            // 2026-06-08): drain any static-AABB inserts
            // queued by JS-side
            // `populateStaticsAabbsForLandblock` calls.
            // Same cadence/justification as the building-AABB
            // drain — runs before the integrator tick so the
            // first static clamp against new AABBs sees them.
            let drained_statics = drain_pending_static_aabbs_into(&mut w.scene);
            if drained_statics > 0 {
                console_log_str(&format!(
                    "[b4] drained {drained_statics} pending static AABBs into scene \
                     (total now {} across all landblocks)",
                    w.scene.static_aabb_count(),
                ));
            }
            // B4 Tier-2 (2026-06-09): drain the per-static
            // physics-BSP inserts queued alongside the AABBs.
            // Same cadence; consulted only when USE_STATIC_BSP
            // is on, so this is inert-but-present by default.
            // Collision round 3 (F6): building BSPs go to the same table,
            // tagged as buildings (`insert_building_physics_bsp`).
            let drained_static_bsps = drain_pending_static_bsps_into(&mut w.scene)
                + crate::drain_pending_building_bsps_into(&mut w.scene);
            if drained_static_bsps > 0 {
                console_log_str(&format!(
                    "[b4t2] drained {drained_static_bsps} pending static physics BSPs \
                     (total now {} across all landblocks)",
                    w.scene.static_physics_bsp_count(),
                ));
            }
            // DAT-01 phase 2c (2026-07-27): drain the baked
            // procedural-scenery collider batches queued by
            // `populateSceneryCollidersForLandblock`. Same
            // cadence + ordering rationale as the two drains
            // above (after the LANDBLOCK_CLEAR purge, before the
            // integrator tick). Consulted only when
            // USE_SCENERY_COLLISION is on, so this is
            // inert-but-present by default — and reads 0 on the
            // shipped pre-V3 `dist/scenery/`.
            let drained_scenery =
                drain_pending_scenery_colliders_into(&mut w.scene);
            if drained_scenery > 0 {
                console_log_str(&format!(
                    "[dat01] drained {drained_scenery} scenery colliders \
                     (total now {} across {} landblock(s))",
                    w.scene.scenery_collider_count(),
                    w.scene.scenery_collider_landblock_count(),
                ));
            }
            // Phase 6 step E follow-up (2026-05-09): drain
            // any pending building-origin entries queued by
            // the same `populateBuildingAabbsForLandblock`
            // call. Origins are needed by the ObjectCreate
            // door-registration arm to project a
            // `(BuildingId, part_index)` hit back into the
            // JS-side `buildingMap` key.
            // Collision F1: building portal lists from the same pass.
            let _ = crate::drain_pending_building_portals_into(&mut w.scene);
            // landdefs-terrain-2: the same pass's restriction tables.
            let _ = crate::drain_pending_landblock_restrictions_into(&mut w.scene);
            let drained_origins =
                drain_pending_building_origins_into(&mut w.scene);
            if drained_origins > 0 {
                console_log_str(&format!(
                    "[phase6.E] drained {drained_origins} pending building origins"
                ));
            }
            // Phase 6 step D: drain pending cell-graph
            // edges + cell AABBs from
            // `fetchEnvCellsInLandblock`. Same cadence as
            // the building-AABB drain so the per-frame
            // visibility query immediately after a
            // landblock load can pick up fresh cells.
            let (drained_portals, drained_visible, drained_aabbs) =
                drain_pending_cell_graph_into(&mut w.scene);
            if drained_portals > 0
                || drained_visible > 0
                || drained_aabbs > 0
            {
                // PORTAL-GRAPH-SPLIT (2026-08-11): the two edge
                // classes are counted apart, and the line reports
                // BOTH graph sizes — `adjacency <= union` is the
                // invariant, and the gap is how much pure
                // visibility the union carries.
                console_log_str(&format!(
                    "[phase6.D] drained {drained_portals} portal edges + \
                     {drained_visible} PVS edges + \
                     {drained_aabbs} cell AABBs into scene (union now {} cells, \
                     adjacency {} cells, {} cell AABBs)",
                    w.scene.cell_portal_graph_len(),
                    w.scene.cell_adjacency_len(),
                    w.scene.cell_aabb_count(),
                ));
            }
            // 2026-05-10 indoor collision (Phase 6 step G
            // follow-on): drain `physics_polygons`
            // triangles into `scene.cell_physics_index`
            // so the integrator's indoor branch can
            // immediately read them. Same cadence as the
            // cell-graph drain — triangles and AABBs
            // share the EnvCell's lifetime.
            let drained_tris =
                drain_pending_cell_physics_into(&mut w.scene);
            if drained_tris > 0 {
                console_log_str(&format!(
                    "[phase6.G] drained {drained_tris} cell physics triangles into scene ({} cells with physics)",
                    w.scene.cell_physics_count(),
                ));
            }
            // BSP collision (PASS 1, 2026-06-02): drain the
            // parsed physics-BSP trees into
            // `scene.cell_physics_bsp`. Same cadence as the
            // flat-tri drain above; the integrator reads
            // them only when `USE_PHYSICS_BSP` is on
            // (DEFAULT-OFF), but the data lands regardless so
            // the `?bspCollide=on` path is a pure runtime
            // switch.
            let drained_bsp =
                drain_pending_cell_bsp_into(&mut w.scene);
            if drained_bsp > 0 {
                console_log_str(&format!(
                    "[bsp] drained {drained_bsp} cell physics BSP trees into scene ({} cells with BSP)",
                    w.scene.cell_physics_bsp_count(),
                ));
            }
            // Phase C (2026-06-28): drain per-cell STATIC object
            // physics BSPs so the faithful driver's
            // find_obj_collisions can stop the player at static
            // walls/doors. Same cadence as the cell-env BSP drain.
            let drained_static_cell_bsp =
                drain_pending_cell_static_bsps_into(&mut w.scene);
            if drained_static_cell_bsp > 0 {
                console_log_str(&format!(
                    "[bsp] drained {drained_static_cell_bsp} cell STATIC physics BSPs into scene ({} total)",
                    w.scene.cell_static_physics_bsp_count(),
                ));
            }
            // Phase D / WS8 (2026-06-28, Option C live feed): the
            // OUTDOOR twin of the indoor cell-STATIC drain above. For
            // each landblock whose terrain + outdoor statics have now
            // landed, bake each static's physics BSP into every land
            // cell its AABB overlaps (the off-center-building fix).
            // Runs AFTER the b4t2 static-BSP drain so the bake reads
            // this landblock's statics from scene.statics_physics_bsp
            // the same tick they arrive; both feed the SAME
            // scene.cell_static_physics_bsp table the indoor drain
            // feeds. This is the headless-boot confirmation the
            // outdoor populate fired.
            let (outdoor_lbs_baked, outdoor_static_regs) =
                drain_pending_outdoor_overlap_bakes_into(&mut w.scene);
            if outdoor_lbs_baked > 0 {
                console_log_str(&format!(
                    "[bsp] baked {outdoor_static_regs} outdoor cell STATIC physics BSPs \
                     across {outdoor_lbs_baked} landblock(s) ({} total)",
                    w.scene.cell_static_physics_bsp_count(),
                ));
            }
            // COL-27 (2026-07-28): the INDOOR twin. Runs AFTER the
            // cell-AABB drain (above) and the indoor static drain so
            // the bake sees every envcell volume of the landblock
            // whose statics just landed. Fixes statics whose geometry
            // spills out of the cell they are authored in — the
            // Holtburg Meeting Hall staircase walk-through.
            let (envcell_lbs_baked, envcell_static_regs) =
                drain_pending_envcell_overlap_bakes_into(&mut w.scene);
            if envcell_lbs_baked > 0 {
                console_log_str(&format!(
                    "[bsp] baked {envcell_static_regs} envcell STATIC physics BSP \
                     registrations across {envcell_lbs_baked} landblock(s) ({} total)",
                    w.scene.cell_static_physics_bsp_count(),
                ));
            }
            // Terrain→EnvCell entry (2026-06-02): drain the
            // cell-membership trees so the local indoor-flip
            // probe sees them the same tick.
            let drained_membership =
                drain_pending_cell_membership_into(&mut w.scene);
            if drained_membership > 0 {
                console_log_str(&format!(
                    "[envcell-entry] drained {drained_membership} cell membership trees into scene ({} cells with membership)",
                    w.scene.cell_membership_count(),
                ));
            }
            // Workstream C (3D camera collision,
            // 2026-05-11): drain `physics_polygons` from
            // building parts (GfxObj.physics_polygons) into
            // `scene.building_physics_index`. This is the
            // BUILDING-side parallel of the cell-physics
            // drain — building interiors (incl. basements)
            // live in the building's setup parts and were
            // missing collision coverage pre-C; the camera
            // sweep against `sweep_sphere_against_building_-
            // mesh` reads this index.
            let drained_building_tris =
                drain_pending_building_physics_into(&mut w.scene);
            if drained_building_tris > 0 {
                console_log_str(&format!(
                    "[wsC] drained {drained_building_tris} building physics triangles into scene ({} landblocks, {} total tris)",
                    w.scene.building_physics_count(),
                    w.scene.building_triangles_total(),
                ));
            }
            // Phase 6 step D: publish a snapshot of the
            // local player's current cell + render set
            // so the rAF tick can synchronously query it
            // via `getCurrentCellId` / `getRenderSet`.
            // Runs after the cell-graph drain so the
            // first frame after a landblock load shows
            // a coherent visible-cell set.
            //
            // A1-O2 (2026-06-11, unification survey): under
            // `?posePublishPostTick=on` this trio of shadow
            // publishes moves to AFTER the integrator tick
            // (see the post-tick block below) — retail fires
            // `SmartBox::PlayerPhysicsUpdatedCallback`
            // immediately AFTER the player's `update_object`
            // (acclient.c:311375-311378), so the camera/rig
            // read a same-frame pose instead of one ≥1 tick
            // stale. Flag OFF = this pre-tick site, the
            // historical order, byte-identical.
            if !pose_publish_post_tick_on {
                publish_cell_scene_snapshot(w, &cell_scene_snapshot);

                // Workstream A (3D camera/game-feel fix):
                // publish the local player's pose into the
                // shared cell so JS can read it synchronously
                // via `SessionHandle::get_local_player_pose`.
                // Same cadence as the cell-scene snapshot
                // (every TickMovement) — the JS camera reads
                // this on every rAF tick to keep follow logic
                // smooth without rebroadcasting through the
                // entity_updates queue. Pre-spawn the pose is
                // `None`; post-spawn it stays `Some` and the
                // recv-loop overwrites in place.
                publish_local_player_pose(w, &local_player_pose);

                // Wave 10 Phase 10.4 (2026-05-26): refresh the
                // `can_jump_now` shadow alongside the pose. JS
                // spacebar keyup polls this before firing the
                // local-prediction arms-up overlay so blocked
                // releases don't flash. Same cadence/justification
                // as the pose shadow above.
                publish_local_player_can_jump(w, &local_player_can_jump);

                // A14-I4 (W3+ S11): refresh the jump-charge
                // clock shadow (retail GetJumpPowerLevel —
                // the UI reads, never owns,
                // acclient.c:402173). Same cadence family
                // as the can-jump shadow above; 0.0 when no
                // charge is pending, so flag-off it just
                // re-writes 0.0.
                *local_player_jump_charge_level.borrow_mut() =
                    movement.jump_charge_level(now, w);
            }

            // Workstream C (3D camera collision,
            // 2026-05-11): refresh the JS-readable shadow
            // of the SpatialScene (incl. its Arc-shared
            // terrain heights) so
            // `cameraSweepCollision` / `terrainHeightAt`
            // and friends see fresh indices the next time
            // JS calls them.
            // `collision_view` (not `clone`): every shadow reader uses
            // only the Arc-shared geometry, so the per-entity maps, sampled
            // bodies and remote-motion state are left out instead of being
            // deep-copied every frame.
            //
            // At most every SHADOW_REFRESH_MIN_INTERVAL (2026-10-07): the
            // shadow holds a second reference to every geometry `Arc`, so the
            // FIRST `Arc::make_mut` on a table after each refresh deep-clones
            // the whole table (all resident cells' triangles, polygons, PVS
            // lists…). Refreshing every tick made that a full-table copy on
            // EVERY streaming drain tick; now it is at most one per table per
            // interval. The camera / viewer-cell readers see geometry at most
            // that stale — imperceptible for a collision clamp.
            let shadow_due = SHADOW_REFRESHED_AT.with(|c| {
                c.get().is_none_or(|t| now.saturating_duration_since(t) >= SHADOW_REFRESH_MIN_INTERVAL)
            });
            if shadow_due {
                *collision_scene.borrow_mut() = w.scene.collision_view();
                SHADOW_REFRESHED_AT.with(|c| c.set(Some(now)));
            }

            // ORACLE open defect #1 (2026-08-12): publish the
            // augmentation trace. UNCONDITIONAL (not gated on
            // `?moveTelemetry=1`) because the transition happens in
            // the login window, before any capture flag has been
            // read — but it re-serializes ONLY when the trace grew,
            // so the steady-state cost is a length compare. The
            // trace is capped at `AUG_TRACE_CAP` in the world crate,
            // so this cannot grow without bound.
            #[cfg(target_arch = "wasm32")]
            {
                let trace = w.aug_trace();
                let grew = LATEST_AUG_TRACE_LEN
                    .with(|c| c.get() != trace.len());
                if grew {
                    LATEST_AUG_TRACE_LEN.with(|c| c.set(trace.len()));
                    let rows: Vec<serde_json::Value> = trace
                        .iter()
                        .map(|e| {
                            serde_json::json!({
                                "seq": e.seq,
                                "site": e.site,
                                "before": e.before,
                                "after": e.after,
                                "entityBefore": e.entity_before,
                                "entityAfter": e.entity_after,
                                "stash": e.stash,
                            })
                        })
                        .collect();
                    LATEST_AUG_TRACE_JSON.with(|c| {
                        *c.borrow_mut() = serde_json::to_string(&rows)
                            .unwrap_or_else(|_| "[]".to_string())
                    });
                }
            }

            // Workstream A (3D camera/game-feel fix): fan
            // out the local player's authoritative pose to
            // JS at ≤30 Hz as a KIND_POSITION EntityUpdate.
            // Pre-A the only local-player KIND_POSITION was
            // ACE's ~1Hz UpdatePosition broadcast — too
            // coarse for the 3D camera's 60 FPS prediction
            // layer. The integrator updates the local
            // runtime body pose every tick; we surface it
            // here at the throttled 30 Hz cadence so the
            // JS-side `__lastEntityWorldPos` updates
            // smoothly and the camera follow tracks without
            // 1-second jumps. Read `local_player_runtime_pose`
            // (not `player_position`) so the fan-out matches
            // the heartbeat trace + the camera's prediction
            // layer; the runtime pose is what the integrator
            // simulated against this tick. Gated on
            // `local_player_spawn_emitted` so we don't emit
            // a KIND_POSITION before the JS side has seen
            // the KIND_SPAWN that built the entity entry
            // (the spawn handler stamps `lastPosX/Y/T` at
            // the same time as the entry insert; without it
            // the position handler's first lookup misses
            // and silently drops the update).
            if *local_player_spawn_emitted
                && let Some(pose) = w.local_player_runtime_pose()
                && pose.landblock_id != holtburger_common::Guid::NULL
            {
                // 30 Hz = one emit per ≥ 33.3 ms. Compare
                // wall-clock against the last emit instant;
                // if enough time has elapsed (or this is the
                // first emit), enqueue the update + reset
                // the clock. `web_time::Instant::now()` is
                // already in scope as the TickMovement arm's
                // `now` parameter.
                let throttle_ok = match *last_local_player_position_emit {
                    Some(prev) => {
                        now.saturating_duration_since(prev)
                            >= std::time::Duration::from_millis(33)
                    }
                    None => true,
                };
                if throttle_ok {
                    *last_local_player_position_emit = Some(now);
                    entity_updates.borrow_mut().push(EntityUpdate {
                        kind: ENTITY_UPDATE_KIND_POSITION,
                        guid: u32::from(w.player.guid),
                        model_id: 0,
                        landblock_id: u32::from(pose.landblock_id),
                        x: pose.coords.x,
                        y: pose.coords.y,
                        z: pose.coords.z,
                        qw: pose.rotation.w,
                        qx: pose.rotation.x,
                        qy: pose.rotation.y,
                        qz: pose.rotation.z,
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
            // Watchdog: when real movement caps regress to
            // Err between PlayerDescription's clear-and-test
            // and now (e.g., a property update wiped the
            // Run skill, the MotionTable resolution failed
            // mid-session, etc.), the local-pose integrator
            // would no-op for this tick and the heartbeat
            // would send a stale pose. ACE keeps the
            // server-side player at last-confirmed pose →
            // when ACE next broadcasts an UpdatePosition,
            // the client snaps back to that stale pose,
            // visible to the user as rubberband.
            //
            // Live-test root cause (2026-05-08, /tmp/walk_diag3.cjs):
            // PlayerDescription logged real_caps_ok=true
            // but tick #60 read caps_ok=false. Some message
            // between clears the override-vs-real divergence;
            // bookkeeping fix is too speculative without
            // narrowing further. Defense-in-depth here: if
            // resolve fails AND no override is currently
            // set, install the same fallback caps the
            // bootstrap path uses, so the integrator keeps
            // advancing. Real biota wins again on the next
            // PlayerDescription (which clears the override
            // and re-tests).
            if w.resolve_self_movement_capabilities().is_err() {
                let fallback = fallback_self_movement_capabilities();
                w.set_self_movement_capabilities_override(fallback);
                // One-shot log per regression run — quieted
                // via a tick-count modulo so a sustained
                // regression doesn't spam the console.
                if movement.tick_count() % 60 == 0 {
                    console_log_str(
                        "[step 3.6 watchdog] caps_ok regressed to false at tick; \
                         re-installed fallback override to keep heartbeat advancing"
                    );
                }
            }
            // Pre-tick airborne snapshot; the diff after
            // movement.tick detects landing (the integrator
            // clears is_airborne when the player descends
            // past the floor while falling). Pair to the
            // grounded→airborne emit in the Jump arm above.
            //
            // Wave 5 Phase 5.1 (movement-animation overhaul,
            // 2026-05-26): also snapshot `is_jumping` so we
            // can route the right motion-command (Falling
            // for ledge walk-offs, suppressed for jumps) on
            // the rising edge, and emit a Land/Fallen
            // motion-command on touchdown so the renderer
            // plays the landing clip instead of just clearing
            // the airborne tween (the prior mechanism that
            // Wave 1 Phase 1.2 deleted).
            let was_airborne_pre_tick = w.player.is_airborne;
            let was_jumping_pre_tick = w.player.is_jumping;
            let player_guid_for_airborne = w.player.guid;
            // Capture stance up-front so the post-tick branch
            // doesn't have to re-borrow `w.player` while the
            // `&mut session` is held below.
            let pre_tick_stance: u32 = w
                .player
                .last_server_motion_style
                .map(|s| s as u32)
                // ACE MotionStance::NonCombat = 0x8000003D —
                // same default the renderer's setMotion
                // fallback uses at `entities.js:2603-2607`
                // when stance=0 arrives on the wire.
                .unwrap_or(0x8000_003D);
            // A1-O1 (2026-06-11, unification survey): gated
            // tick dispatch. Flag OFF (default) = the bare
            // `MovementSystemHandle::tick` this arm always
            // ran — byte-identical. `?unifiedTick=on` = the
            // CANONICAL spine (`tick_frame` = movement.tick →
            // world.tick → simulation.tick, the exact native
            // `ClientRuntime::run` order; retail single-spine
            // analog SmartBox::UseTime, acclient.c:146256),
            // closing survey A1 §3 row 1: the eviction sweep
            // (liveness.rs — the half A8-M1's KNOWN LIMIT
            // waits on; A8-M1 LANDED, so canonical
            // ObjectDelete marks now get SWEPT when both
            // flags are on) and the quantum-sliced spatial
            // solver run in-browser for the first time. The
            // handle's bespoke local-pose pre-integration is
            // skipped on-path — the local player advances
            // through the cli-canonical solver instead.
            // Spine-emitted WorldEvents feed the same solver
            // body-tracking law as native; the spine REPORTS
            // the frame's EntityDespawned guids (A8-M2) and
            // drops the rest, matching this arm's existing
            // `Ok(_events)` discard. Under `?maintPrune=on`
            // the reports become KIND_REMOVE rig events
            // below; otherwise they are dropped too —
            // byte-identical to pre-M2.
            let mut spine_despawned: Vec<holtburger_common::Guid> =
                Vec::new();
            let tick_result: anyhow::Result<()> = if unified_tick_on {
                tick_spine
                    .tick_frame(now, w, &mut *movement, &mut *session)
                    .await
                    .map(|despawned| {
                        spine_despawned = despawned;
                    })
            } else {
                movement
                    .tick(now, w, &mut *session)
                    .await
                    .map(|_events| ())
            };
            match tick_result {
                Ok(()) => {
                    // cmdInterp post-flip diag: mirror the
                    // local registry minterp's pending
                    // completion-node count for the
                    // `movementPendingMotionsDiag` export
                    // (live A/B assertion surface).
                    MOVEMENT_PENDING_MOTIONS_DIAG.store(
                        movement.local_registry_pending_motions(w.player.guid)
                            as u32,
                        std::sync::atomic::Ordering::Relaxed,
                    );
                    // WS16 diag: pack the autonomy latch +
                    // interpreter forward-slot occupancy for the
                    // cast surface (rides v6, no manifest bump).
                    CAST_ARBITRATION_DIAG.store(
                        movement.cast_arbitration_diag(w.player.guid),
                        std::sync::atomic::Ordering::Relaxed,
                    );
                    // ORACLE (?moveTelemetry=1): one JSONL record
                    // per tick — pose + integrator velocity read
                    // off the world, gait/hold-key/cast read off
                    // the movement system. Off by default; the
                    // whole block is skipped when the flag is
                    // clear, so the shipped lane pays one atomic
                    // load per tick and nothing else.
                    if move_telemetry_enabled() {
                        let pose = w.local_player_runtime_pose();
                        let vel = w.player.current_planar_velocity;
                        let tele = movement.movement_telemetry(w.player.guid);
                        let run_rate_provenance = {
                            use holtburger_world::context::{
                                WorldContext, WorldContextExt,
                            };
                            // ORACLE open defect #1 (2026-08-11):
                            // session 3 read `composed` at exactly
                            // the Run-105 rate on all 233 ticks
                            // while the login snapshot of the SAME
                            // struct reported the +5 augmentation.
                            // Four scalars could show the
                            // disagreement and not one input to it,
                            // so the whole `RunRateInputs` rides
                            // here now — including the two fields
                            // added for this defect,
                            // `aug_joat` (raw property read, null =
                            // absent from the bag) and
                            // `player_entity_present` (the bag
                            // itself: skills live on PlayerState
                            // and survive an entity the int
                            // properties do not).
                            let inputs = w.player_run_rate_inputs();
                            serde_json::json!({
                                "rate": w.player_run_rate(),
                                "server": w.get_player_server_run_rate(),
                                "composed": w.player_composed_run_rate(),
                                "latched": w.player.server_run_rate,
                                "run_skill_wire": inputs.run_skill_wire,
                                "run_skill_used": inputs.run_skill_used,
                                "aug_bonus": inputs.run_skill_aug_bonus,
                                "aug_joat": inputs.aug_joat,
                                "player_entity_present":
                                    inputs.player_entity_present,
                                "burden": inputs.burden,
                                "load_mod": inputs.load_mod,
                            })
                        };
                        let record = serde_json::json!({
                            "source": "holt",
                            // ms since the wasm epoch; the differ
                            // re-bases to the first-motion edge, so
                            // only the deltas matter.
                            "t": telemetry_ms(now),
                            "pos": pose.as_ref().map(|p| serde_json::json!({
                                "lb": format!("{:#010X}", p.landblock_id.0),
                                "x": p.coords.x,
                                "y": p.coords.y,
                                "z": p.coords.z,
                                "heading_deg": p.rotation.to_heading().to_degrees().rem_euclid(360.0),
                            })),
                            "vel": { "x": vel.x, "y": vel.y, "z": w.player.vertical_velocity },
                            "speed": (vel.x * vel.x + vel.y * vel.y).sqrt(),
                            "grounded": !w.player.is_airborne,
                            "airborne_secs": w.player.airborne_secs,
                            "is_jumping": w.player.is_jumping,
                            // Gait from the movement system's OWN
                            // `hold_run XOR UITogglesRun`
                            // derivation, never from a JS-side
                            // guess and never from the raw latch.
                            // ORACLE session 2 FIX: this used to
                            // read `hold_run` directly, which is
                            // the SHIFT latch — under
                            // run-by-default `hold_run=false` IS
                            // run, so the first parity report
                            // labelled a genuine run `"walk"`.
                            "gait": tele.effective_gait,
                            "cast": tele.cast_window_active,
                            // MOVE-RUNRATE-105 (2026-08-11) — the
                            // run-rate PROVENANCE, live, per tick.
                            //
                            // The `playerRunRateInputs` probe the
                            // driver reads at the END of a capture
                            // is a CACHE refreshed by
                            // `publish_player_stats_snapshot`, so
                            // it cannot answer "what did the
                            // integrator consume DURING the run"
                            // — and on the session-3 A/B it
                            // reported a composition the realized
                            // speed plainly disagreed with. These
                            // three read the world HERE, on the
                            // same tick as the pose above:
                            // `run_rate` is what
                            // `resolve_self_movement_capabilities`
                            // resolves this tick,
                            // `server_run_rate` is the wire latch
                            // (`null` until a RunForward self-echo
                            // lands, or under `?serverRunRate=off`),
                            // and `composed_run_rate` is the
                            // client-side fallback beside it.
                            "run_rate": run_rate_provenance,
                            "movement": tele,
                        });
                        if let Ok(line) = serde_json::to_string(&record) {
                            move_telemetry_push(line);
                        }
                    }
                    // Wave-1 step 5 (?cmdInterp=on, rows
                    // 12-13): forward the interpreter lane's
                    // event stream to JS — kind 61 for the
                    // renderer consumers (anim-break cut /
                    // sidestep overlay / Q3 reclaim
                    // instrumentation), the EXISTING kind-56
                    // toast for jump refusals. The stream is
                    // empty while the flag is off (zero
                    // allocation on the legacy lane).
                    for interp_event in movement.take_cmd_interp_events() {
                        use holtburger_core::CmdInterpEvent;
                        let (kind, p1, p2) = match interp_event {
                            CmdInterpEvent::JumpRefused(code) => {
                                (CLIENT_EVENT_KIND_JUMP_REFUSED, code, None)
                            }
                            CmdInterpEvent::ForwardSlotEvicted => {
                                (CLIENT_EVENT_KIND_CMD_INTERP, 1, None)
                            }
                            CmdInterpEvent::ControlReclaimed { via_use_time } => {
                                let slot = if via_use_time {
                                    &RECLAIMS_USE_TIME_DIAG
                                } else {
                                    &RECLAIMS_EDGE_DIAG
                                };
                                slot.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                                (
                                    CLIENT_EVENT_KIND_CMD_INTERP,
                                    2,
                                    Some(u32::from(via_use_time)),
                                )
                            }
                            CmdInterpEvent::DriveApplied {
                                forward,
                                side,
                                turn,
                                run,
                            } => {
                                let packed = ((forward + 1) as u32)
                                    | (((side + 1) as u32) << 8)
                                    | (((turn + 1) as u32) << 16)
                                    | ((run as u32) << 24);
                                (CLIENT_EVENT_KIND_CMD_INTERP, 3, Some(packed))
                            }
                        };
                        queued_events.borrow_mut().push(ClientEvent {
                            kind,
                            string_payload: None,
                            u32_payload: Some(p1),
                            u32_payload_2: p2,
                            f32_payload: None,
                        });
                    }
                    // A8-M2 (2026-06-11, unification survey):
                    // translate the maint sweep's despawns
                    // into KIND_REMOVE — retail's 25 s
                    // out-of-visibility destruction
                    // (`AddObjectToBeDestroyed` +25.0 s,
                    // acclient.c:310651-310672, drained by
                    // `CObjectMaint::UseTime`
                    // acclient.c:310246-310278) finally
                    // reaches the web renderer (survey A8 §3
                    // row 2: rigs persisted all session). The
                    // live-rig ledger gates the emission:
                    // `js_spawned_guids.remove` is true only
                    // for guids whose KIND_SPAWN went out and
                    // whose KIND_REMOVE hasn't — so sweeps of
                    // rig-less entities (inventory hydrates)
                    // emit nothing, and explicit deletes
                    // already removed by the wire-data
                    // ObjectDelete/PickupEvent arms aren't
                    // double-removed. Re-entry pop-in is
                    // retail-correct: the server re-sends
                    // ObjectCreate when the object comes back
                    // into range (fresh KIND_SPAWN), same as
                    // retail re-creating a destroyed object.
                    if maint_prune_on {
                        for guid in &spine_despawned {
                            let guid_u32 = u32::from(*guid);
                            if !js_spawned_guids.remove(&guid_u32) {
                                continue;
                            }
                            entity_updates.borrow_mut().push(EntityUpdate {
                                kind: ENTITY_UPDATE_KIND_REMOVE,
                                guid: guid_u32,
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
                                motion_speed: 1.0,
                                physics_translucency: 0.0,
                                is_autonomous: false,
                            });
                        }
                    }
                    // A1-O2 (2026-06-11, unification survey):
                    // post-tick shadow publish — the retail
                    // callback order. acclient.c:311371-311378:
                    // `CPhysics::UseTime` iterates
                    // `update_object` per object and fires
                    // `SmartBox::PlayerPhysicsUpdatedCallback`
                    // IMMEDIATELY after the player's own
                    // update, so consumers see the pose the
                    // same frame it was integrated. The
                    // pre-tick site above (flag off) published
                    // the PREVIOUS tick's pose — a structural
                    // late-by-one-frame source (survey A1 §3
                    // row 2). Same three publishes, same
                    // relative order; only the position vs
                    // the integrator tick changes. The drains
                    // stay pre-tick (they FEED the
                    // integrator, correctly).
                    if pose_publish_post_tick_on {
                        publish_cell_scene_snapshot(
                            w,
                            &cell_scene_snapshot,
                        );
                        publish_local_player_pose(w, &local_player_pose);
                        publish_local_player_can_jump(
                            w,
                            &local_player_can_jump,
                        );
                        // A14-I4: post-tick twin of the
                        // jump-charge shadow publish (A1-O2
                        // ordering — exactly one of the two
                        // sites runs per tick).
                        *local_player_jump_charge_level.borrow_mut() =
                            movement.jump_charge_level(now, w);
                    }
                    // A14-I2 (W3+ S10): publish the pursuit
                    // status shadow — UNCONDITIONAL per tick
                    // (both tick paths, either pose-publish
                    // site). ACTIVE(1) overwrites; a fresh
                    // completion (low 16 ≥ 2, consumed from
                    // the read-clear core latch) LATCHES in
                    // the cell until the JS getter reads it;
                    // idle only clears a stale ACTIVE so an
                    // unread completion survives slow rAF
                    // polls. Cheap no-op (one HashMap probe)
                    // without a pursuit.
                    {
                        let status = movement.pursuit_status(w);
                        let mut cell =
                            local_player_pursuit_status.borrow_mut();
                        if status != 0 {
                            *cell = status;
                        } else if *cell == 1 {
                            *cell = 0;
                        }
                    }
                    // (2026-10-07): the local rig's share of this
                    // tick's autonomous drive (server TurnTo /
                    // MoveTo) — read per frame by frame_pump.js.
                    LOCAL_RIG_AUTONOMOUS_MOTION
                        .with(|c| c.set(movement.local_rig_motion_packed()));
                    LOCAL_CAST_MOVE_LOCK
                        .with(|c| c.set(movement.cast_move_lock_holding()));
                    // A2-P2 (2026-06-12, W3+ S8): publish the
                    // remote poses the spine's manager step
                    // produced THIS tick — post-tick by
                    // construction (same slot family as the
                    // A1-O2 publishes above; retail publishes
                    // pose after update_object,
                    // acclient.c:311375-311378). Sparse: only
                    // bodies whose manager stepped this frame.
                    // Flag off → the ledger is always empty
                    // and this is a cheap take of an empty
                    // map.
                    if remote_interp_on {
                        let rows = w.scene.take_remote_stepped_poses();
                        // A2-P3 R2: per-row sticky flags
                        // ride the same frame (empty set —
                        // all-zero flags — unless the
                        // stickyRetail compose rule armed
                        // the scene switch).
                        let sticky = w.scene.take_remote_sticky_stepped();
                        let frame = flatten_remote_pose_rows(&rows, &sticky);
                        REMOTE_POSES.with(|c| {
                            *c.borrow_mut() = frame;
                        });
                        // OpenAC comparison 2026-10-04 (remote
                        // motion D7): the remote bodies' own
                        // leave-ground / hit-ground edges this tick
                        // (retail LeaveGround / HitGround,
                        // acclient.c:344457 / :344429) drive the JS
                        // airborne pose — set AND cleared.
                        for (guid, airborne) in w.scene.take_remote_airborne_changes() {
                            queued_events.borrow_mut().push(ClientEvent {
                                kind: CLIENT_EVENT_KIND_ENTITY_AIRBORNE_CHANGED,
                                string_payload: None,
                                u32_payload: Some(u32::from(guid)),
                                u32_payload_2: Some(u32::from(airborne)),
                                f32_payload: None,
                            });
                        }
                        // R3 moveto-4 (2026-10-08 follow-ups): the
                        // remote MoveToManager node-motion edges this
                        // tick (turn-in-place / walk / run / stop) —
                        // retail's remote animation follows the node
                        // (`MoveToManager::_DoMotion`, acclient.c:344753).
                        // JS `applyRemoteMoveToPhase` plays them
                        // (`?remoteMoveToPhase=off` ignores them).
                        for (guid, motion) in w.scene.take_remote_moveto_phase_changes() {
                            queued_events.borrow_mut().push(ClientEvent {
                                kind: CLIENT_EVENT_KIND_REMOTE_MOVETO_PHASE,
                                string_payload: None,
                                u32_payload: Some(u32::from(guid)),
                                u32_payload_2: Some(motion),
                                f32_payload: None,
                            });
                        }
                    }
                    // A2-P3 (W3+ S9): publish the local
                    // sticky target for the diag getter —
                    // post-tick (timeout clears land the
                    // same frame). Always 0 with
                    // USE_STICKY_MANAGER off.
                    if holtburger_world::spatial::USE_STICKY_MANAGER {
                        let sticky = w
                            .scene
                            .local_sticky_target()
                            .map(u32::from)
                            .unwrap_or(0);
                        LOCAL_STICKY_TARGET.with(|c| c.set(sticky));
                    }
                    // CREATURE-SEPARATION (2026-07-28):
                    // republish the per-SetupModel collision
                    // radius table when residency CHANGED.
                    // The cache only grows as creature rigs
                    // stream in, so a `len` compare is a
                    // sound (and free) change detector; the
                    // steady state costs one usize compare
                    // per tick and allocates nothing.
                    {
                        let live = w.setup_collision_radii_len();
                        if CREATURE_SEPARATION_PUBLISHED_LEN
                            .with(|c| c.get())
                            != live
                        {
                            let mut ids = Vec::with_capacity(live);
                            let mut radii = Vec::with_capacity(live);
                            for (setup_id, r) in
                                w.setup_collision_radii()
                            {
                                ids.push(setup_id);
                                radii.push(r);
                            }
                            CREATURE_SEPARATION_RADII.with(|c| {
                                *c.borrow_mut() = (ids, radii);
                            });
                            CREATURE_SEPARATION_PUBLISHED_LEN
                                .with(|c| c.set(live));
                        }
                    }
                    // COMBAT-RADII (2026-07-28): publish the
                    // reachability counters post-tick.
                    {
                        let (evals, resolved) =
                            w.combat_radii_counters();
                        let enabled =
                            u32::from(w.scene.combat_radii_enabled());
                        COMBAT_RADII_STATS.with(|c| {
                            c.set((
                                evals as u32,
                                resolved as u32,
                                enabled,
                            ))
                        });
                    }
                    if was_airborne_pre_tick && !w.player.is_airborne {
                        // Wave 10 Phase 10.1 (2026-05-26):
                        // Touchdown signalling. The Wave 5
                        // implementation emitted the
                        // `Fallen (0x40000008)` motion-command
                        // as the touchdown clip, but per ACE
                        // `MotionCommand.cs:15` Fallen is a
                        // distinct enum entry from `Falling`
                        // — its semantics are "post-fall
                        // stagger / damage pose", not "I just
                        // landed cleanly." Wave 5's
                        // re-purposing was an improvisation
                        // (the original Wave 5 plan had asked
                        // for `Land (0x4100002B)` which
                        // doesn't exist) and pollutes the
                        // substate enum the renderer reads
                        // — entities.js routes Fallen through
                        // its STATIONARY classifier, which is
                        // not what touchdown wants.
                        //
                        // Phase 10.1 splits the touchdown
                        // signal into two clean events:
                        //
                        // (1) `ClientEvent { kind: 18,
                        //     u32_payload: local_guid,
                        //     u32_payload_2: 0 }` —
                        // mirrors the EntityAirborneChanged
                        // path that Wave 1.8 added for
                        // remote players (Wave 1.8 wired
                        // `setAirborne(guid, true)` on
                        // remote velocity-z threshold
                        // crossings; this fires the matching
                        // `setAirborne(localGuid, false)`
                        // on local touchdown so the arms-up
                        // overlay clears).
                        //
                        // (2) `ENTITY_UPDATE_KIND_MOTION`
                        // with `motion_command =
                        // Ready (0x41000003)` — replaces
                        // the Falling cycle clip with the
                        // Ready idle. If the player is
                        // holding locomotion keys at
                        // touchdown, the next manual-drive
                        // tick will fire WalkForward/etc to
                        // override Ready. The pre-tick
                        // stance is preserved so the player
                        // resumes Ready in their current
                        // combat stance, not NonCombat.
                        //
                        // The renderer's `Fallen` classifier
                        // entry in `entities.js` is LEFT
                        // ALONE: any creature/server that
                        // broadcasts `Fallen` as a genuine
                        // damage pose still routes correctly
                        // through STATIONARY. We just stop
                        // mis-emitting it from this site.
                        queued_events.borrow_mut().push(ClientEvent {
                            kind: CLIENT_EVENT_KIND_ENTITY_AIRBORNE_CHANGED,
                            string_payload: None,
                            u32_payload: Some(u32::from(
                                player_guid_for_airborne,
                            )),
                            u32_payload_2: Some(0),
                            f32_payload: None,
                        });
                        const READY_CMD: u32 = 0x4100_0003;
                        entity_updates.borrow_mut().push(EntityUpdate {
                            kind: ENTITY_UPDATE_KIND_MOTION,
                            guid: u32::from(player_guid_for_airborne),
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
                            motion_command: READY_CMD,
                            motion_stance: pre_tick_stance,
                            physics_script_did: 0,
                            sound_table_did: 0,
                            obj_desc_flags: 0,
                            weenie_flags: 0,
                    // A1 (2026-05-29): non-MOTION updates carry no
                    // playback speed — identity (no anim scaling).
                    motion_speed: 1.0,
                    physics_translucency: 0.0,
                            is_autonomous: true,
                        });
                    } else if !was_airborne_pre_tick
                        && w.player.is_airborne
                        && !was_jumping_pre_tick
                    {
                        // Wave 5 Phase 5.1 (2026-05-26):
                        // walked off a ledge. The integrator
                        // detected the step-down threshold
                        // (system.rs ~line 887) and called
                        // `begin_fall()`, which sets
                        // `is_airborne=true` but leaves
                        // `is_jumping=false`. Emit
                        // `Falling = 0x40000015` so the
                        // renderer loops the Falling cycle
                        // (data present in MT 0x09000001 for
                        // every player stance except Sling/
                        // TwoHandedStaff/Graze — see
                        // dump_player_mt_fall_variants
                        // output) instead of T-posing on the
                        // way down.
                        //
                        // A grounded→airborne transition
                        // with `is_jumping=true` is the Jump
                        // arm above; its Jump clip is
                        // already broadcast from the JS
                        // keyup handler at
                        // `index.html:7755`, so wasm
                        // suppresses any Falling emission to
                        // avoid stomping the in-flight Jump
                        // animation.
                        const FALLING_CMD: u32 = 0x4000_0015;
                        entity_updates.borrow_mut().push(EntityUpdate {
                            kind: ENTITY_UPDATE_KIND_MOTION,
                            guid: u32::from(player_guid_for_airborne),
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
                            motion_command: FALLING_CMD,
                            motion_stance: pre_tick_stance,
                            physics_script_did: 0,
                            sound_table_did: 0,
                            obj_desc_flags: 0,
                            weenie_flags: 0,
                    // A1 (2026-05-29): non-MOTION updates carry no
                    // playback speed — identity (no anim scaling).
                    motion_speed: 1.0,
                    physics_translucency: 0.0,
                            is_autonomous: true,
                        });
                    }
                    // Bug 19 (2026-10-07): the LOCAL player's
                    // leave-ground edge, for a jump AND a walk-off.
                    // Retail `LeaveGround` (acclient.c:344478) re-runs
                    // the interpreted movement off the walkable, which
                    // puts the motion table's Falling state on the
                    // sequence (take-off link + Falling loop,
                    // acclient.c:344193); `HitGround` (:344429) re-applies
                    // the held motion (landing link). The two motion
                    // updates above are marked autonomous, and loop.js
                    // drops autonomous local echoes to protect the
                    // gait predictor, so the local rig never left its
                    // run/idle cycle for the whole arc. The JS
                    // `setAirborne` drives Falling and the landing from
                    // this event and its touchdown twin above.
                    if !was_airborne_pre_tick && w.player.is_airborne {
                        queued_events.borrow_mut().push(ClientEvent {
                            kind: CLIENT_EVENT_KIND_ENTITY_AIRBORNE_CHANGED,
                            string_payload: None,
                            u32_payload: Some(u32::from(player_guid_for_airborne)),
                            u32_payload_2: Some(1),
                            f32_payload: None,
                        });
                    }
                    // Phase 4 step 3.6 diagnostic — log pose
                    // every ~60 ticks (~1s at 60Hz rAF) so we
                    // can verify the local-pose integrator is
                    // advancing the WorldState pose that the
                    // AutonomousPosition heartbeat reads.
                    if DIAG_VERBOSE && movement.tick_count() % 60 == 0 {
                        if let Some(pose) = w.local_player_runtime_pose() {
                            let caps_ok =
                                w.resolve_self_movement_capabilities()
                                    .is_ok();
                            // 2026-05-10 reconciliation
                            // diagnostic — log the body's
                            // authoritative pose + sample
                            // mode so we can see when (if
                            // ever) the runtime/authoritative
                            // poses diverge or the mode drops
                            // off SimulatingMotionState.
                            let body_view = w
                                .runtime_body_id_for_guid(w.player.guid)
                                .and_then(|bid| w.scene.runtime_body_view(bid));
                            let (auth_x, auth_y, auth_z, auth_present, mode_str) =
                                match body_view {
                                    Some(view) => {
                                        let (ax, ay, az, present) = match view
                                            .authoritative_pose
                                        {
                                            Some(p) => (
                                                p.coords.x,
                                                p.coords.y,
                                                p.coords.z,
                                                true,
                                            ),
                                            None => (0.0, 0.0, 0.0, false),
                                        };
                                        let mode = format!("{:?}", view.sample_mode);
                                        (ax, ay, az, present, mode)
                                    }
                                    None => (0.0, 0.0, 0.0, false, "no-body".into()),
                                };
                            console_log_str(&format!(
                                "[step 3.6 tick #{}] pose=({:.2}, {:.2}, {:.2}) cell=0x{:08X} indoor={} caps_ok={} force_seq={} heartbeats_sent={} auth=({:.2}, {:.2}, {:.2}) auth_present={} mode={}",
                                movement.tick_count(),
                                pose.coords.x,
                                pose.coords.y,
                                pose.coords.z,
                                u32::from(pose.landblock_id),
                                pose.is_indoors(),
                                caps_ok,
                                w.player.force_position_sequence,
                                movement.heartbeats_sent(),
                                auth_x,
                                auth_y,
                                auth_z,
                                auth_present,
                                mode_str,
                            ));
                        }
                    }
                    // Academy-rubberband diagnostic — log
                    // every change of force_position_sequence
                    // (the server's "rubber band me back"
                    // counter) at the tick it happens, so
                    // the capture script can correlate
                    // server-forced repositions against the
                    // pose log above. The cli's existing
                    // `log::warn!("Server forced reposition
                    // (rubber band): ...")` in
                    // movement/system.rs:35 goes through
                    // the `log` crate facade, which has no
                    // logger registered in the wasm build —
                    // so it is silently dropped. This is a
                    // direct console_log_str so the warn
                    // surfaces in the browser console.
                    let force_seq = w.player.force_position_sequence;
                    if *last_diag_force_seq != Some(force_seq) {
                        if let Some(prev) = *last_diag_force_seq {
                            if let Some(pose) = w.local_player_runtime_pose() {
                                if DIAG_VERBOSE {
                                    console_log_str(&format!(
                                        "[acad-diag rubberband] tick #{} force_seq {} -> {} pose=({:.2}, {:.2}, {:.2}) cell=0x{:08X} indoor={}",
                                        movement.tick_count(),
                                        prev,
                                        force_seq,
                                        pose.coords.x,
                                        pose.coords.y,
                                        pose.coords.z,
                                        u32::from(pose.landblock_id),
                                        pose.is_indoors(),
                                    ));
                                }
                            }
                        }
                        *last_diag_force_seq = Some(force_seq);
                    }
                }
                Err(e) => {
                    console_log_str(&format!(
                        "[step 3.6] MovementSystem::tick error: {e}"
                    ));
                    queued_events.borrow_mut().push(ClientEvent {
                        kind: CLIENT_EVENT_KIND_DISCONNECTED,
                        string_payload: Some(format!("tick: {e}")),
                        u32_payload: None,
                        u32_payload_2: None,
                        f32_payload: None,
                    });
                    return LoopFlow::Exit;
                }
            }
        }
        _ => unreachable!("SessionCommand routed to the wrong handler module"),
    }
    LoopFlow::Continue
}
