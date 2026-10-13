//! physics-collision-2 (2026-10-13, `?setupPlayerBody`) — the local player's
//! transition profile sweeps with its OWN Setup's spheres and step heights ×
//! scale (retail `CPhysicsObj::transition` acclient.c:320061-320102 +
//! `OBJECTINFO::init` :314118-314129), not always the human Setup
//! `0x02000001`. Human characters stay byte-identical; the const default is
//! on and `?setupPlayerBody=off` restores the human body for every player.
#![cfg(test)]

use super::system::MovementSystem;
use holtburger_common::position::WorldPosition;
use holtburger_common::properties::{
    PropertyDataId, PropertyFloat, WorldObjectPropertyAccessorsMut as _,
};
use holtburger_common::{Guid, Sphere, Vector3};
use holtburger_world::WorldState;
use holtburger_world::spatial::obj_collision::SetupCollisionShapes;
use holtburger_world::spatial::transition::ObjectInfo;

const PLAYER: Guid = Guid(0x5000_0001);
const HUMAN_SETUP: u32 = 0x0200_0001;
/// Olthoi player Setup — DAT values (client_portal.dat, 2026-10-13):
/// spheres r 0.65 at z 0.65 / 1.68, step 0.942 / 0.942, height 2.33.
const OLTHOI_SETUP: u32 = 0x0200_1A21;

fn sphere(z: f32, r: f32) -> Sphere {
    Sphere {
        center: Vector3::new(0.0, 0.0, z),
        radius: r,
    }
}

/// A world whose local player entity carries `setup` at `scale`; the
/// Setup's shapes are registered only when `resident`.
fn world_with_player_setup(setup: u32, scale: Option<f64>, resident: bool) -> WorldState {
    let mut world = WorldState::synthetic();
    world.seed_local_player_entity(PLAYER, "Player", WorldPosition::default());
    {
        let e = world.entities.get_mut(PLAYER).unwrap();
        e.set_did_prop(PropertyDataId::Setup, Guid(setup));
        if let Some(scale) = scale {
            e.set_float_prop(PropertyFloat::DefaultScale, scale);
        }
    }
    if resident {
        let (shapes, height) = if setup == HUMAN_SETUP {
            (
                SetupCollisionShapes {
                    cylspheres: Vec::new(),
                    spheres: vec![sphere(0.475, 0.48), sphere(1.35, 0.48)],
                    step_heights: Some((0.6, 1.5)),
                },
                1.835,
            )
        } else {
            (
                SetupCollisionShapes {
                    cylspheres: Vec::new(),
                    spheres: vec![sphere(0.65, 0.65), sphere(1.68, 0.65)],
                    step_heights: Some((0.942, 0.942)),
                },
                2.33,
            )
        };
        world.scene.register_setup_collision_shapes(setup, shapes);
        world.register_setup_part_dims(setup, 0.9, height);
    }
    world
}

/// The human body `for_local_player` hardcodes (state bits aside).
fn human_object() -> ObjectInfo {
    ObjectInfo::for_local_player(None, None, false, PLAYER)
}

fn body_of(o: &ObjectInfo) -> ([(f32, f32); 2], f32, f32, f32, f32) {
    (o.capsule, o.radius, o.height, o.step_up_height, o.step_down_height)
}

/// A resident non-human Setup drives the profile's capsule and step heights.
#[test]
fn transition_profile_sweeps_with_the_player_setup() {
    let world = world_with_player_setup(OLTHOI_SETUP, None, true);
    let (object, _gates) = MovementSystem::transition_profile(&world);
    assert_eq!(object.capsule, [(0.65, 0.65), (1.68, 0.65)]);
    assert_eq!(object.radius, 0.65);
    assert_eq!(object.height, 2.33);
    assert_eq!((object.step_up_height, object.step_down_height), (0.942, 0.942));
    assert_eq!(object.self_guid, PLAYER);

    // Scaled: spheres and step heights × obj_scale.
    let scaled = world_with_player_setup(OLTHOI_SETUP, Some(2.0), true);
    let (object, _) = MovementSystem::transition_profile(&scaled);
    let s = 2.0_f32;
    assert_eq!(object.capsule, [(0.65 * s, 0.65 * s), (1.68 * s, 0.65 * s)]);
    assert_eq!(object.height, 2.33 * s);
    assert_eq!((object.step_up_height, object.step_down_height), (0.942 * s, 0.942 * s));
}

/// The escape (`setup_body = false`) and an unresolved Setup both keep the
/// human constants.
#[test]
fn escape_and_unresolved_setup_keep_the_human_body() {
    let human = body_of(&human_object());

    let world = world_with_player_setup(OLTHOI_SETUP, Some(2.0), true);
    let (off, _) = MovementSystem::transition_profile_with_body(&world, false);
    assert_eq!(body_of(&off), human, "?setupPlayerBody=off");

    let unparsed = world_with_player_setup(OLTHOI_SETUP, None, false);
    let (object, _) = MovementSystem::transition_profile(&unparsed);
    assert_eq!(body_of(&object), human, "Setup not resident yet");

    let mut bare = WorldState::synthetic();
    bare.seed_local_player_entity(PLAYER, "Player", WorldPosition::default());
    let (object, _) = MovementSystem::transition_profile(&bare);
    assert_eq!(body_of(&object), human, "no Setup DID");
}

/// The byte-identical pin: the human Setup resident gives the SAME profile as
/// the escape — every ObjectInfo field, bit for bit.
#[test]
fn human_setup_profile_is_byte_identical() {
    let world = world_with_player_setup(HUMAN_SETUP, None, true);
    let (on, gates_on) = MovementSystem::transition_profile(&world);
    let (off, gates_off) = MovementSystem::transition_profile_with_body(&world, false);
    assert_eq!(on, off);
    assert_eq!(gates_on, gates_off);
    for (a, b) in [
        (on.capsule[0].0, off.capsule[0].0),
        (on.capsule[0].1, off.capsule[0].1),
        (on.capsule[1].0, off.capsule[1].0),
        (on.capsule[1].1, off.capsule[1].1),
        (on.radius, off.radius),
        (on.height, off.height),
        (on.step_up_height, off.step_up_height),
        (on.step_down_height, off.step_down_height),
    ] {
        assert_eq!(a.to_bits(), b.to_bits());
    }
}

/// An explicit A7-R1 PlayerState step height still wins over the Setup's.
#[test]
fn explicit_player_step_heights_override_the_setup() {
    let mut world = world_with_player_setup(OLTHOI_SETUP, None, true);
    world.player.step_up_height = Some(0.3);
    let (object, _) = MovementSystem::transition_profile(&world);
    assert_eq!(object.step_up_height, 0.3);
    assert_eq!(object.step_down_height, 0.942, "the unset half comes from the Setup");
    assert_eq!(object.capsule, [(0.65, 0.65), (1.68, 0.65)]);
}

/// The runtime carrier: default on (the const), `set_setup_player_body(false)`
/// is the `?setupPlayerBody=off` escape.
#[test]
fn runtime_carrier_defaults_on() {
    let mut system = MovementSystem::new();
    assert!(system.setup_player_body_enabled());
    system.set_setup_player_body(false);
    assert!(!system.setup_player_body_enabled());
    system.set_setup_player_body(true);
    assert!(system.setup_player_body_enabled());
}
