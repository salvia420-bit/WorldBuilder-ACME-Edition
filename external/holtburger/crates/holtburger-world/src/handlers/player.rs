use crate::WorldEvent;
use crate::context::{WorldContext, WorldContextExt};
use crate::entity::EntityMotionSnapshot;
use crate::player::mutations::{SkillUpdateParams, VitalUpdateParams};
use crate::spatial::{AuthoritativeBodySync, RuntimeBodyResetCause};
use crate::state::WorldState;
use holtburger_common::sequence::is_newer_u16;
use holtburger_protocol::messages::*;

pub(crate) fn handle_message(
    state: &mut WorldState,
    message: &GameMessage,
    events: &mut Vec<WorldEvent>,
) -> bool {
    match message {
        GameMessage::ObjectCreate(data) => {
            if data.public_weenie_desc.guid == state.player.guid
                && state.player.guid != holtburger_common::Guid::NULL
            {
                if let Some(pos) = data.pos {
                    state.sync_player_position(pos);
                }

                if let Some(current_style) = EntityMotionSnapshot::from_object_description(data)
                    .and_then(|snapshot| snapshot.current_style)
                {
                    state
                        .player
                        .update_last_server_motion_style(current_style.interpreted());
                }

                // Physics deep-dive 2026-06-01 (gap 3 follow-up:
                // edge_slide). Consume the local player's `EdgeSlide`
                // physics flag into `PlayerState` so the local-prediction
                // edge_slide path can gate on it. Retail's
                // `Transition.EdgeSlide` is a no-op (just stop) when the
                // object lacks `ObjectInfoState.EdgeSlide`. The flag is
                // hydrated into `PropertyBool::AllowEdgeSlide` for the
                // entity, but `PlayerState` is the movement-system view,
                // so mirror it here on object create.
                state.player.allow_edge_slide = data
                    .physics_state
                    .contains(holtburger_common::properties::PhysicsState::EDGE_SLIDE);
            }
            false
        }
        GameMessage::UpdatePosition(data) => {
            if data.guid == state.player.guid && state.player.guid != holtburger_common::Guid::NULL
            {
                let old_teleport_sequence = state.player.teleport_sequence;
                let old_force_position_sequence = state.player.force_position_sequence;
                let accepted = state.player.apply_position_from_server(&data.pos, events);
                if accepted {
                    events.push(WorldEvent::SelfUpdatePosition {
                        teleport_sequence: data.pos.teleport_sequence,
                        force_position_sequence: data.pos.force_position_sequence,
                    });
                    // B1/D3-SNAP: a force_position OR teleport sequence advance is an
                    // authoritative reposition (retail BlipPlayer/TeleportPlayer,
                    // acclient.c:145196-145253) -> hard-snap the working pose. ACE
                    // bumps ObjectForcePosition only on the z-hack/PKLite paths, so
                    // routine play never trips the snap. FU4 (2026-07-03): the two
                    // stamps split — retail's TELEPORT arm (:145196-145207) constrains
                    // + zeroes velocity; the FORCE arm (:145236-145243) is BlipPlayer
                    // keeping the player's OWN heading, no constrain — distinguished
                    // sync variants carry that to the scene (identical flag-off).
                    let teleport_advance =
                        is_newer_u16(data.pos.teleport_sequence, old_teleport_sequence);
                    let force_advance = is_newer_u16(
                        data.pos.force_position_sequence,
                        old_force_position_sequence,
                    );
                    let snap = teleport_advance || force_advance;
                    // Teleport-destination landing (2026-07-02): the
                    // `PlayerTeleport` arm below pre-advances
                    // `teleport_sequence` AND parks the runtime body
                    // (`suspend_runtime_bodies` → mode=Suspended, pose at the
                    // stale authoritative copy). ACE's destination
                    // `UpdatePosition` then arrives with an EQUAL
                    // teleport_sequence, so `snap` stays false — and the
                    // authoritative-only arm would leave the body Suspended at
                    // the source forever (rig + camera stranded while the
                    // world streams the destination). A Suspended local body
                    // means "awaiting the teleport destination": route the
                    // first accepted position through the Snapshot reconcile —
                    // with mode ∉ Simulating*, `preserve_local_runtime_pose`
                    // is false, so `body.pose` snaps and mode lands in
                    // AuthoritativeOnly (the
                    // `workstream_g_post_teleport_set_player_position_updates_
                    // runtime_pose_when_body_suspended` contract,
                    // state/tests.rs).
                    let body_suspended = state
                        .runtime_body_id_for_guid(state.player.guid)
                        .and_then(|body_id| state.runtime_body_view(body_id))
                        .is_some_and(|view| {
                            view.sample_mode == crate::spatial::SpatialSampleMode::Suspended
                        });
                    events.extend(if snap {
                        // Forced reposition: hard-snap the runtime body.
                        // FU4: teleport keeps Reset (constrain + zero-vel
                        // under ?retailLeash); a force-only advance takes
                        // the ForceBlip arm (own heading, no constrain) —
                        // teleport wins when both advanced (retail gate
                        // order, acclient.c:145156-145171).
                        state.set_player_position_with_sync(
                            data.pos.pos,
                            if teleport_advance {
                                AuthoritativeBodySync::Reset
                            } else {
                                AuthoritativeBodySync::ForceBlip
                            },
                        )
                    } else if body_suspended {
                        state.set_player_position_with_sync(
                            data.pos.pos,
                            AuthoritativeBodySync::Snapshot,
                        )
                    } else if state.scene.local_retail_leash() {
                        // FU4 / dossier B row 58 — the retail ROUTINE arm
                        // under ?retailLeash: every accepted echo runs the
                        // Snapshot leash reconcile (ConstrainTo re-arm +
                        // server-control-gated InterpolateTo,
                        // acclient.c:145209-145218). The leash mechanism
                        // replaces the authoritative-only rubberband guard
                        // below (safe now that the constraint budget
                        // ACCUMULATES — the old replace-semantics made
                        // every reconcile drag). Flag-off keeps the guard.
                        state.set_player_position_with_sync(
                            data.pos.pos,
                            AuthoritativeBodySync::Snapshot,
                        )
                    } else {
                        // Routine ~20 Hz self-echo: authoritative BOOKKEEPING ONLY —
                        // do NOT reconcile the runtime body. Reconciling toward the
                        // backlog-delayed echo (can land tens of metres behind)
                        // installs a force_position ease that drags the avatar
                        // backward: the "outrun then get pulled back, constant
                        // cadence" rubberband. Wires this canonical
                        // wireStatePacks=stage1 handler into the SAME guard the legacy
                        // path already used (set_player_position_authoritative_only /
                        // the B1 USE_LOCAL_PLAYER_AUTONOMOUS_GUARD,
                        // state/mutations.rs:736-753); the 2026-06-27 wireStatePacks
                        // default-on flip had bypassed it.
                        state.set_player_position_authoritative_only(data.pos.pos)
                    });
                }
                return true;
            }
            false
        }
        GameMessage::PrivateUpdatePosition(_) | GameMessage::PublicUpdatePosition(_) => false,
        GameMessage::VectorUpdate(data) => {
            if data.guid == state.player.guid && state.player.guid != holtburger_common::Guid::NULL
            {
                state
                    .player
                    .record_vector_update_sequences(data.instance_sequence);
                events.extend(state.set_player_vector_gated(
                    data.velocity,
                    data.omega,
                    data.vector_sequence,
                ));
                return true;
            }
            false
        }
        GameMessage::UpdateMotion(data) => {
            if data.guid == state.player.guid && state.player.guid != holtburger_common::Guid::NULL
            {
                let accepted = state.player.apply_self_update_motion(data);
                if accepted && !data.is_autonomous {
                    // FU5 (row 64) — retail `LoseControlToServer`
                    // (acclient.c:716832-716845): a server MoveTo/TurnTo
                    // DIRECTIVE for the local player takes control (feeds
                    // the scene's InterpolateTo gate, :145215). General
                    // (`Invalid`) envelopes — gestures/poses — only lower
                    // the autonomy latch, never the control flag.
                    if !matches!(
                        data.data,
                        holtburger_protocol::messages::movement::MovementTypeData::Invalid(_)
                    ) {
                        state.scene.set_local_server_controlled(true);
                    }
                    // A3-D3 driver (M4.3): real target_exists + case-6
                    // target dims, same resolution as the remote lane
                    // (closing the consumer's documented `false`
                    // placeholder).
                    let (target_exists, object_radius, object_height) =
                        crate::handlers::movement::resolve_movement_target(state, data);
                    events.push(WorldEvent::SelfServerControlledMotion {
                        data: Box::new((**data).clone()),
                        target_exists,
                        object_radius,
                        object_height,
                    });
                }
                // A message dropped by the sequence gates is dropped at
                // the MESSAGE level (retail SetObjectMovement never
                // unpacks it, acclient.c:311168-311185) — consume it so
                // the entity movement lane does not apply a stale echo.
                // Accepted messages (autonomous included) fall through
                // to the shared entity lane exactly as before.
                return !accepted;
            }
            false
        }
        GameMessage::PlayerTeleport(data) => {
            state.player.set_teleport_sequence(data.teleport_sequence);
            events
                .extend(state.suspend_runtime_bodies(RuntimeBodyResetCause::TeleportOrWorldReset));
            events.push(WorldEvent::TeleportStarted {
                sequence: data.teleport_sequence,
            });
            true
        }
        GameMessage::PrivateUpdateAttribute(data) => {
            let UpdateAttribute {
                attribute,
                ranks,
                start,
                xp,
                ..
            } = &**data;
            state
                .player
                .update_attribute(*attribute, *ranks, *start, *xp, &state.xp_table, events);
            state.emit_player_derived_stats(events);
            true
        }
        GameMessage::PublicUpdateAttribute(data) => {
            let UpdateAttribute {
                attribute,
                ranks,
                start,
                xp,
                ..
            } = &**data;
            state
                .player
                .update_attribute(*attribute, *ranks, *start, *xp, &state.xp_table, events);
            state.emit_player_derived_stats(events);
            true
        }
        GameMessage::PrivateUpdateSkill(data) => {
            let UpdateSkill {
                skill,
                ranks,
                status,
                init,
                xp,
                ..
            } = &**data;
            state.player.update_skill(
                SkillUpdateParams {
                    skill_id: *skill,
                    ranks: *ranks,
                    status: *status,
                    init: *init,
                    xp: *xp,
                    xp_table: &state.xp_table,
                    skill_table: &state.skill_table,
                },
                events,
            );
            state.emit_player_derived_stats(events);
            true
        }
        GameMessage::PublicUpdateSkill(data) => {
            let UpdateSkill {
                skill,
                ranks,
                status,
                init,
                xp,
                ..
            } = &**data;
            state.player.update_skill(
                SkillUpdateParams {
                    skill_id: *skill,
                    ranks: *ranks,
                    status: *status,
                    init: *init,
                    xp: *xp,
                    xp_table: &state.xp_table,
                    skill_table: &state.skill_table,
                },
                events,
            );
            state.emit_player_derived_stats(events);
            true
        }
        GameMessage::PrivateUpdateVital(data) => {
            let UpdateVital {
                vital,
                ranks,
                start,
                current,
                xp,
                ..
            } = &**data;
            state.player.update_vital(
                VitalUpdateParams {
                    vital_id: *vital,
                    ranks: *ranks,
                    start: *start,
                    current: *current,
                    xp: *xp,
                    xp_table: &state.xp_table,
                },
                events,
            );
            state.emit_player_derived_stats(events);
            true
        }
        GameMessage::PublicUpdateVital(data) => {
            let UpdateVital {
                vital,
                ranks,
                start,
                current,
                xp,
                ..
            } = &**data;
            state.player.update_vital(
                VitalUpdateParams {
                    vital_id: *vital,
                    ranks: *ranks,
                    start: *start,
                    current: *current,
                    xp: *xp,
                    xp_table: &state.xp_table,
                },
                events,
            );
            state.emit_player_derived_stats(events);
            true
        }
        GameMessage::PrivateUpdateVitalCurrent(data) => {
            let UpdateVitalCurrent { vital, current, .. } = &**data;
            state.player.update_vital_current(*vital, *current, events);
            true
        }
        GameMessage::InventoryRemoveObject(data) => {
            state.player.remove_from_inventory(data.object_guid);
            false
        }
        GameMessage::GameEvent(_) => false,
        _ => false,
    }
}

