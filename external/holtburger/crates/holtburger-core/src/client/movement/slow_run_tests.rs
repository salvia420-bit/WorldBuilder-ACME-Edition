//! SLOW-RUN (2026-10-11) — owner: "sometimes when moving in a certain
//! dirrction it seems theres a server induced lag or something that happens
//! sporadically and makes the character a little bit slower until i stop the
//! movement and restart the movement again."
//!
//! These pin the candidate latches a fresh press clears:
//! - a non-autonomous self UpdateMotion re-sending the player's own run (ACE
//!   `Player.HandleRunRateUpdate`, Player.cs:975) must not hold a held-W run
//!   on the server's state: retail's `CommandInterpreter::UseTime` reclaim
//!   (acclient.c:717595) gives control back without a press;
//! - a starved leash (no self-position echo re-armed `ConstrainTo`,
//!   acclient.c:145209) scales the run (`ConstraintManager::adjust_offset`,
//!   :389478): the slow-run detector names it;
//! - `?apPlaneResend`: retail's in-window contact-plane AutonomousPosition
//!   (:718131), the echo cadence that keeps the leash re-armed, with our 100 ms
//!   floor;
//! - `?castLockRevive`: a held W the `?castHoldReclaim` lock left dead comes
//!   back when the cast window closes, not at the next press.
//!
//! The frame tests drive the REAL tick spine (33 ms frames), like the
//! cast-movement harness in `system/tests.rs`.
#![cfg(test)]

use super::MovementSystemHandle;
use super::system::MovementSystem;
use crate::TickSpineHandle;
use crate::client::movement_types::{ForwardLocomotion, MotionState};
use crate::slow_run_diag::SlowRunCause;
use holtburger_common::position::WorldPosition;
use holtburger_common::{Guid, Plane, Quaternion, Vector3};
use holtburger_protocol::messages::GameMessage;
use holtburger_protocol::messages::game_action::GameAction;
use holtburger_protocol::messages::movement::messages::motion::MovementInvalid;
use holtburger_protocol::messages::movement::{
    InterpretedMotionCommand, InterpretedMotionState, MotionStance, MovementStateFlags,
};
use holtburger_protocol::messages::{MovementEventData, MovementType, MovementTypeData};
use holtburger_session::Session;
use holtburger_world::{
    PlayerMotionTableSource, SelfMovementCapabilities, SelfMovementKinematics, SpatialBodyId,
    WorldState,
};
use std::time::Duration;
use web_time::Instant;

const PLAYER: Guid = Guid(0x5000_0777);
/// `on_action`'s MovementForward.
const KEY_FORWARD: u32 = 0x29;
const FRAME: Duration = Duration::from_millis(33);
/// One full manual slice.
const SLICE: Duration = Duration::from_millis(100);

fn capabilities(base_run: f32) -> SelfMovementCapabilities {
    SelfMovementCapabilities {
        kinematics: SelfMovementKinematics {
            source: PlayerMotionTableSource::DirectProperty {
                motion_table_id: 0x0900_0020,
            },
            motion_table_id: 0x0900_0020,
            stance: MotionStance::NonCombat as u32,
            base_walk_forward_velocity: Vector3::new(2.6, 0.0, 0.0),
            base_run_forward_velocity: Vector3::new(base_run, 0.0, 0.0),
            base_turn_left_omega: Vector3::new(0.0, 0.0, -1.5),
            base_turn_right_omega: Vector3::new(0.0, 0.0, 1.5),
        },
        run_rate_scalar: 1.0,
    }
}

/// The cast-movement harness's world: (100, 100) facing north, run 4 m/s.
fn spine_world() -> WorldState {
    let mut world = WorldState::synthetic();
    let start = WorldPosition {
        landblock_id: Guid(0xA9B4_0001),
        coords: Vector3::new(100.0, 100.0, 0.0),
        rotation: Quaternion::from_heading(90f32.to_radians()),
    };
    world.seed_local_player_entity(PLAYER, "Player", start);
    let _ = world.set_player_position(start);
    world.player.guid = PLAYER;
    world.set_self_movement_capabilities_override(capabilities(4.0));
    world
}

