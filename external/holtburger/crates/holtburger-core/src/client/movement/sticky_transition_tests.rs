//! STICKY-TRANSITION (2026-10-11, `?stickyIdleTransition`) — owner: "with
//! sticky melee i can get stuck in the air or get sucked into the ground".
//!
//! The drive-less sticky slice (`step_local_sticky_idle_slice`, every swing
//! frame of a standing attacker after the server MoveTo arrival) moved the
//! pose by the sticky pull and wrote it back with `z` held — no transition:
//! no gravity, no ground following, no collision. Retail runs sticky as one
//! slot of the per-object offset chain (`UpdatePositionInternal`
//! acclient.c:319989 → `StickyManager::adjust_offset` :388519, planar only,
//! z zeroed :388557 → `UpdatePhysicsInternal` adds gravity → the transition
//! validates the move). `step_local_sticky_idle_slice_via_transition` runs
//! the manual slice's transition pass for those frames instead.
//!
//! These pin the fix against the legacy step on the same fixtures: a stuck
//! attacker left in the air now falls and lands, and one pulled up a slope
//! follows the ground instead of sinking into it.
#![cfg(test)]

use super::system::MovementSystem;
use holtburger_common::position::WorldPosition;
use holtburger_common::{Guid, Quaternion, Vector3};
use holtburger_protocol::messages::movement::MotionStance;
use holtburger_world::entity::Entity;
use holtburger_world::{
    PlayerMotionTableSource, SelfMovementCapabilities, SelfMovementKinematics, WorldState,
};
use std::time::Duration;

const SLICE: Duration = Duration::from_millis(100);
const PLAYER: Guid = Guid(0x5000_0C01);
const TARGET: Guid = Guid(0x8000_0C02);

fn capabilities() -> SelfMovementCapabilities {
    SelfMovementCapabilities {
        kinematics: SelfMovementKinematics {
            source: PlayerMotionTableSource::DirectProperty {
                motion_table_id: 0x0900_0001,
            },
            motion_table_id: 0x0900_0001,
            stance: MotionStance::NonCombat as u32,
            base_walk_forward_velocity: Vector3::new(0.0, 2.602, 0.0),
            base_run_forward_velocity: Vector3::new(0.0, 4.0, 0.0),
            base_turn_left_omega: Vector3::new(0.0, 0.0, -1.5),
            base_turn_right_omega: Vector3::new(0.0, 0.0, 1.5),
        },
        run_rate_scalar: 1.0,
    }
}

/// LB (0,0) with scene-resident terrain `heights` (the faithful outdoor
/// driver), the player at `(x, y, z)` and a sticky target at `target`, fed.
/// No drive is active — the post-MoveTo-arrival melee state.
fn stuck_attacker(
    heights: [f32; 81],
    player: Vector3,
    target: Vector3,
) -> (WorldState, MovementSystem) {
    let mut world = WorldState::synthetic();
    world.player.guid = PLAYER;
    world.set_self_movement_capabilities_override(capabilities());
    world.populate_terrain_heights_scene_resident(0, heights);
    let pose = WorldPosition {
        landblock_id: Guid(0x0000_0001),
        coords: player,
        rotation: Quaternion::identity(),
    };
    world.seed_local_player_entity(PLAYER, "Player", pose);
    let _ = world.set_player_position(pose);
    let target_pose = WorldPosition {
        landblock_id: Guid(0x0000_0001),
        coords: target,
        rotation: Quaternion::identity(),
    };
    world
        .entities
        .insert(Entity::new(TARGET, "Drudge".to_string(), target_pose));
    // The browser default: the composed retail chain (`?retailLeash`).
    world.scene.set_local_retail_leash(true);
    world.scene.stick_local_player_to(TARGET, 0.0);
    world.scene.sticky_pose_feed(TARGET, target_pose);
    (world, MovementSystem::new())
}

fn pose(world: &WorldState) -> WorldPosition {
    world.local_player_runtime_pose().expect("runtime pose")
}

