//! motion-remote-2 (2026-10-13) — `?remoteRestHeading`: a near, on-contact
//! remote UpdatePosition that lands within 0.05 m of the body takes the wire
//! heading unless the body is moving-to. Retail
//! `InterpolationManager::InterpolateTo`'s else arm:
//! `set_heading(Frame::get_heading(p), 1)`, then `StopInterpolating`
//! (acclient.c:389129-389136); keep_heading = `IsMovingTo()` from
//! `MoveOrTeleport` (:323492-323495). Before, the arm returned without the
//! heading and an at-rest body kept whatever its own turn integration left.

use super::*;
use holtburger_common::position::WorldPosition;
use holtburger_common::{Guid, Quaternion, Vector3};
use std::f32::consts::{FRAC_PI_2, PI, TAU};
use web_time::Instant;

const GUID: Guid = Guid(0x7000_0099);

fn pose(x: f32, y: f32, heading: f32) -> WorldPosition {
    WorldPosition {
        landblock_id: Guid(0x0102_0000),
        coords: Vector3::new(x, y, 0.0),
        rotation: Quaternion::from_heading(heading),
    }
}

/// Sets this thread's switch and restores the default (ON) on drop, even
/// when an assertion fails.
struct RestHeadingSwitch;

impl RestHeadingSwitch {
    fn set(on: bool) -> Self {
        set_remote_rest_heading(on);
        Self
    }
}

impl Drop for RestHeadingSwitch {
    fn drop(&mut self) {
        set_remote_rest_heading(true);
    }
}

fn reconcile(
    scene: &mut SpatialScene,
    target: WorldPosition,
    contact: Option<bool>,
    player: WorldPosition,
) {
    scene.reconcile_authoritative_body_with_remote(
        SpatialBodyId::Entity(GUID),
        target,
        Vector3::zero(),
        Vector3::zero(),
        AuthoritativeBodySync::Snapshot,
        Instant::now(),
        Some(RemoteCorrectionCtx {
            contact,
            player_pose: Some(player),
        }),
    );
}

/// The remote driver on and the body seeded at `start` (the first reconcile
/// creates it), so the rows below act on an EXISTING body with the player
/// standing on it (well inside 96 m).
fn scene_at(start: WorldPosition) -> SpatialScene {
    let mut scene = SpatialScene::new();
    scene.set_remote_interp_enabled(true);
    reconcile(&mut scene, start, Some(true), start);
    assert_eq!(remote_body(&scene).pose, start, "seed snap");
    scene
}

fn remote_body(scene: &SpatialScene) -> &SpatialBody {
    scene.body(SpatialBodyId::Entity(GUID)).expect("remote body")
}

/// Signed heading change `to − from` folded to (−π, π].
fn heading_delta(from: f32, to: f32) -> f32 {
    let mut d = (to - from) % TAU;
    if d > PI {
        d -= TAU;
    } else if d <= -PI {
        d += TAU;
    }
    d
}

#[test]
fn remote_rest_heading_defaults_on() {
    assert!(remote_rest_heading_enabled(), "DEFAULT ON; `=off` is the escape");
}

/// (a) A resting body (heading 0) receives its own coords with heading +90°:
/// it takes the heading, keeps its position, and nothing is queued. A gap
/// under 0.05 m is the same arm (the position still stays).
#[test]
fn at_rest_update_position_adopts_the_wire_heading() {
    let _switch = RestHeadingSwitch::set(true);
    for nudge in [0.0, 0.03] {
        let start = pose(50.0, 50.0, 0.0);
        let mut scene = scene_at(start);
        let wire = pose(50.0 + nudge, 50.0, FRAC_PI_2);
        reconcile(&mut scene, wire, Some(true), start);
        let body = remote_body(&scene);
        let off = heading_delta(FRAC_PI_2, body.pose.rotation.to_heading()).abs();
        assert!(off < 1e-4, "nudge {nudge}: adopted the wire heading ({off} rad off)");
        assert_eq!(body.pose.coords, start.coords, "nudge {nudge}: position untouched");
        assert_eq!(body.pose.landblock_id, start.landblock_id);
        assert_eq!((body.pose.rotation.x, body.pose.rotation.y), (0.0, 0.0), "yaw only");
        assert!(!body.position_manager.queue_active(), "nudge {nudge}: nothing queued");
        assert_eq!(body.authoritative_pose, Some(wire));
    }
}

