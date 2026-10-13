//! MoveTo refactor phase B (2026-10-10) — the world side of the per-object
//! movement spine.
//!
//! Retail gives every physics object its own `MovementManager`
//! (`CPhysicsObj::movement_manager`, acclient.h:30943): a movement message
//! for the object unpacks into it (`CPhysicsObj::unpack_movement` →
//! `MovementManager::unpack_movement`, acclient.c:339492), and every
//! physics quantum moves the object by its own motion and then runs its
//! `MovementManager::UseTime` (`UpdateObjectInternal`,
//! acclient.c:322719-322891). Here a remote object's manager lives on the
//! scene ([`crate::spatial::SpatialScene::apply_remote_movement`]); this
//! module resolves what only the world knows — the MoveTo target's
//! existence and dims, the object's own dims and motion table — and steps
//! the scene once per physics slice.
//!
//! `?remoteSpine=off` (the scene switch) restores the legacy split: the
//! world emits `WorldEvent::EntityMovementEvent` and holtburger-core's
//! registry runs the remote MoveTos (`drive_remote_movetos`).

use crate::WorldEvent;
use crate::entity::movement_event_from_object_description;
use crate::handlers::movement::resolve_movement_target;
use crate::motion::movement_manager::UnpackEffects;
use crate::state::WorldState;
use holtburger_common::Guid;
use holtburger_protocol::messages::MovementEventData;
use holtburger_protocol::messages::object::messages::description::ObjectDescriptionData;
use crate::spatial::remote_transition::{REMOTE_TRANSITION_RADIUS_M, RemoteTransitionConfig};
use std::collections::HashMap;
use std::sync::Arc;
use web_time::Instant;

impl WorldState {
    /// True while remote objects run on their own movement managers.
    pub fn remote_spine_active(&self) -> bool {
        self.scene.remote_spine_active()
    }

    /// A REMOTE object's movement message: onto its own movement manager
    /// under the spine, else the legacy per-message event for
    /// holtburger-core's registry (retail's `unpack_movement` preamble runs
    /// per message, not change-gated, acclient.c:339518-339519). The local
    /// player is skipped: its lane is `SelfServerControlledMotion`.
    pub(crate) fn route_remote_movement(
        &mut self,
        guid: Guid,
        data: &MovementEventData,
        events: &mut Vec<WorldEvent>,
    ) {
        if guid == self.player.guid {
            return;
        }
        if self.scene.remote_spine_active() {
            if self.entities.get(guid).is_some() {
                let _ = self.apply_remote_movement(guid, data);
            }
            return;
        }
        let (target_exists, object_radius, object_height) = resolve_movement_target(self, data);
        events.push(WorldEvent::EntityMovementEvent {
            guid,
            data: Box::new(data.clone()),
            target_exists,
            object_radius,
            object_height,
        });
    }

    /// `MovementManager::unpack_movement` for a remote object on its own
    /// manager. The MoveTo target dims are the case-6 `MovementStruct`
    /// radius/height (`CPhysicsObj::MoveToObject`, acclient.c:319808-319817);
    /// the object's own dims feed its MoveTo distance checks
    /// (`GetCurrentDistance` :344856) and its arrival stick.
    pub fn apply_remote_movement(&mut self, guid: Guid, data: &MovementEventData) -> UnpackEffects {
        let (target_exists, object_radius, object_height) = resolve_movement_target(self, data);
        let dims = self.combat_part_dims(guid);
        let motion_table_id = self.motion_table_id_for_guid(guid);
        self.scene.apply_remote_movement(
            guid,
            data,
            target_exists,
            object_radius,
            object_height,
            motion_table_id,
            dims,
        )
    }

    /// The movement buffer of a remote object's ObjectCreate, onto its
    /// movement manager (a creature created mid-run keeps running). No-op
    /// without the spine, for the local player, or without a buffer.
    pub(crate) fn seed_remote_movement_from_create(&mut self, data: &ObjectDescriptionData) {
        let guid = data.public_weenie_desc.guid;
        if guid == self.player.guid || !self.scene.remote_spine_active() {
            return;
        }
        if let Some(movement) = movement_event_from_object_description(data) {
            let _ = self.apply_remote_movement(guid, &movement);
        }
    }