/// "Stuck in the air": a stuck attacker above the ground (a knock-up, a
/// step off a ledge mid-swing, a hover the old step left behind). The
/// transition pass keeps gravity — he falls and lands — while still pulled
/// toward the target. The legacy step (`=off`) holds his height forever.
#[test]
fn stuck_attacker_in_the_air_falls_and_lands() {
    let ground = 5.0_f32;
    let start = Vector3::new(90.0, 96.0, ground + 1.0);
    let (mut world, movement) =
        stuck_attacker([ground; 81], start, Vector3::new(93.0, 96.0, ground));
    world.player.begin_fall();
    assert!(
        movement
            .current_local_drive_control(&world, SLICE)
            .is_none(),
        "no drive: the idle melee frame"
    );

    let mut landed_at = None;
    for i in 0..8 {
        assert!(
            movement.step_local_sticky_idle_slice_via_transition(&mut world, SLICE),
            "a live sticky target with the chain armed claims the slice ({i})"
        );
        if !world.player.is_airborne {
            landed_at = Some(i);
            break;
        }
    }
    let after = pose(&world);
    assert!(
        landed_at.is_some(),
        "falls 1 m and lands well inside the 1 s sticky window (z={:.3})",
        after.coords.z
    );
    assert!(
        (after.coords.z - ground).abs() < 0.02,
        "on the ground: z={:.3}",
        after.coords.z
    );
    assert!(
        after.coords.x > start.x + 0.5,
        "the sticky pull still moved him toward the target: x={:.3}",
        after.coords.x
    );

    // The escape: the legacy step pulls him across with his height held.
    let (mut legacy, mut movement) =
        stuck_attacker([ground; 81], start, Vector3::new(93.0, 96.0, ground));
    legacy.player.begin_fall();
    movement.set_sticky_idle_transition(false);
    assert!(!movement.step_local_sticky_idle_slice_via_transition(&mut legacy, SLICE));
    for _ in 0..4 {
        movement.step_local_sticky_idle_slice(&mut legacy, SLICE);
    }
    let held = pose(&legacy);
    assert!(held.coords.x > start.x, "legacy: pulled across");
    assert_eq!(
        held.coords.z, start.z,
        "legacy (`=off`): z held — the hover the owner saw"
    );
}

/// "Sucked into the ground": the target stands uphill. The transition pass
/// follows the slope (the pull goes through the same step-up / contact-plane
/// path a walk does); the legacy step keeps the start height and ends up
/// below the terrain.
#[test]
fn stuck_attacker_pulled_uphill_follows_the_ground() {
    // A gentle 7° slope rising toward +X: 3 m per 24 m vertex.
    let mut slope = [0.0f32; 81];
    for vx in 0..9 {
        for vy in 0..9 {
            slope[vx * 9 + vy] = vx as f32 * 3.0;
        }
    }
    let probe = {
        let mut w = WorldState::synthetic();
        w.populate_terrain_heights_scene_resident(0, slope);
        w
    };
    let (x0, y0) = (90.0_f32, 96.0_f32);
    let z0 = probe.terrain_height_at(x0, y0).expect("terrain");
    let target = Vector3::new(
        x0 + 4.0,
        y0,
        probe.terrain_height_at(x0 + 4.0, y0).expect("terrain"),
    );
    let (mut world, movement) = stuck_attacker(slope, Vector3::new(x0, y0, z0), target);

    for i in 0..8 {
        assert!(
            movement.step_local_sticky_idle_slice_via_transition(&mut world, SLICE),
            "claims slice {i}"
        );
    }
    let after = pose(&world);
    let g = after.global_coords();
    let ground = probe.terrain_height_at(g.x, g.y).expect("terrain");
    assert!(
        after.coords.x > x0 + 1.0,
        "pulled uphill toward the target: x={:.3}",
        after.coords.x
    );
    assert!(!world.player.is_airborne, "stays on the slope");
    assert!(
        (after.coords.z - ground).abs() < 0.05,
        "follows the ground: z={:.3} terrain={ground:.3}",
        after.coords.z
    );

    // Legacy (`=off`): the same pull at a held z is under the slope.
    let (mut legacy, mut movement) = stuck_attacker(slope, Vector3::new(x0, y0, z0), target);
    movement.set_sticky_idle_transition(false);
    for _ in 0..8 {
        movement.step_local_sticky_idle_slice(&mut legacy, SLICE);
    }
    let held = pose(&legacy);
    let hg = held.global_coords();
    let under = probe.terrain_height_at(hg.x, hg.y).expect("terrain");
    assert!(held.coords.x > x0 + 1.0, "legacy: pulled uphill too");
    assert!(
        held.coords.z < under - 0.1,
        "legacy: sunk into the slope (z={:.3}, terrain {under:.3})",
        held.coords.z
    );
}

/// Inert without a sticky target or without the composed chain (the
/// legacy step keeps those frames), so nothing else changes.
#[test]
fn sticky_idle_transition_is_inert_without_target_or_chain() {
    let (mut world, movement) = stuck_attacker(
        [5.0; 81],
        Vector3::new(90.0, 96.0, 5.0),
        Vector3::new(93.0, 96.0, 5.0),
    );
    world.scene.set_local_retail_leash(false);
    assert!(
        !movement.step_local_sticky_idle_slice_via_transition(&mut world, SLICE),
        "chain off"
    );
    world.scene.set_local_retail_leash(true);
    let _ = world.scene.unstick_local_player();
    assert!(
        !movement.step_local_sticky_idle_slice_via_transition(&mut world, SLICE),
        "no target"
    );
}