/// A non-autonomous General (`MovementType::Invalid`) for the player with one
/// forward command.
fn general(
    seq: u16,
    forward: InterpretedMotionCommand,
    speed: f32,
    style: MotionStance,
) -> MovementEventData {
    MovementEventData {
        guid: PLAYER,
        object_instance_sequence: 0,
        movement_sequence: seq,
        server_control_sequence: seq,
        is_autonomous: false,
        movement_type: MovementType::Invalid,
        motion_flags: 0,
        current_style: style.interpreted(),
        data: MovementTypeData::Invalid(MovementInvalid {
            state: InterpretedMotionState {
                flags: MovementStateFlags::FORWARD_COMMAND | MovementStateFlags::FORWARD_SPEED,
                num_commands: 0,
                current_style: None,
                forward_command: Some(forward),
                sidestep_command: None,
                turn_command: None,
                forward_speed: Some(speed),
                sidestep_speed: None,
                turn_speed: None,
                commands: Vec::new(),
            },
            sticky_object: None,
        }),
    }
}

/// Through the real world handler and the production event consumers.
fn inject(world: &mut WorldState, handle: &mut MovementSystemHandle, data: MovementEventData) {
    let events = world.handle_message(&GameMessage::UpdateMotion(Box::new(data)));
    handle.apply_self_movement_world_events(&events);
    handle.apply_movement_world_events(&events);
}

fn planar_step(a: &WorldPosition, b: &WorldPosition) -> f32 {
    let a = a.global_coords();
    let b = b.global_coords();
    ((b.x - a.x).powi(2) + (b.y - a.y).powi(2)).sqrt()
}

/// H1 (the orchestrator's first hypothesis): ACE re-sends the player's own
/// run non-autonomously when its run rate changes (exhaustion, a run buff or
/// debuff with `runrate_add_hooks`). With `?castTakesControl` that hands
/// control to the server; retail's `UseTime` reclaim (held key, no motion
/// pending, no MoveTo) takes it back on the next pump without a press, and
/// the held run carries on at the client's own speed. With the switch off (the
/// pre-8f65edbc lane) the echo only lowers the autonomy latch: the body rides
/// the server's interpreted RunForward until the next press, at the same speed.
/// Neither arm slows the run, and the detector records nothing. The
/// capabilities override pins the run rate. In the browser, `?serverRunRate`
/// would adopt the echo's 0.8: that is the server's own published rate, by
/// design, and not a latch.
#[tokio::test]
async fn held_run_takes_control_back_after_a_server_run_echo_without_a_press() {
    for takes_control in [true, false] {
        let mut world = spine_world();
        world.scene.set_general_motion_takes_control(takes_control);
        let mut handle = MovementSystemHandle::new();
        handle.inner_mut().set_slide_cast(false);
        let mut spine = TickSpineHandle::new();
        let mut session = Session::new_test();
        let t0 = Instant::now();
        let mut poses = Vec::new();
        let mut controlled = Vec::new();
        let mut taken_at_echo = false;
        for frame in 0..30usize {
            let now = t0 + FRAME * frame as u32;
            if frame == 0 {
                handle.inner_mut().enqueue_key_action(KEY_FORWARD, true);
            }
            if frame == 10 {
                // A LOWER rate, as an exhaustion / debuff update carries.
                inject(
                    &mut world,
                    &mut handle,
                    general(
                        2,
                        InterpretedMotionCommand::RUN_FORWARD,
                        0.8,
                        MotionStance::NonCombat,
                    ),
                );
                taken_at_echo = world.scene.local_server_controlled();
            }
            spine
                .tick_frame(now, &mut world, &mut handle, &mut session)
                .await
                .expect("tick");
            poses.push(world.local_player_runtime_pose().expect("pose"));
            controlled.push(world.scene.local_server_controlled());
        }
        let step = |i: usize| planar_step(&poses[i - 1], &poses[i]);
        let cruise = step(8);
        assert!(cruise > 0.1, "running before the echo ({cruise:.4} m/frame)");
        assert_eq!(
            taken_at_echo, takes_control,
            "castTakesControl={takes_control}: the echo hands control to the server"
        );
        if takes_control {
            assert!(
                !controlled[12],
                "the UseTime reclaim returned control without a press"
            );
            assert!(
                !handle.inner_mut().interpreted_movement_active(),
                "the held keys drive again (autonomy latch raised by the reclaim)"
            );
        } else {
            assert!(
                handle.inner_mut().interpreted_movement_active(),
                "castTakesControl=off: the server's interpreted run drives until the next press"
            );
        }
        // The 33 ms frame does not divide evenly into physics quanta, so every
        // ~5th frame runs one step ~3 % short, before the echo as well as
        // after it (frames 5, 10, 14, 19, ...). Compare mean speed across
        // the echo instead of single frames. Each frame also gets a floor
        // that the aliasing clears and a server-rate latch (0.8) would not.
        let mean = |r: std::ops::Range<usize>| {
            let n = r.len() as f32;
            r.map(step).sum::<f32>() / n
        };
        let before = mean(1..11);
        let after = mean(11..30);
        assert!(
            (after - before).abs() < 0.02 * before,
            "takes_control={takes_control}: mean step {after:.4} m after the echo vs {before:.4} m before"
        );
        for i in 11..30 {
            assert!(
                step(i) > 0.95 * cruise,
                "takes_control={takes_control} frame {i}: {:.4} m vs cruise {cruise:.4} m",
                step(i)
            );
        }
        assert_eq!(
            handle.inner_mut().manual_drive_forward_for_test(),
            Some(ForwardLocomotion::Forward)
        );
        assert_eq!(
            handle.inner_mut().slow_run_incidents_for_test().0,
            0,
            "takes_control={takes_control}: a full-speed run is never a slow-run incident"
        );
    }
}