    /// One physics slice of every remote object (see the module doc):
    /// movers of objects the world dropped are released first; with
    /// `sweep` (the local player's transition settings, phase C) the moves
    /// their own motion makes go through the transition.
    pub fn step_remote_objects(
        &mut self,
        quantum: f32,
        now: Instant,
        sweep: Option<RemoteTransitionConfig>,
    ) {
        use holtburger_common::properties::WorldObjectExt as _;

        if !self.scene.remote_spine_active() {
            self.scene.step_remote_position_managers(quantum);
            return;
        }
        let entities = &self.entities;
        self.scene
            .prune_remote_movers(|guid| entities.get(guid).is_some());
        let kinematics = Arc::clone(&self.motion_kinematics);
        // motion-remote-1: each object's root motion at its own scale (the
        // wire ObjScale, `PropertyFloat::DefaultScale`), read per slice and
        // sanitised as `entity_part_dims` does.
        let roots = self.scene.remote_root_motions_scaled(Some(&kinematics), |guid| {
            entities
                .get(guid)
                .and_then(|e| e.obj_scale())
                .map(|s| s as f32)
                .filter(|s| s.is_finite() && *s > 0.0)
                .unwrap_or(1.0)
        });
        let resolved = match sweep.filter(|_| self.scene.remote_sweep_active()) {
            Some(config) => {
                let plans = self
                    .scene
                    .plan_remote_moves(quantum, &roots, REMOTE_TRANSITION_RADIUS_M);
                self.resolve_remote_moves(&plans, &config)
            }
            None => HashMap::new(),
        };
        self.scene.step_remote_spine(quantum, &roots, &resolved, now);
    }
}

#[cfg(test)]
mod tests {
    use crate::WorldEvent;
    use crate::entity::Entity;
    use crate::spatial::{AuthoritativeBodySync, RemoteCorrectionCtx, SpatialBodyId};
    use crate::state::WorldState;
    use holtburger_common::position::WorldPosition;
    use holtburger_common::{Guid, Quaternion, Vector3};
    use holtburger_protocol::messages::movement::messages::motion::MovementInvalid;
    use holtburger_protocol::messages::movement::{InterpretedMotionState, MovementStateFlags};
    use holtburger_protocol::messages::object::messages::description::ObjectDescriptionData;
    use holtburger_protocol::messages::{GameMessage, MovementEventData, MovementType, MovementTypeData};
    use holtburger_protocol::traits::ProtocolPack;

    const REMOTE: Guid = Guid(0x8000_0A06);

    fn running() -> InterpretedMotionState {
        InterpretedMotionState {
            flags: MovementStateFlags::FORWARD_COMMAND | MovementStateFlags::FORWARD_SPEED,
            num_commands: 0,
            current_style: None,
            forward_command: Some(0x0007u16.into()),
            sidestep_command: None,
            turn_command: None,
            forward_speed: Some(1.5),
            sidestep_speed: None,
            turn_speed: None,
            commands: Vec::new(),
        }
    }

    fn world_with_remote(spine: bool) -> WorldState {
        let mut state = WorldState::synthetic();
        state.set_remote_interp_enabled(true);
        state.scene.set_remote_spine_enabled(spine);
        let pose = WorldPosition {
            landblock_id: Guid(0x0102_0013),
            coords: Vector3::new(50.0, 50.0, 0.0),
            rotation: Quaternion::from_heading(0.0),
        };
        state.entities.insert(Entity::new(REMOTE, "Drudge".to_string(), pose));
        state.scene.reconcile_authoritative_body_with_remote(
            SpatialBodyId::Entity(REMOTE),
            pose,
            Vector3::zero(),
            Vector3::zero(),
            AuthoritativeBodySync::Snapshot,
            web_time::Instant::now(),
            Some(RemoteCorrectionCtx {
                contact: Some(true),
                player_pose: Some(pose),
            }),
        );
        state
    }

