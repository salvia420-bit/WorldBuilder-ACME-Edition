//! MoveTo refactor phase C (2026-10-10) — remote objects move through the
//! retail transition.
//!
//! Retail moves every object the same way: its motion's offset for the
//! quantum goes through `CPhysicsObj::transition` (acclient.c:320061 →
//! `find_transitional_position` :313171), which steps it up and down, slides
//! it along walls and objects and keeps its cell membership, and the result
//! is what `SetPositionInternal` stores. OpenAC does the same for every
//! remote (`RuntimeRemotePhysicsUpdater.Tick` → `ResolveWithTransition`,
//! `RuntimeRemotePhysicsUpdater.cs:279`). Before this the remote root motion
//! only sampled the floor under the destination: no walls, no objects, and
//! indoor remotes did not move between corrections at all.
//!
//! Scope: a remote whose OWN motion moves it this slice (the per-object
//! spine's root motion and the landing slide) — the moves the scene used to
//! floor-sample — within [`REMOTE_TRANSITION_RADIUS_M`] of the local player.
//! Interpolation corrections stay direct (they pull the body onto the
//! server's own transition result), and so does the airborne arc.
//!
//! The pass is three steps because the transition reads the whole world
//! (`TransitionEnv` for `WorldState`: terrain, water, cells, objects) while
//! the remote step mutates the scene: the scene plans the moves
//! (`SpatialScene::plan_remote_moves`), the world resolves them
//! ([`WorldState::resolve_remote_moves`]), and the scene step applies the
//! results in place of its floor sample.

use super::physics::{PLAYER_STEP_DOWN_HEIGHT, PLAYER_STEP_UP_HEIGHT};
use super::transition::{
    self, ObjectInfo, PLAYER_SETUP_HEIGHT, PLAYER_SETUP_SPHERE_HIGH_Z, PLAYER_SETUP_SPHERE_LOW_Z,
    PLAYER_SETUP_SPHERE_RADIUS, TransitionGates, TransitionInput, object_info_state,
};
use crate::state::WorldState;
use holtburger_common::position::WorldPosition;
use holtburger_common::{Guid, Plane, Vector3};
use std::collections::HashMap;

/// Remote movers sweep within this distance of the local player; farther
/// ones keep the floor-sampled move. Retail simulates every object it holds;
/// this bounds the cost to the objects a player can see interact with the
/// world (the outdoor landblock radius the client streams densely).
pub const REMOTE_TRANSITION_RADIUS_M: f32 = 96.0;

/// The transition the remote movers sweep with: the local player's gates
/// and driver toggles (one pipeline for every mover, as in retail).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RemoteTransitionConfig {
    pub gates: TransitionGates,
    pub faithful: bool,
    pub faithful_outdoor: bool,
    pub faithful_stepup: bool,
}

/// One remote mover's move this slice, before the transition: from its pose
/// to `end` (the full planar displacement of its own motion + slide).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RemoteMovePlan {
    pub guid: Guid,
    pub begin: WorldPosition,
    pub end: WorldPosition,
    /// World-frame walk velocity (its own motion, × the object's scale —
    /// motion-remote-1).
    pub walk_v: Vector3,
    /// The planar walk offset `end` carries: `walk_v` × quantum × the leash
    /// scale (motion-remote-3, `?remoteLeash`). The scene step accumulates
    /// it into the body's leash (`ConstraintManager::accumulate`).
    pub walk_offset: Vector3,
    /// `walk_v` before the object's scale — the leave-ground velocity if
    /// the move walks it off a ledge (`get_leave_ground_velocity`,
    /// acclient.c:343806-343833, takes the unscaled `get_state_velocity`).
    pub leave_walk_v: Vector3,
    /// The sliding physics velocity after this slice's friction.
    pub slide_v: Vector3,
    pub contact_plane: Option<(Plane, u32)>,
    pub wall_normal: Option<Vector3>,
}

/// A planned move after the transition.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ResolvedRemoteMove {
    pub pose: WorldPosition,
    /// The physics velocity the body keeps: the slide on the ground, the
    /// leave-ground velocity off it.
    pub velocity: Vector3,
    /// The move ended out of contact (walked off a ledge).
    pub leave_ground: bool,
    pub contact_plane: Option<(Plane, u32)>,
    pub wall_normal: Option<Vector3>,
    /// The plan's [`RemoteMovePlan::walk_offset`] — the leash accumulates
    /// the offset BEFORE the sweep, as retail's `adjust_offset` runs before
    /// the transition (motion-remote-3).
    pub walk_offset: Vector3,
}

