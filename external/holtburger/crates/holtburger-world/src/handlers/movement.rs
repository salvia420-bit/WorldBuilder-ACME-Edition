use crate::WorldEvent;
use crate::entity::EntityMotionSnapshot;
use crate::state::WorldState;
use holtburger_common::Guid;
use holtburger_common::math::Quaternion;
use holtburger_protocol::messages::{GameMessage, MovementEventData, MovementTypeData};

/// A3-D3 driver (M4.3): resolve the MoveToObject / TurnToObject target
/// against `state.entities` — `(target_exists, object_radius,
/// object_height)`. The dims are the case-6 target physics dims the
/// retail caller reads from the target's `CPartArray`
/// (`CPhysicsObj::MoveToObject`, acclient.c:319808-319817): radius via
/// the cached SetupModel cyl-sphere (`entity_collision_radius`, the
/// ACE `GetPhysicsRadius` mirror); height has no entity-side source
/// yet → `0.0` — the retail CPartArray-null fallback
/// (acclient.c:319810-319815).
pub(crate) fn resolve_movement_target(
    state: &WorldState,
    data: &MovementEventData,
) -> (bool, f32, f32) {
    match &data.data {
        MovementTypeData::MoveToObject(moveto) => match state.entities.get(moveto.target) {
            Some(entity) => (true, state.entity_collision_radius(entity), 0.0),
            None => (false, 0.0, 0.0),
        },
        MovementTypeData::TurnToObject(turn) => {
            (state.entities.get(turn.target).is_some(), 0.0, 0.0)
        }
        _ => (false, 0.0, 0.0),
    }
}

/// A3-D3 (2026-06-12): emit the UNCONDITIONAL per-message
/// [`WorldEvent::EntityMovementEvent`] for a REMOTE entity — retail's
/// `unpack_movement` preamble is per-unpack, not change-gated
/// (acclient.c:339518-339519). Skips the local player: that lane is the
/// gate-bearing `SelfServerControlledMotion` (handlers/player.rs:96-107;
/// see the event's doc). `target_exists` + the case-6 target dims
/// resolve against `state.entities` here, where the world is visible
/// ([`resolve_movement_target`]).
fn emit_entity_movement_event(
    state: &WorldState,
    guid: Guid,
    data: &MovementEventData,
    events: &mut Vec<WorldEvent>,
) {
    if guid == state.player.guid {
        return;
    }
    let (target_exists, object_radius, object_height) = resolve_movement_target(state, data);
    events.push(WorldEvent::EntityMovementEvent {
        guid,
        data: Box::new(data.clone()),
        target_exists,
        object_radius,
        object_height,
    });
}

fn update_entity_motion_snapshot(
    state: &mut WorldState,
    guid: Guid,
    snapshot: Option<EntityMotionSnapshot>,
    events: &mut Vec<WorldEvent>,
) {
    let Some(entity) = state.entities.get_mut(guid) else {
        return;
    };

    if entity.motion_snapshot != snapshot {
        entity.motion_snapshot = snapshot;
        if let Some(body_id) = state.update_runtime_body_motion_snapshot_for_guid(guid, snapshot) {
            events.push(WorldEvent::RuntimeBodyChanged { body_id });
        }
        events.push(WorldEvent::EntityMotionUpdated { guid, snapshot });
    }
}