    fn update_motion() -> GameMessage {
        GameMessage::UpdateMotion(Box::new(MovementEventData {
            guid: REMOTE,
            object_instance_sequence: 0,
            movement_sequence: 1,
            server_control_sequence: 0,
            is_autonomous: false,
            movement_type: MovementType::Invalid,
            motion_flags: 0,
            current_style: 0x3D,
            data: MovementTypeData::Invalid(MovementInvalid {
                state: running(),
                sticky_object: None,
            }),
        }))
    }

    /// Under the spine a remote UpdateMotion lands on the object's own
    /// movement manager and no registry event is emitted; with the switch
    /// off the legacy per-message event feeds holtburger-core's registry.
    #[test]
    fn remote_update_motion_routes_to_the_object_mover() {
        let mut state = world_with_remote(true);
        assert!(state.remote_spine_active());
        let events = state.handle_message(&update_motion());
        assert!(
            !events.iter().any(|e| matches!(e, WorldEvent::EntityMovementEvent { .. })),
            "no registry event under the spine"
        );
        let mover = state.scene.remote_mover(REMOTE).expect("the object's own mover");
        let interp = mover.movement.motion_interp_ref().expect("interp created");
        assert_eq!(interp.interpreted_state.forward_speed, 1.5);

        let mut legacy = world_with_remote(false);
        let events = legacy.handle_message(&update_motion());
        assert!(events.iter().any(|e| matches!(e, WorldEvent::EntityMovementEvent { guid, .. } if *guid == REMOTE)));
        assert!(legacy.scene.remote_mover(REMOTE).is_none());
    }

    /// A creature created mid-run starts on its own movement manager
    /// already running (the create's movement buffer is unpacked onto it).
    #[test]
    fn object_create_movement_buffer_seeds_the_mover() {
        let mut state = world_with_remote(true);
        let mut movement_data = vec![MovementType::Invalid as u8, 0x00];
        movement_data.extend_from_slice(&0x3Du16.to_le_bytes());
        MovementInvalid {
            state: running(),
            sticky_object: None,
        }
        .pack(&mut movement_data);
        let mut data = ObjectDescriptionData::with_guid(Guid(0x8000_0B01));
        data.movement_data = Some(movement_data);
        let _ = state.handle_message(&GameMessage::ObjectCreate(Box::new(data)));
        let mover = state
            .scene
            .remote_mover(Guid(0x8000_0B01))
            .expect("the create seeded the mover");
        let interp = mover.movement.motion_interp_ref().expect("interp created");
        assert_eq!(interp.interpreted_state.forward_speed, 1.5);
    }

    /// NPC-facing fix (2026-10-11), end to end through the world handler: ACE's
    /// `Creature.Rotate` broadcast — an UpdateMotion TurnToObject at the LOCAL
    /// player — finds the player as a known target (its own entity), turns the
    /// NPC by its own motion toward the player's runtime body, and the NPC
    /// ends facing the player. The fixture NPC faces west (pose 0); the player
    /// stands due south of it.
    #[test]
    fn rotate_at_the_local_player_ends_facing_the_player() {
        use crate::spatial::SpatialBody;
        use holtburger_protocol::messages::movement::messages::motion::{
            TurnToObject, TurnToParameters,
        };
        const PLAYER: Guid = Guid(0x5000_0001);
        let mut state = world_with_remote(true);
        let player = WorldPosition {
            landblock_id: Guid(0x0102_0000),
            coords: Vector3::new(50.0, 44.0, 0.0),
            rotation: Quaternion::identity(),
        }
        .normalize_outdoor_cell();
        state.seed_local_player_entity(PLAYER, "Player", player);
        let _ = state.scene.register_body(SpatialBody::new(
            SpatialBodyId::LocalPlayer(PLAYER),
            player,
            web_time::Instant::now(),
        ));
        let rotate = GameMessage::UpdateMotion(Box::new(MovementEventData {
            guid: REMOTE,
            object_instance_sequence: 0,
            movement_sequence: 1,
            server_control_sequence: 0,
            is_autonomous: false,
            movement_type: MovementType::TurnToObject,
            motion_flags: 0,
            current_style: 0x3D,
            data: MovementTypeData::TurnToObject(TurnToObject {
                target: PLAYER,
                desired_heading: 0.0,
                params: TurnToParameters {
                    movement_parameters: 0x0001_EE0F,
                    speed: 1.0,
                    desired_heading: 0.0,
                },
            }),
        }));
        let _ = state.handle_message(&rotate);
        let mover = state.scene.remote_mover(REMOTE).expect("the NPC's own mover");
        assert_eq!(
            mover.movement.moveto_directive_target(),
            Some(PLAYER),
            "the player is a known target: a TurnToObject, not the heading fallback"
        );
        let t0 = web_time::Instant::now();
        for i in 0..90 {
            let now = t0 + std::time::Duration::from_secs_f32(i as f32 / 30.0);
            state.step_remote_objects(1.0 / 30.0, now, None);
            if !state.scene.remote_mover(REMOTE).unwrap().movement.is_moveto_active() {
                break;
            }
        }
        assert!(!state.scene.remote_mover(REMOTE).unwrap().movement.is_moveto_active());
        let body = state.scene.body(SpatialBodyId::Entity(REMOTE)).expect("NPC body");
        let heading = body.pose.rotation.to_heading().to_degrees();
        let error = ((heading - 270.0) + 540.0).rem_euclid(360.0) - 180.0;
        assert!(error.abs() < 0.01, "faces the player due south (pose 270), got {heading}°");
    }