/// (a') A queued node is stopped by a wire pose on the body's own spot, and
/// that pose's heading is taken (`StopInterpolating` after `set_heading`).
#[test]
fn at_rest_update_position_stops_a_pending_node_and_takes_its_heading() {
    let _switch = RestHeadingSwitch::set(true);
    let start = pose(50.0, 50.0, 0.0);
    let mut scene = scene_at(start);
    reconcile(&mut scene, pose(52.0, 50.0, 0.0), Some(true), start);
    assert!(remote_body(&scene).position_manager.queue_active(), "2 m: queued");
    reconcile(&mut scene, pose(50.0, 50.0, FRAC_PI_2), Some(true), start);
    let body = remote_body(&scene);
    assert!(!body.position_manager.queue_active(), "≤0.05 m: interpolation stopped");
    assert_eq!(body.pose.coords, start.coords);
    let off = heading_delta(FRAC_PI_2, body.pose.rotation.to_heading()).abs();
    assert!(off < 1e-4, "adopted the wire heading ({off} rad off)");
}

/// (b) keep_heading: a moving-to body keeps its own heading; and a
/// `!contact` frame never reaches InterpolateTo (acclient.c:323480-323481).
#[test]
fn moving_to_or_airborne_keeps_its_heading_at_rest() {
    let _switch = RestHeadingSwitch::set(true);
    let start = pose(50.0, 50.0, 0.0);

    let mut scene = scene_at(start);
    scene.set_remote_moveto(GUID, true, None, None);
    reconcile(&mut scene, pose(50.0, 50.0, FRAC_PI_2), Some(true), start);
    let body = remote_body(&scene);
    assert_eq!(body.pose.rotation, start.rotation, "keep_heading = IsMovingTo()");
    assert!(!body.position_manager.queue_active());

    let mut scene = scene_at(start);
    reconcile(&mut scene, pose(50.0, 50.0, FRAC_PI_2), Some(false), start);
    assert_eq!(remote_body(&scene).pose, start, "!contact: working pose untouched");
}

/// (c) A node 1 m away is queued as before: nothing is written at ingest and
/// the heading eases toward the node's when stepped.
#[test]
fn a_queued_node_still_eases_the_heading() {
    let _switch = RestHeadingSwitch::set(true);
    let start = pose(50.0, 50.0, 0.0);
    let mut scene = scene_at(start);
    reconcile(&mut scene, pose(51.0, 50.0, FRAC_PI_2), Some(true), start);
    let body = remote_body(&scene);
    assert!(body.position_manager.queue_active(), "1 m: a node is queued");
    assert_eq!(body.pose, start, "nothing written at ingest");
    scene.step_remote_position_managers(0.05);
    let turned = heading_delta(0.0, remote_body(&scene).pose.rotation.to_heading());
    assert!(
        turned > 1e-3 && turned <= FRAC_PI_2 + 1e-4,
        "turned toward the node heading: {turned}"
    );
}

/// (d) `?remoteRestHeading=off`: the pre-fix pose, bit for bit.
#[test]
fn remote_rest_heading_off_keeps_the_body_heading() {
    let _switch = RestHeadingSwitch::set(false);
    let start = pose(50.0, 50.0, 0.0);
    let mut scene = scene_at(start);
    reconcile(&mut scene, pose(50.0, 50.0, FRAC_PI_2), Some(true), start);
    let body = remote_body(&scene);
    assert_eq!(body.pose, start, "=off: heading not adopted");
    assert!(!body.position_manager.queue_active());
}