/// The detector on the leash: the last self-position echo re-armed
/// `ConstrainTo` 30 m of travel ago (outdoors: start 10 m, max 50 m), so
/// `ConstraintManager::adjust_offset` scales the run to (50 − 30) / 40 = 0.5.
/// The incident names the leash with its budget, not the drive or the
/// transition. An unarmed leash leaves the same run at full speed, and nothing
/// is recorded.
#[test]
fn a_starved_leash_is_recorded_as_a_leash_slowdown() {
    for armed in [true, false] {
        let mut world = WorldState::synthetic();
        world.player.guid = PLAYER;
        world.set_self_movement_capabilities_override(capabilities(4.5));
        world.populate_terrain_heights_scene_resident(0, [5.0; 81]);
        let pose = WorldPosition {
            landblock_id: Guid(0x0000_0001),
            coords: Vector3::new(90.0, 96.0, 5.0),
            rotation: Quaternion::identity(),
        };
        world.seed_local_player_entity(PLAYER, "Player", pose);
        let _ = world.set_player_position(pose);
        // The browser default: the composed retail chain (`?retailLeash`).
        world.scene.set_local_retail_leash(true);
        if armed {
            let body = world
                .scene
                .body_mut(SpatialBodyId::LocalPlayer(PLAYER))
                .expect("local body");
            body.position_manager.set_retail_leash(true);
            body.position_manager.remote_constrain_to(30.0, 10.0, 50.0);
        }
        let mut movement = MovementSystem::new();
        movement.set_active_manual_drive_for_test(MotionState::builder().run().forward().build());
        let start = world.local_player_runtime_pose().expect("pose");
        for i in 0..12 {
            assert!(
                movement.advance_manual_slice_via_transition(&mut world, SLICE),
                "manual slice {i}"
            );
        }
        let travelled = planar_step(&start, &world.local_player_runtime_pose().expect("pose"));
        let (count, last) = movement.slow_run_incidents_for_test();
        if armed {
            assert!(
                travelled < 0.6 * 4.5 * 1.2,
                "the leash halves the run ({travelled:.2} m in 1.2 s)"
            );
            let incident = last.expect("a leash-starved run is a slow-run incident");
            assert_eq!(incident.cause, SlowRunCause::Leash, "{incident:?}");
            assert!(incident.leash_ratio < 0.6, "{incident:?}");
            assert!(incident.drive_ratio > 0.95, "{incident:?}");
            assert!(incident.transition_ratio > 0.9, "{incident:?}");
            assert!(incident.ctx.leash_armed, "{incident:?}");
            assert!(incident.ctx.leash_budget_m > 30.0, "{incident:?}");
            assert!(
                !incident.ctx.server_controlled && incident.ctx.latch_autonomous,
                "{incident:?}"
            );
            assert_eq!(incident.ctx.held_forward, 1);
            assert_eq!(incident.ctx.drive_forward, 1);
        } else {
            assert!(travelled > 0.95 * 4.5 * 1.2, "full speed ({travelled:.2} m)");
            assert_eq!(count, 0, "an unleashed run is not slow: {last:?}");
        }
    }
}