pub(crate) fn handle_event(
    state: &mut WorldState,
    event: &GameEventMessage,
    events: &mut Vec<WorldEvent>,
) -> bool {
    match &event.event {
        GameEvent::PlayerDescription(data) => {
            state.player.hydrate_from_player_description(
                data,
                &state.xp_table,
                &state.skill_table,
                events,
            );
            state.emit_player_derived_stats(events);
            false
        }
        GameEvent::MagicUpdateEnchantment(data) => {
            let handled = state
                .player
                .upsert_enchantment(data.target, data.enchantment, events);
            if handled {
                state.emit_player_derived_stats(events);
            }
            handled
        }
        GameEvent::MagicUpdateMultipleEnchantments(data) => {
            let handled =
                state
                    .player
                    .upsert_multiple_enchantments(data.target, &data.enchantments, events);
            if handled {
                state.emit_player_derived_stats(events);
            }
            handled
        }
        GameEvent::MagicRemoveEnchantment(data) => {
            let handled =
                state
                    .player
                    .remove_enchantment(data.target, data.spell_id, data.layer, events);
            if handled {
                state.emit_player_derived_stats(events);
            }
            handled
        }
        GameEvent::MagicDispelEnchantment(data) => {
            let handled =
                state
                    .player
                    .remove_enchantment(data.target, data.spell_id, data.layer, events);
            if handled {
                state.emit_player_derived_stats(events);
            }
            handled
        }
        GameEvent::MagicRemoveMultipleEnchantments(data) => {
            let handled =
                state
                    .player
                    .remove_multiple_enchantments(data.target, &data.spells, events);
            if handled {
                state.emit_player_derived_stats(events);
            }
            handled
        }
        GameEvent::MagicDispelMultipleEnchantments(data) => {
            let handled =
                state
                    .player
                    .remove_multiple_enchantments(data.target, &data.spells, events);
            if handled {
                state.emit_player_derived_stats(events);
            }
            handled
        }
        GameEvent::MagicPurgeEnchantments(data) => {
            let handled = state.player.purge_enchantments(data.target, false, events);
            if handled {
                state.emit_player_derived_stats(events);
            }
            handled
        }
        GameEvent::MagicPurgeBadEnchantments(data) => {
            let handled = state.player.purge_enchantments(data.target, true, events);
            if handled {
                state.emit_player_derived_stats(events);
            }
            handled
        }
        GameEvent::MagicUpdateSpell(data) => {
            state.player.add_spell(data.spell_id as u32, events);
            true
        }
        GameEvent::MagicRemoveSpell(data) => {
            state.player.remove_spell(data.spell_id as u32, events);
            true
        }
        GameEvent::UpdateHealth(data) => {
            state.update_health_fraction(data.target, data.health, events)
        }
        GameEvent::InventoryPutObjInContainer(data) => {
            if state.get_player_guid() == Some(data.container_guid)
                || state.is_in_player_inventory(data.container_guid)
            {
                state.player.add_to_inventory(data.item_guid);
            }
            false
        }
        GameEvent::InventoryPutObjectIn3D(data) => {
            state.player.remove_from_inventory(data.object_guid);
            false
        }
        GameEvent::WieldObject(data) => {
            if event.target == state.player.guid {
                state.player.wield_item(data.object_guid, data.equip_mask);
            }
            false
        }
        _ => false,
    }
}