pub(crate) fn handle_message(
    state: &mut WorldState,
    message: &GameMessage,
    events: &mut Vec<WorldEvent>,
) -> bool {
    match message {
        GameMessage::UpdatePosition(data) => {
            if data.guid == state.player.guid {
                events.extend(state.set_player_position(data.pos.pos));
                true
            } else {
                state.apply_entity_position_pack(data.guid, &data.pos, events)
            }
        }
        GameMessage::PrivateUpdatePosition(data) => {
            state.apply_private_position_update(data.position_type, data.pos, events);
            true
        }
        GameMessage::PublicUpdatePosition(data) => {
            state.apply_public_position_update(data.guid, data.position_type, data.pos, events)
        }
        GameMessage::AutonomousPosition(data) => {
            if data.guid == state.player.guid {
                events.extend(state.apply_player_autonomous_position(data));
                true
            } else {
                state.apply_entity_autonomous_position(data, events)
            }
        }
        GameMessage::UpdateMotion(data) => {
            let guid = data.guid;
            // A3-D3: per-message, before any change gate / early return.
            emit_entity_movement_event(state, guid, data, events);
            let snapshot = EntityMotionSnapshot::from_movement_event(data);

            update_entity_motion_snapshot(state, guid, snapshot, events);

            if snapshot.is_some_and(EntityMotionSnapshot::indicates_death_motion) {
                state.update_health_fraction(guid, 0.0, events);
            }

            let mut target_info = None;
            if let MovementTypeData::TurnToObject(turn) = &data.data
                && turn.desired_heading.abs() <= 1e-6
                && let Some(target) = state.entities.get(turn.target)
            {
                target_info = Some((target.position.landblock_id, target.position.coords));
            }

            let current_position = match state.entities.get(guid) {
                Some(entity) => entity.position,
                None => return false,
            };

            let maybe_rotation = match &data.data {
                MovementTypeData::TurnToHeading(turn)
                    if turn.params.desired_heading.is_finite() =>
                {
                    Some(Quaternion::from_heading(turn.params.desired_heading))
                }
                MovementTypeData::TurnToObject(turn) => {
                    if turn.desired_heading.is_finite() && turn.desired_heading.abs() > 1e-6 {
                        Some(Quaternion::from_heading(turn.desired_heading))
                    } else if let Some((target_lb, target_coords)) = target_info {
                        if target_lb == current_position.landblock_id {
                            Some(Quaternion::from_heading(
                                current_position.coords.heading_to(&target_coords),
                            ))
                        } else {
                            None
                        }
                    } else {
                        None
                    }
                }
                _ => None,
            };

            if let Some(rotation) = maybe_rotation {
                state.set_entity_rotation(guid, rotation, events)
            } else {
                false
            }
        }
        GameMessage::VectorUpdate(data) => {
            if data.guid == state.player.guid {
                state
                    .player
                    .record_vector_update_sequences(data.instance_sequence);
                events.extend(state.set_player_vector_gated(
                    data.velocity,
                    data.omega,
                    data.vector_sequence,
                ));
                true
            } else {
                state.update_entity_velocity(
                    data.guid,
                    data.velocity,
                    data.omega,
                    data.vector_sequence,
                    events,
                )
            }
        }
        GameMessage::PositionAndMovementEvent(data) => {
            // 0xF619 = combined materialize frame: apply the PositionPack
            // (UpdatePosition path) AND the motion snapshot (UpdateMotion path).
            let guid = data.guid;

            // --- Position half (mirrors GameMessage::UpdatePosition) ---
            let mut handled = if guid == state.player.guid {
                events.extend(state.set_player_position(data.pos.pos));
                true
            } else {
                state.apply_entity_position_pack(guid, &data.pos, events)
            };

            // --- Movement half (mirrors GameMessage::UpdateMotion) ---
            // A3-D3: per-message, before any change gate.
            emit_entity_movement_event(state, guid, &data.movement, events);
            let snapshot = EntityMotionSnapshot::from_movement_event(&data.movement);
            update_entity_motion_snapshot(state, guid, snapshot, events);

            if snapshot.is_some_and(EntityMotionSnapshot::indicates_death_motion) {
                state.update_health_fraction(guid, 0.0, events);
            }

            let mut target_info = None;
            if let MovementTypeData::TurnToObject(turn) = &data.movement.data
                && turn.desired_heading.abs() <= 1e-6
                && let Some(target) = state.entities.get(turn.target)
            {
                target_info = Some((target.position.landblock_id, target.position.coords));
            }

            if let Some(entity) = state.entities.get(guid) {
                let current_position = entity.position;
                let maybe_rotation = match &data.movement.data {
                    MovementTypeData::TurnToHeading(turn)
                        if turn.params.desired_heading.is_finite() =>
                    {
                        Some(Quaternion::from_heading(turn.params.desired_heading))
                    }
                    MovementTypeData::TurnToObject(turn) => {
                        if turn.desired_heading.is_finite() && turn.desired_heading.abs() > 1e-6 {
                            Some(Quaternion::from_heading(turn.desired_heading))
                        } else if let Some((target_lb, target_coords)) = target_info {
                            if target_lb == current_position.landblock_id {
                                Some(Quaternion::from_heading(
                                    current_position.coords.heading_to(&target_coords),
                                ))
                            } else {
                                None
                            }
                        } else {
                            None
                        }
                    }
                    _ => None,
                };

                if let Some(rotation) = maybe_rotation
                    && state.set_entity_rotation(guid, rotation, events)
                {
                    handled = true;
                }
            }

            handled
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::entity::Entity;
    use holtburger_common::position::WorldPosition;
    use holtburger_protocol::messages::movement::messages::motion::{
        MoveToObject, MoveToParameters, Origin,
    };
    use holtburger_protocol::messages::{MovementEventData, MovementType, MovementTypeData};

    fn moveto_message(
        guid: holtburger_common::Guid,
        target: holtburger_common::Guid,
    ) -> GameMessage {
        GameMessage::UpdateMotion(Box::new(MovementEventData {
            guid,
            object_instance_sequence: 1,
            movement_sequence: 2,
            server_control_sequence: 3,
            is_autonomous: false,
            movement_type: MovementType::MoveToObject,
            motion_flags: 0,
            current_style: 0x3D,
            data: MovementTypeData::MoveToObject(MoveToObject {
                target,
                origin: Origin::default(),
                params: MoveToParameters::default(),
                run_rate: 1.0,
            }),
        }))
    }

    /// A3-D3 driver (M4.3, spec test 10): the wire case-6 emit sites
    /// carry the CALLER-resolved target dims (radius via
    /// `entity_collision_radius` — the no-gfx fallback is
    /// PLAYER_CAPSULE_RADIUS; height 0.0, the retail CPartArray-null
    /// fallback) on BOTH lanes, and the LOCAL lane carries a REAL
    /// `target_exists` (regression for the documented `false`
    /// placeholder).
    #[test]
    fn update_motion_case6_carries_dims_on_both_lanes() {
        let mut state = WorldState::synthetic();
        state.player.guid = holtburger_common::Guid(0x5000_0001);
        let target = holtburger_common::Guid(0x8000_0042);
        let remote = holtburger_common::Guid(0x8000_0077);
        state.entities.insert(Entity::new(
            target,
            "Drudge".to_string(),
            WorldPosition::default(),
        ));
        state.entities.insert(Entity::new(
            remote,
            "Chaser".to_string(),
            WorldPosition::default(),
        ));
        let expected_radius = crate::spatial::PLAYER_CAPSULE_RADIUS;

        // Remote lane.
        let events = state.handle_message(&moveto_message(remote, target));
        assert!(
            events.iter().any(|event| matches!(
                event,
                WorldEvent::EntityMovementEvent {
                    guid,
                    target_exists: true,
                    object_radius,
                    object_height,
                    ..
                } if *guid == remote
                    && (*object_radius - expected_radius).abs() < 1e-6
                    && *object_height == 0.0
            )),
            "remote case-6 must carry resolved dims: {events:?}"
        );

        // Local lane (SelfServerControlledMotion).
        let events = state.handle_message(&moveto_message(state.player.guid, target));
        assert!(
            events.iter().any(|event| matches!(
                event,
                WorldEvent::SelfServerControlledMotion {
                    target_exists: true,
                    object_radius,
                    object_height,
                    ..
                } if (*object_radius - expected_radius).abs() < 1e-6 && *object_height == 0.0
            )),
            "local case-6 must carry real target_exists + dims: {events:?}"
        );

        // Missing target → false + 0.0 fallbacks.
        let gone = holtburger_common::Guid(0x8000_9999);
        let events = state.handle_message(&moveto_message(remote, gone));
        assert!(events.iter().any(|event| matches!(
            event,
            WorldEvent::EntityMovementEvent {
                target_exists: false,
                object_radius,
                object_height,
                ..
            } if *object_radius == 0.0 && *object_height == 0.0
        )));
    }
}