#[derive(Default)]
struct RecordingSink {
    sent: Vec<GameAction>,
}

#[async_trait::async_trait]
impl holtburger_session::ActionSink for RecordingSink {
    async fn send_action(&mut self, action: GameAction) -> anyhow::Result<()> {
        self.sent.push(action);
        Ok(())
    }
}

fn aps(sink: &RecordingSink) -> usize {
    sink.sent
        .iter()
        .filter(|action| matches!(action, GameAction::AutonomousPosition(_)))
        .count()
}

fn ap_world(position: WorldPosition) -> WorldState {
    let mut world = WorldState::synthetic();
    let guid = Guid(0x0102_0304);
    world.player.guid = guid;
    world.seed_local_player_entity(guid, "Player", position);
    world
}

fn flat(d: f32) -> Plane {
    Plane {
        normal: Vector3::new(0.0, 0.0, 1.0),
        d,
    }
}

/// `?apPlaneResend` (browser default ON): retail `ShouldSendPositionEvent`
/// re-sends INSIDE the 1 s window when the contact plane changes
/// (acclient.c:718131), and every AP comes back as the self echo that
/// re-arms the leash. A plane that changes every tick is held to one AP per
/// 100 ms (`AP_PLANE_RESEND_MIN_GAP`, system.rs). `=off` stays quiet in-window.
#[tokio::test]
async fn ap_plane_resend_sends_on_an_in_window_plane_change_with_a_floor() {
    let ms = Duration::from_millis;
    let position = WorldPosition {
        landblock_id: Guid(0x1000_0001),
        coords: Vector3::new(12.0, -4.0, 1.5),
        rotation: Quaternion::from_heading(0.0),
    };
    let cell = u32::from(position.landblock_id);

    let mut world = ap_world(position);
    world.player.last_contact_plane = Some((flat(-1.5), cell));
    let mut movement = MovementSystem::new();
    movement.set_ap_contact_plane_resend(true);
    let mut sink = RecordingSink::default();
    let t0 = Instant::now();
    movement.tick(t0, &mut world, &mut sink).await.expect("tick");
    assert_eq!(aps(&sink), 1, "the first grounded frame sends");

    // The next triangle, 300 ms later (in-window): one AP.
    world.player.last_contact_plane = Some((flat(-1.6), cell));
    movement.tick(t0 + ms(300), &mut world, &mut sink).await.expect("tick");
    assert_eq!(aps(&sink), 2, "an in-window plane change sends");

    // Another change 50 ms later waits for the floor…
    world.player.last_contact_plane = Some((flat(-1.7), cell));
    movement.tick(t0 + ms(350), &mut world, &mut sink).await.expect("tick");
    assert_eq!(aps(&sink), 2, "inside the 100 ms floor");
    // …and goes once it passes.
    movement.tick(t0 + ms(420), &mut world, &mut sink).await.expect("tick");
    assert_eq!(aps(&sink), 3, "past the floor");

    // A plane that flips every 30 ms tick for 900 ms: bounded by the floor
    // (one AP per 150 ms here — a send, then two held ticks, then an equal
    // plane), not one per tick.
    for k in 0..30u64 {
        let d = if k % 2 == 0 { -1.8 } else { -1.7 };
        world.player.last_contact_plane = Some((flat(d), cell));
        movement
            .tick(t0 + ms(450 + 30 * k), &mut world, &mut sink)
            .await
            .expect("tick");
    }
    let jitter = aps(&sink) - 3;
    assert!(
        (4..=9).contains(&jitter),
        "a jittering plane is bounded by the floor: {jitter} APs in 900 ms"
    );

    // `?apPlaneResend=off` (the native default): no in-window plane send.
    let mut world = ap_world(position);
    world.player.last_contact_plane = Some((flat(-1.5), cell));
    let mut movement = MovementSystem::new();
    movement.set_ap_contact_plane_resend(false);
    let mut sink = RecordingSink::default();
    movement.tick(t0, &mut world, &mut sink).await.expect("tick");
    world.player.last_contact_plane = Some((flat(-1.6), cell));
    for k in 1..=30u64 {
        movement
            .tick(t0 + ms(30 * k), &mut world, &mut sink)
            .await
            .expect("tick");
    }
    assert_eq!(aps(&sink), 1, "off: in-window plane changes never send");
}