    /// motion-remote-1 (2026-10-13), end to end: an object whose wire ObjScale
    /// (`PropertyFloat::DefaultScale`) is 2.0 runs twice as far per slice as
    /// an unscaled one — `step_remote_objects` reads the scale every slice, a
    /// scale the wire cannot mean (0) moves it unscaled, and
    /// `?remoteRootScale=off` ignores it.
    #[test]
    fn step_remote_objects_moves_a_scaled_object_at_its_scale() {
        use holtburger_common::properties::{PropertyFloat, WorldObjectPropertyAccessorsMut as _};
        let travel = |scale: Option<f64>, scale_on: bool| {
            let mut state = world_with_remote(true);
            state.scene.set_remote_root_scale_enabled(scale_on);
            state.scene.populate_terrain_heights(0x0102_0000, [0.0; 81]);
            if let Some(scale) = scale {
                state
                    .entities
                    .get_mut(REMOTE)
                    .expect("the remote entity")
                    .set_float_prop(PropertyFloat::DefaultScale, scale);
            }
            let _ = state.handle_message(&update_motion());
            let body = |state: &WorldState| state.scene.body(SpatialBodyId::Entity(REMOTE)).expect("body").pose;
            let start = body(&state);
            let t0 = web_time::Instant::now();
            for i in 0..10 {
                let now = t0 + std::time::Duration::from_secs_f32(i as f32 * 0.05);
                state.step_remote_objects(0.05, now, None);
            }
            let d = body(&state).coords - start.coords;
            (d.x * d.x + d.y * d.y).sqrt()
        };
        let unscaled = travel(None, true);
        assert!(unscaled > 1.0, "the run moves the body: {unscaled} m");
        let scaled = travel(Some(2.0), true);
        assert!((scaled / unscaled - 2.0).abs() < 1e-3, "scale 2: {scaled} m vs {unscaled} m");
        assert_eq!(travel(Some(1.0), true), unscaled, "scale 1.0 is the unscaled move");
        assert_eq!(travel(Some(0.0), true), unscaled, "a zero scale is ignored");
        assert_eq!(travel(Some(2.0), false), unscaled, "?remoteRootScale=off");
    }

    /// The per-slice world step prunes movers whose object left the world.
    #[test]
    fn step_remote_objects_prunes_departed_movers() {
        let mut state = world_with_remote(true);
        let _ = state.handle_message(&update_motion());
        assert!(state.scene.remote_mover(REMOTE).is_some());
        state.entities.remove(REMOTE);
        state.step_remote_objects(0.1, web_time::Instant::now(), None);
        assert!(state.scene.remote_mover(REMOTE).is_none());
    }
}
