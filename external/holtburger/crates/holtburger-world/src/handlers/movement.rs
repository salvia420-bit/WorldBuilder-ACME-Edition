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
/// (`CPhysicsObj::MoveToObject`, acclient.c:319808-319817).
///
/// COMBAT-RADII (2026-07-28): with `?combatRadii` on (default) these are
/// the REAL `CPartArray::GetRadius`/`GetHeight` pair — `setup->radius/
/// height * scale.z` (acclient.c:325382-325391) — so the F2 charge lane's
/// `UseSpheres` cylinder metric (`GetCurrentDistance` :344856-344893 →
/// `Position::cylinder_distance`) stops at the target's EDGE and the
/// arrival `StickTo` handoff (:345553-345566) inherits the same dims.
/// With the flag off (or the Setup not yet resident) this keeps the
/// pre-fix value: radius via the cached SetupModel cyl-sphere
/// (`entity_collision_radius`, the ACE `GetPhysicsRadius` mirror),
/// height `0.0` — the retail CPartArray-null fallback
/// (acclient.c:319810-319815).
pub(crate) fn resolve_movement_target(
    state: &WorldState,
    data: &MovementEventData,
) -> (bool, f32, f32) {
    match &data.data {
        MovementTypeData::MoveToObject(moveto) => match state.entities.get(moveto.target) {
            Some(entity) => {
                let (radius, height) = state.combat_part_dims(moveto.target);
                if radius > 0.0 {
                    (true, radius, height)
                } else {
                    (true, state.entity_collision_radius(entity), 0.0)
                }
            }
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

    /// COMBAT-RADII (2026-07-28): with `?combatRadii` on and the target's
    /// SetupModel resident, the case-6 dims are retail's
    /// `CPartArray::GetRadius`/`GetHeight` = `setup->radius/height ×
    /// scale.z` (acclient.c:325382-325391) — NOT the cyl-sphere
    /// `GetPhysicsRadius` value, and height is no longer pinned 0.0.
    /// Flag off ⇒ byte-identical to the pre-fix pair.
    #[test]
    fn case6_dims_are_part_array_dims_under_combat_radii() {
        use holtburger_common::properties::{
            PropertyDataId, PropertyFloat, WorldObjectPropertyAccessorsMut as _,
        };

        let setup_id = 0x0200_1234u32;
        let mut state = WorldState::synthetic();
        state.player.guid = holtburger_common::Guid(0x5000_0001);
        let remote = holtburger_common::Guid(0x8000_0077);
        let target = holtburger_common::Guid(0x8000_0042);
        state.entities.insert(Entity::new(
            remote,
            "Chaser".to_string(),
            WorldPosition::default(),
        ));
        let mut tusker = Entity::new(target, "Tusker".to_string(), WorldPosition::default());
        // The LIVE source: wire `ObjectDescriptionData.csetup_id` →
        // `PropertyDataId::Setup` (hydration.rs:212-213). `Entity::gfx_id`
        // is never assigned outside tests, so the resolver must not
        // depend on it.
        tusker.set_did_prop(PropertyDataId::Setup, holtburger_common::Guid(setup_id));
        // Wire ObjectDescriptionData.obj_scale → PropertyFloat::DefaultScale
        // (hydration.rs:232) — retail's `CPartArray::scale.z`.
        tusker.set_float_prop(PropertyFloat::DefaultScale, 1.5);
        state.entities.insert(tusker);
        // The DAT pair the wasm SetupModel parse stages.
        state.register_setup_part_dims(setup_id, 1.2, 2.4);
        // The cyl-sphere cache says something DIFFERENT — proving which
        // source the combat lane reads.
        state.register_setup_radius(setup_id, 0.55);

        // Flag off: the pre-fix cyl-sphere pair.
        let events = state.handle_message(&moveto_message(remote, target));
        assert!(
            events.iter().any(|event| matches!(
                event,
                WorldEvent::EntityMovementEvent {
                    object_radius,
                    object_height,
                    ..
                } if (*object_radius - 0.55).abs() < 1e-6 && *object_height == 0.0
            )),
            "flag off must keep the GetPhysicsRadius pair: {events:?}"
        );

        // Flag on: setup.radius/height × scale.
        state.set_combat_radii_enabled(true);
        let (r, h) = state.combat_part_dims(target);
        assert!((r - 1.8).abs() < 1e-5, "radius = 1.2 × 1.5, got {r}");
        assert!((h - 3.6).abs() < 1e-5, "height = 2.4 × 1.5, got {h}");
        let events = state.handle_message(&moveto_message(remote, target));
        assert!(
            events.iter().any(|event| matches!(
                event,
                WorldEvent::EntityMovementEvent {
                    object_radius,
                    object_height,
                    ..
                } if (*object_radius - 1.8).abs() < 1e-5 && (*object_height - 3.6).abs() < 1e-5
            )),
            "flag on must carry the CPartArray dims: {events:?}"
        );

        // Residency miss (Setup not parsed yet) falls back to the
        // cyl-sphere radius, never to 0.0 — a miss is not retail's
        // "no CPartArray".
        let unknown = holtburger_common::Guid(0x8000_0099);
        let mut bare = Entity::new(unknown, "Bare".to_string(), WorldPosition::default());
        bare.set_did_prop(PropertyDataId::Setup, holtburger_common::Guid(0x0200_9999));
        state.entities.insert(bare);
        let (r, h) = state.combat_part_dims(unknown);
        assert_eq!(h, 0.0);
        assert!((r - crate::spatial::PLAYER_CAPSULE_RADIUS).abs() < 1e-6);

        // The unconditional reachability counter moved.
        assert!(state.combat_radii_counters().0 > 0);
        assert!(state.combat_radii_counters().1 > 0);
    }

    /// CREATURE-SEPARATION (2026-07-28): the render-side separation table
    /// publishes the COLLISION-PRIMITIVE radius cache
    /// (`WorldState::setup_radii`, ACE `GetPhysicsRadius` = first cyl-sphere
    /// else first sphere) — a DIFFERENT quantity from the `CPartArray`
    /// dims the combat standoff reads, and the one retail's
    /// `CPhysicsObj::FindObjCollisions` actually enforces
    /// (acclient.c:316229-316281 reads `CPartArray::GetCylsphere`/`GetSphere`,
    /// :325364-325376 — NOT `GetRadius` :325382).
    ///
    /// Also pins the retail floor arithmetic against the two creatures
    /// measured out of the base `client_portal.dat`, so a future edit that
    /// swaps the radius source or drops the epsilon fails here.
    #[test]
    fn separation_table_publishes_collision_primitive_radii_not_part_dims() {
        // Measured 2026-07-28 (WorldBuilder.Terminal chorizite-parse-dat-record
        // on client_portal.dat). Both setups ship ZERO cylspheres, so the
        // SPHERE arm is the live one for creature-vs-player.
        const PLAYER_SPHERE_R: f32 = 0.48; // Setup 0x02000001
        const TUSKER_SPHERE_R: f32 = 0.996; // Setup 0x02000964
        // acclient.c:39545 `F_EPSILON_37`; ACE PhysicsGlobals.cs:9.
        const EPSILON: f32 = 0.0002;

        let mut state = WorldState::synthetic();
        let tusker_setup = 0x0200_0964u32;
        let human_setup = 0x0200_0001u32;
        // Collision primitives (what the separation table carries)...
        state.register_setup_radius(tusker_setup, TUSKER_SPHERE_R);
        state.register_setup_radius(human_setup, PLAYER_SPHERE_R);
        // ...vs the CPartArray bounding radii (what `?combatRadii` reads).
        // Deliberately different numbers so a source mix-up is visible.
        state.register_setup_part_dims(tusker_setup, 1.408_556_7, 1.992);
        state.register_setup_part_dims(human_setup, 0.678_822_5, 1.835);

        let table: std::collections::HashMap<u32, f32> =
            state.setup_collision_radii().into_iter().collect();
        assert_eq!(state.setup_collision_radii_len(), 2);
        assert!((table[&tusker_setup] - TUSKER_SPHERE_R).abs() < 1e-6);
        assert!((table[&human_setup] - PLAYER_SPHERE_R).abs() < 1e-6);
        // The table must NOT be the CPartArray radii — that would over-separate
        // a Tusker by ~0.9 m (2.087 vs the real 1.476 contact floor).
        assert!((table[&tusker_setup] - 1.408_556_7).abs() > 0.1);

        // Retail radsum: `r_a + r_b - EPSILON`
        // (`CSphere::intersects_sphere` acclient.c:359211,
        // `CCylSphere::intersects_sphere` :362082).
        let floor = |mob_r: f32, scale: f32| mob_r * scale + PLAYER_SPHERE_R - EPSILON;
        // Tusker Guard at scale 1.0.
        assert!((floor(table[&tusker_setup], 1.0) - 1.4758).abs() < 1e-3);
        // Shadow Child: SAME human setup as the player, but ACE ships it at
        // DefaultScale 0.5 — the scale term must halve its radius.
        assert!((floor(table[&human_setup], 0.5) - 0.7198).abs() < 1e-3);
        // The pre-fix hardcoded 1.3 m glue standoff was wrong in BOTH
        // directions — that is the bug this table exists to retire.
        assert!(floor(table[&tusker_setup], 1.0) > 1.3);
        assert!(floor(table[&human_setup], 0.5) < 1.3);
    }
}