/// `?castLockRevive` (browser default ON). W pressed into a cast runs; ACE's
/// gesture echo (castTakesControl) stops it. After the gesture's 2.0 s the
/// post-anim reclaim returns control, but `?castHoldReclaim` keeps the held W
/// dead while our cast request is in flight. When the UseDone closes the window,
/// the held W runs again with no press. That is retail's end state: it has no
/// lock, and its reclaim re-applies W. `=off` keeps it dead until a fresh
/// press (the pre-fix shape: "slower until I stop and restart", for a
/// W+strafe runner only the strafe moves), and the detector names it.
#[tokio::test]
async fn cast_lock_revives_a_held_w_when_the_cast_window_closes() {
    const ECHO: usize = 4;
    const USE_DONE: usize = 80;
    const FRAMES: usize = 125;
    for revive in [true, false] {
        let mut world = spine_world();
        // The browser's cast-movement pair (`run_slide`).
        world.scene.set_general_motion_takes_control(true);
        let mut handle = MovementSystemHandle::new();
        handle.inner_mut().set_slide_cast(false);
        handle.inner_mut().set_cast_lock_revive(revive);
        let mut spine = TickSpineHandle::new();
        let mut session = Session::new_test();
        let t0 = Instant::now();
        let mut poses = Vec::new();
        let mut controlled = Vec::new();
        for frame in 0..FRAMES {
            let now = t0 + FRAME * frame as u32;
            match frame {
                0 => {
                    // Production's cast request: MaybeStopCompletely first.
                    let inner = handle.inner_mut();
                    inner.enqueue_maybe_stop_completely();
                    inner.note_cast_request_sent(now);
                }
                2 => handle.inner_mut().enqueue_key_action(KEY_FORWARD, true),
                ECHO => inject(
                    &mut world,
                    &mut handle,
                    general(2, 0x002Bu16.into(), 2.0, MotionStance::Magic),
                ),
                USE_DONE => handle.inner_mut().note_use_done(),
                _ => {}
            }
            spine
                .tick_frame(now, &mut world, &mut handle, &mut session)
                .await
                .expect("tick");
            poses.push(world.local_player_runtime_pose().expect("pose"));
            controlled.push(world.scene.local_server_controlled());
        }
        let step = |i: usize| planar_step(&poses[i - 1], &poses[i]);
        assert!(step(3) > 0.05, "W pressed into the cast runs ({:.4})", step(3));
        for i in (ECHO + 2)..60 {
            assert!(step(i) < 1e-3, "frame {i}: the gesture echo stops the run");
        }
        assert!(controlled[ECHO], "the gesture echo takes control");
        assert!(
            !controlled[72],
            "the post-anim reclaim returned control after the gesture"
        );
        for i in 72..USE_DONE {
            assert!(
                step(i) < 1e-3,
                "frame {i}: the cast lock keeps the held W dead while the cast is in flight"
            );
        }
        if revive {
            for i in (USE_DONE + 2)..FRAMES {
                assert!(
                    step(i) > 0.1,
                    "frame {i}: the window closed; the held W runs again ({:.4})",
                    step(i)
                );
            }
            assert_eq!(
                handle.inner_mut().manual_drive_forward_for_test(),
                Some(ForwardLocomotion::Forward)
            );
        } else {
            for i in (USE_DONE + 2)..FRAMES {
                assert!(
                    step(i) < 1e-3,
                    "frame {i}: `=off` keeps the held W dead until a fresh press"
                );
            }
            let (_, last) = handle.inner_mut().slow_run_incidents_for_test();
            let incident = last.expect("a held W that does not run is a slow-run incident");
            assert_eq!(incident.cause, SlowRunCause::CastForwardLock, "{incident:?}");
            assert!(incident.ctx.forward_killed_by_cast_lock, "{incident:?}");
            assert_eq!(incident.ctx.held_forward, 1, "{incident:?}");
            assert_eq!(incident.ctx.drive_forward, 0, "{incident:?}");
        }
    }
}