impl WorldState {
    /// Resolve the planned remote moves through the transition (see the
    /// module doc). Each mover sweeps with its own profile
    /// ([`Self::remote_object_info`]) and is excluded from its own sweep.
    pub fn resolve_remote_moves(
        &self,
        plans: &[RemoteMovePlan],
        config: &RemoteTransitionConfig,
    ) -> HashMap<Guid, ResolvedRemoteMove> {
        plans
            .iter()
            .map(|plan| {
                let input = TransitionInput {
                    begin: plan.begin,
                    end: plan.end,
                    object: self.remote_object_info(plan.guid),
                    airborne: false,
                    descending: true,
                    entry_descending: true,
                    force_grounded: false,
                    gates: config.gates,
                    last_known_wall_normal: plan.wall_normal,
                    frames_stationary_fall: 0,
                    last_contact_plane: plan.contact_plane,
                    // Grounded locomotion is animation-driven: no physics
                    // velocity enters the contact test (retail
                    // `check_contact`, acclient.c:316536).
                    physics_velocity: Vector3::zero(),
                };
                let outcome = transition::find_transitional_position_dispatch(
                    self,
                    &input,
                    config.faithful,
                    config.faithful_outdoor,
                    config.faithful_stepup,
                );
                let mut pose = outcome.pose;
                // The motion owns the heading; the sweep only places.
                pose.rotation = plan.begin.rotation;
                let leave_ground = !outcome.grounded;
                let velocity = if !leave_ground {
                    plan.slide_v
                } else if plan.walk_v != Vector3::zero() {
                    Vector3::new(plan.leave_walk_v.x, plan.leave_walk_v.y, 0.0)
                } else {
                    plan.slide_v
                };
                (
                    plan.guid,
                    ResolvedRemoteMove {
                        pose,
                        velocity,
                        leave_ground,
                        contact_plane: outcome.contact_plane.or(plan.contact_plane),
                        wall_normal: outcome.wall_normal.or(plan.wall_normal),
                        walk_offset: plan.walk_offset,
                    },
                )
            })
            .collect()
    }

    /// A remote mover's `OBJECTINFO` (acclient.c:314118-314143 +
    /// `get_object_info` :319074-319117): its Setup's spheres and step
    /// heights × its scale, ethereal from its PhysicsState, EDGE_SLIDE from
    /// PhysicsState `0x400000`, and the weenie's player / impenetrable / PK
    /// bits. An unresolved Setup sweeps as the human body (Setup
    /// `0x02000001`), which is what most moving remotes are.
    pub fn remote_object_info(&self, guid: Guid) -> ObjectInfo {
        use holtburger_common::properties::ObjectDescriptionFlag as F;
        use holtburger_common::properties::WorldObjectExt as _;

        let entity = self.entities.get(guid);
        let scale = entity
            .and_then(|e| e.obj_scale())
            .map(|s| s as f32)
            .filter(|s| s.is_finite() && *s > 0.0)
            .unwrap_or(1.0);
        let shapes = entity
            .and_then(WorldState::entity_setup_did)
            .and_then(|id| self.scene.setup_collision_shapes(id));

        let mut capsule = [
            (PLAYER_SETUP_SPHERE_LOW_Z, PLAYER_SETUP_SPHERE_RADIUS),
            (PLAYER_SETUP_SPHERE_HIGH_Z, PLAYER_SETUP_SPHERE_RADIUS),
        ];
        let mut height = PLAYER_SETUP_HEIGHT;
        let mut step = (PLAYER_STEP_UP_HEIGHT, PLAYER_STEP_DOWN_HEIGHT);
        if let Some(shapes) = shapes.as_deref() {
            let mut spheres: Vec<(f32, f32)> = shapes
                .spheres
                .iter()
                .filter(|s| s.radius.is_finite() && s.radius > 0.0)
                .map(|s| (s.center.z * scale, s.radius * scale))
                .collect();
            spheres.sort_by(|a, b| a.0.total_cmp(&b.0));
            if let (Some(&low), Some(&high)) = (spheres.first(), spheres.last()) {
                capsule = [low, high];
                height = (high.0 + high.1).max(height * scale.min(1.0));
            } else if let Some(c) = shapes
                .cylspheres
                .iter()
                .find(|c| c.radius.is_finite() && c.radius > 0.0)
            {
                let r = c.radius * scale;
                let h = (c.height * scale).max(2.0 * r);
                capsule = [(c.origin.z * scale + r, r), (c.origin.z * scale + h - r, r)];
                height = c.origin.z * scale + h;
            }
            // The step-height half is shared with the local player's body
            // (`transition::mover_body_from_setup`, physics-collision-2).
            if let Some(scaled) = transition::scaled_setup_step_heights(shapes, scale) {
                step = scaled;
            }
        }

        let mut state = object_info_state::CONTACT;
        let mut ethereal = false;
        if let Some(e) = entity {
            let physics = e.physics_state.bits();
            // `get_object_info` (acclient.c:319074-319117).
            if physics & 0x0040_0000 != 0 {
                state |= object_info_state::EDGE_SLIDE;
            }
            ethereal = physics & 0x4 != 0;
            // `OBJECTINFO::init` weenie bits (:314131-314142).
            if e.flags.contains(F::PLAYER) {
                state |= object_info_state::IS_PLAYER;
            }
            if e.flags.contains(F::FREE_PK_STATUS) {
                state |= object_info_state::IS_IMPENETRABLE;
            }
            if e.flags.contains(F::PLAYER_KILLER) {
                state |= object_info_state::IS_PK;
            }
            if e.flags.contains(F::PK_LITE_STATUS) {
                state |= object_info_state::IS_PKLITE;
            }
        }
        ObjectInfo {
            state,
            step_up_height: step.0,
            step_down_height: step.1,
            ethereal,
            radius: capsule[0].1.max(capsule[1].1),
            height,
            capsule,
            self_guid: guid,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::entity::Entity;
    use crate::spatial::obj_collision::SetupCollisionShapes;
    use crate::spatial::types::{BuildingAabbEntry, BuildingId};
    use crate::spatial::{AuthoritativeBodySync, RemoteCorrectionCtx, SpatialBody, SpatialBodyId};
    use holtburger_common::properties::PhysicsState;
    use holtburger_common::{Aabb, Quaternion, Sphere};
    use holtburger_protocol::messages::movement::messages::motion::MovementInvalid;
    use holtburger_protocol::messages::movement::{InterpretedMotionState, MovementStateFlags};
    use holtburger_protocol::messages::{MovementEventData, MovementType, MovementTypeData};
    use web_time::Instant;

    const PLAYER: Guid = Guid(0x5000_0001);
    const REMOTE: Guid = Guid(0x8000_0042);
    const LB: u32 = 0x1234_0000;

    fn pose_at(x: f32, y: f32, heading_deg: f32) -> WorldPosition {
        WorldPosition {
            landblock_id: Guid(LB),
            coords: Vector3::new(x, y, 0.0),
            rotation: Quaternion::from_heading(heading_deg.to_radians()),
        }
        .normalize_outdoor_cell()
    }

    fn config() -> RemoteTransitionConfig {
        RemoteTransitionConfig {
            gates: TransitionGates {
                step_up_down: true,
                walkable_step_down: false,
                landing_walkable: false,
                settle_land: false,
                water_collision: false,
                terrain_walkable_gate: false,
                local_envcell_entry: true,
                ramp_floor_snap_fix: true,
                skip_parented_entities: true,
                walkable_reinsert_probe: false,
                outdoor_static_grounding: false,
                retail_ground: false,
                world_frame_terrain_plane: true,
                airborne_check_contact: true,
                walkable_landing_ground: true,
            },
            faithful: false,
            faithful_outdoor: false,
            faithful_stepup: false,
        }
    }

    /// A world with the spine + sweep on, flat terrain at 0, the local
    /// player at (50, 40) and a remote at `remote` running east (AC 180°)
    /// at run rate 1.0 (4 m/s fallback).
    fn world(remote: WorldPosition) -> WorldState {
        let mut world = WorldState::synthetic();
        world.set_remote_interp_enabled(true);
        world.scene.set_remote_spine_enabled(true);
        world.scene.set_remote_sweep_enabled(true);
        world.populate_terrain_heights_scene_resident(LB, [0.0; 81]);
        let player = pose_at(50.0, 40.0, 90.0);
        world.seed_local_player_entity(PLAYER, "Player", player);
        world.scene.register_body(SpatialBody::new(
            SpatialBodyId::LocalPlayer(PLAYER),
            player,
            Instant::now(),
        ));
        world.add_entity(Entity::new(REMOTE, "Drudge".to_string(), remote));
        world.scene.reconcile_authoritative_body_with_remote(
            SpatialBodyId::Entity(REMOTE),
            remote,
            Vector3::zero(),
            Vector3::zero(),
            AuthoritativeBodySync::Snapshot,
            Instant::now(),
            Some(RemoteCorrectionCtx {
                contact: Some(true),
                player_pose: Some(player),
            }),
        );
        let running = MovementEventData {
            guid: REMOTE,
            object_instance_sequence: 0,
            movement_sequence: 1,
            server_control_sequence: 0,
            is_autonomous: false,
            movement_type: MovementType::Invalid,
            motion_flags: 0,
            current_style: 0x3D,
            data: MovementTypeData::Invalid(MovementInvalid {
                state: InterpretedMotionState {
                    flags: MovementStateFlags::FORWARD_COMMAND | MovementStateFlags::FORWARD_SPEED,
                    num_commands: 0,
                    current_style: None,
                    forward_command: Some(0x0007u16.into()),
                    sidestep_command: None,
                    turn_command: None,
                    forward_speed: Some(1.0),
                    sidestep_speed: None,
                    turn_speed: None,
                    commands: Vec::new(),
                },
                sticky_object: None,
            }),
        };
        let _ = world.apply_remote_movement(REMOTE, &running);
        world
    }

    fn wall_ahead(world: &mut WorldState, at: WorldPosition) {
        let g = at.global_coords();
        // The index is keyed by the exact cell the mover stands in.
        world.scene.insert_building_aabb(
            at.landblock_id.0,
            BuildingAabbEntry {
                building_id: BuildingId::new(LB, 1, 0),
                part_index: 0,
                aabb: Aabb {
                    min: Vector3::new(g.x + 1.0, g.y - 5.0, g.z - 1.0),
                    max: Vector3::new(g.x + 2.0, g.y + 5.0, g.z + 10.0),
                },
                active: true,
            },
        );
    }

    fn remote_x(world: &WorldState) -> f32 {
        world
            .scene
            .body(SpatialBodyId::Entity(REMOTE))
            .unwrap()
            .pose
            .global_coords()
            .x
    }

    /// The remote's own run goes through the transition: it stops at a
    /// building wall instead of running through it (the floor sample has
    /// no walls).
    #[test]
    fn swept_remote_stops_at_a_wall() {
        let start = pose_at(50.0, 50.0, 180.0);
        let x0 = start.global_coords().x;
        let now = Instant::now();

        let mut swept = world(start);
        wall_ahead(&mut swept, start);
        for _ in 0..30 {
            swept.step_remote_objects(1.0 / 30.0, now, Some(config()));
        }
        let x = remote_x(&swept);
        assert!(x > x0 + 0.2, "it ran up to the wall: moved {}", x - x0);
        assert!(x <= x0 + 1.0, "stopped at the wall face: moved {}", x - x0);

        let mut floor = world(start);
        wall_ahead(&mut floor, start);
        for _ in 0..30 {
            floor.step_remote_objects(1.0 / 30.0, now, None);
        }
        assert!(remote_x(&floor) > x0 + 3.5, "the floor sample runs through it");
    }

    /// Only remotes near the local player sweep.
    #[test]
    fn far_remotes_are_not_planned() {
        let near = world(pose_at(50.0, 50.0, 180.0));
        let roots = near.scene.remote_root_motions(None);
        assert_eq!(near.scene.plan_remote_moves(0.1, &roots, REMOTE_TRANSITION_RADIUS_M).len(), 1);
        assert!(near.scene.plan_remote_moves(0.1, &roots, 5.0).is_empty(), "10 m away > 5 m");
    }

    /// The mover sweeps with its OWN Setup: spheres and step heights × its
    /// scale, EDGE_SLIDE from its PhysicsState, ethereal from bit 0x4.
    #[test]
    fn remote_object_info_comes_from_its_setup() {
        let mut world = world(pose_at(50.0, 50.0, 180.0));
        world.scene.register_setup_collision_shapes(
            0x0200_0F00,
            SetupCollisionShapes {
                cylspheres: Vec::new(),
                spheres: vec![
                    Sphere { center: Vector3::new(0.0, 0.0, 1.6), radius: 0.7 },
                    Sphere { center: Vector3::new(0.0, 0.0, 0.7), radius: 0.7 },
                ],
                step_heights: Some((0.9, 2.0)),
            },
        );
        {
            let entity = world.entities.get_mut(REMOTE).unwrap();
            entity.gfx_id = Some(0x0200_0F00);
            entity.physics_state = PhysicsState::from_bits_retain(0x0040_0400);
        }
        let info = world.remote_object_info(REMOTE);
        assert_eq!(info.capsule, [(0.7, 0.7), (1.6, 0.7)], "low sphere first");
        assert_eq!((info.step_up_height, info.step_down_height), (0.9, 2.0));
        assert!(info.state & object_info_state::EDGE_SLIDE != 0);
        assert!(info.state & object_info_state::IS_PLAYER == 0);
        assert!(!info.ethereal);
        assert_eq!(info.self_guid, REMOTE);

        // No Setup: the human body.
        let bare = world.remote_object_info(Guid(0x8000_9999));
        assert_eq!(bare.capsule[0], (PLAYER_SETUP_SPHERE_LOW_Z, PLAYER_SETUP_SPHERE_RADIUS));
        assert_eq!(bare.step_up_height, PLAYER_STEP_UP_HEIGHT);
    }
}
