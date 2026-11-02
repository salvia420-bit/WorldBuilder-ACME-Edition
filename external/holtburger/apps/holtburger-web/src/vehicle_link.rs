//! holtburger vehicles (HBV1, docs/vehicles-2026-11-01) — the wasm side's shared vehicle state.
//!
//! Thread-local (wasm32 is single-threaded): the recv loop pushes every inbound vehicle message into an inbox the
//! JS vehicle module drains each frame (`SessionHandle.drainVehicleMessages()`, a JSON array), and reads the seat
//! lock the JS module sets each frame (`setVehicleSeat`). While a seat lock is active the local body is SLAVED to
//! the predicted seat pose: the movement tick snaps it there instead of integrating local physics, so no
//! AutonomousPosition / MoveToState is produced (the server ignores them for a seated player anyway).
//!
//! The lock is released by JS (`clearVehicleSeat`) or by the server: a VehicleSeat(Empty) for the locked seat, or a
//! VehicleEvent(Touchdown / Despawn) naming the local player (Touchdown also carries the exit placement, which the
//! recv loop applies as a hard snap — same game-event stream as the seat change, so the order is guaranteed).

use holtburger_protocol::messages::vehicle::{VehicleS2C, s2c};
use serde_json::{Value, json};
use std::cell::RefCell;

/// The predicted seat pose of the local body (AC cell + landblock-local metres, compass heading).
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct SeatPose {
    pub vehicle: u32,
    pub cell: u32,
    pub x: f32,
    pub y: f32,
    pub z: f32,
    pub heading: f32,
}

#[derive(Default, serde::Serialize)]
pub(crate) struct VehicleWireStats {
    /// Vehicle events received, by opcode low nibble (0x0900..=0x090F).
    pub received: [u32; 16],
    pub received_total: u64,
    pub sent_total: u64,
    pub sent_inputs: u64,
    pub inbox_overflow: u64,
    pub seat_ticks: u64,
    pub seat_releases_by_server: u64,
    pub snaps: u64,
}

#[derive(Default)]
struct VehicleLink {
    inbox: Vec<Value>,
    seat: Option<SeatPose>,
    /// The vehicle whose seat the server released; JS seat poses for it are ignored until `clearVehicleSeat`.
    released_vehicle: Option<u32>,
    stats: VehicleWireStats,
}

thread_local! {
    static LINK: RefCell<VehicleLink> = RefCell::new(VehicleLink::default());
}

const INBOX_CAP: usize = 4096;

/// What the recv loop must do after a vehicle message.
pub(crate) enum LinkAction {
    None,
    /// Hard-snap the local body to (cell, x, y, z) — the server's exit / touchdown placement.
    Snap { cell: u32, x: f32, y: f32, z: f32 },
}

fn v3(p: [f32; 3]) -> Value {
    json!([p[0] as f64, p[1] as f64, p[2] as f64])
}

/// The JSON shape the JS vehicle module reads (scene3d/vehicle/protocol.js documents it).
pub(crate) fn to_json(msg: &VehicleS2C) -> Value {
    match msg {
        VehicleS2C::CapabilitiesAck { granted, sim_hz, .. } => {
            json!({"type": "ack", "granted": granted, "simHz": sim_hz})
        }
        VehicleS2C::Profile(p) => {
            let mut v = json!({
                "type": "profile", "vehicle": p.vehicle, "profileKey": p.profile_key, "displayName": p.display_name,
                "locomotion": p.locomotion, "standInSetup": p.stand_in_setup, "simHz": p.sim_hz,
                "vMin": p.v_min, "vCruise": p.v_cruise, "vMax": p.v_max, "speedCap": p.speed_cap,
                "accel": p.accel, "decel": p.decel, "maxBank": p.max_bank, "rollRate": p.roll_rate,
                "maxPitch": p.max_pitch, "pitchRate": p.pitch_rate, "yawRate": p.yaw_rate,
                "climbMax": p.climb_max, "sinkMax": p.sink_max, "floorAgl": p.floor_agl, "ceilingAgl": p.ceiling_agl,
                "takeoffClimb": p.takeoff_climb, "landingSpeed": p.landing_speed,
                "leadSeconds": p.lead_seconds, "objectRadius": p.object_radius,
                "seats": p.seats.iter().map(|s| json!({"role": s.role, "motion": s.motion, "offset": v3(s.offset)})).collect::<Vec<_>>(),
                "weapons": p.weapons.iter().map(|w| json!({
                    "kind": w.kind, "roundsPerSecond": w.rounds_per_second, "spread": w.spread, "range": w.range,
                    "damage": w.damage, "magazine": w.magazine, "muzzle": v3(w.muzzle),
                })).collect::<Vec<_>>(),
                "parts": p.parts.iter().map(|pt| json!({
                    "did": pt.did, "offset": v3(pt.offset),
                    "rotation": [pt.rotation[0] as f64, pt.rotation[1] as f64, pt.rotation[2] as f64, pt.rotation[3] as f64],
                    "scale": pt.scale,
                })).collect::<Vec<_>>(),
            });
            // HBV1 v2 (inserted after: one more nested json! in the literal above risks the macro recursion limit)
            if let Some(o) = v.as_object_mut() {
                o.insert("partRoles".into(), json!(p.part_roles));
                o.insert(
                    "weaponExt".into(),
                    Value::Array(
                        p.weapon_ext
                            .iter()
                            .map(|x| {
                                json!({
                                    "muzzleVelocity": x.muzzle_velocity, "convergence": x.convergence,
                                    "massKg": x.mass_kg, "dragTerminal": x.drag_terminal, "spellId": x.spell_id,
                                })
                            })
                            .collect(),
                    ),
                );
            }
            v
        }
        VehicleS2C::Seat(s) => json!({
            "type": "seat", "vehicle": s.vehicle, "seat": s.seat, "occupant": s.occupant, "state": s.state, "reason": s.reason,
        }),
        VehicleS2C::State(s) => json!({
            "type": "state", "vehicle": s.vehicle, "step": s.step, "ack": s.ack_input_seq, "cell": s.cell,
            "x": s.position[0], "y": s.position[1], "z": s.position[2],
            "heading": s.heading, "pitch": s.pitch, "bank": s.bank, "speed": s.speed, "vCap": s.v_cap,
            "ammo": s.ammo, "mode": s.mode, "flags": s.flags,
            "missileMask": s.missile_mask, "bombMask": s.bomb_mask,
        }),
        VehicleS2C::Fire(f) => json!({
            "type": "fire", "vehicle": f.vehicle, "step": f.step, "mount": f.mount, "count": f.count, "cell": f.cell,
            "x": f.muzzle[0], "y": f.muzzle[1], "z": f.muzzle[2],
            "dir": [f.dir[0] as f64 / 32767.0, f.dir[1] as f64 / 32767.0, f.dir[2] as f64 / 32767.0],
            "seed": f.seed,
            "mountCount": f.mount_count, "speed": f.speed,
        }),
        VehicleS2C::Event(e) => json!({
            "type": "event", "vehicle": e.vehicle, "kind": e.kind, "step": e.step, "subject": e.subject, "cell": e.cell,
            "x": e.position[0], "y": e.position[1], "z": e.position[2], "value": e.value,
            "aux": e.aux, "vel": v3(e.velocity),
        }),
    }
}

/// Recv-loop hook for every inbound vehicle event.
pub(crate) fn on_s2c(msg: &VehicleS2C, local_player: u32) -> LinkAction {
    LINK.with(|l| {
        let mut l = l.borrow_mut();
        let idx = (msg.opcode() & 0xF) as usize;
        l.stats.received[idx] = l.stats.received[idx].saturating_add(1);
        l.stats.received_total += 1;
        if l.inbox.len() >= INBOX_CAP {
            l.inbox.remove(0);
            l.stats.inbox_overflow += 1;
        }
        l.inbox.push(to_json(msg));

        match msg {
            VehicleS2C::Seat(s) if s.state == 0 => {
                if l.seat.is_some_and(|p| p.vehicle == s.vehicle) {
                    l.seat = None;
                    l.released_vehicle = Some(s.vehicle);
                    l.stats.seat_releases_by_server += 1;
                }
                LinkAction::None
            }
            VehicleS2C::Event(e) if e.subject == local_player && local_player != 0 => {
                // 7 = Touchdown (back on foot at Cell/Position): releases ANY lock (the bail-out fall lock is keyed on
                // the player); 4 = Despawn: the lock on that vehicle
                if e.kind == 7 || e.kind == 4 {
                    if l.seat.is_some_and(|p| e.kind == 7 || p.vehicle == e.vehicle) {
                        l.seat = None;
                        l.released_vehicle = Some(e.vehicle);
                        l.stats.seat_releases_by_server += 1;
                    }
                }
                if e.kind == 7 && e.cell != 0 {
                    l.stats.snaps += 1;
                    LinkAction::Snap {
                        cell: e.cell,
                        x: e.position[0],
                        y: e.position[1],
                        z: e.position[2],
                    }
                } else {
                    LinkAction::None
                }
            }
            _ => LinkAction::None,
        }
    })
}

pub(crate) fn drain_json() -> String {
    LINK.with(|l| {
        let drained: Vec<Value> = std::mem::take(&mut l.borrow_mut().inbox);
        serde_json::to_string(&drained).unwrap_or_else(|_| "[]".to_string())
    })
}

pub(crate) fn set_seat(pose: SeatPose) -> bool {
    LINK.with(|l| {
        let mut l = l.borrow_mut();
        if l.released_vehicle == Some(pose.vehicle) {
            return false;
        }
        l.seat = Some(pose);
        true
    })
}

pub(crate) fn clear_seat() {
    LINK.with(|l| {
        let mut l = l.borrow_mut();
        l.seat = None;
        l.released_vehicle = None;
    })
}

pub(crate) fn seat_pose() -> Option<SeatPose> {
    LINK.with(|l| l.borrow().seat)
}

pub(crate) fn note_seat_tick() {
    LINK.with(|l| l.borrow_mut().stats.seat_ticks += 1)
}

pub(crate) fn note_sent(is_input: bool) {
    LINK.with(|l| {
        let mut l = l.borrow_mut();
        l.stats.sent_total += 1;
        if is_input {
            l.stats.sent_inputs += 1;
        }
    })
}

pub(crate) fn stats_json() -> String {
    LINK.with(|l| {
        let l = l.borrow();
        let mut v = serde_json::to_value(&l.stats).unwrap_or(Value::Null);
        if let Some(o) = v.as_object_mut() {
            o.insert("seatLocked".into(), json!(l.seat.is_some()));
            o.insert("inbox".into(), json!(l.inbox.len()));
            if let Some(p) = l.seat {
                o.insert(
                    "seat".into(),
                    json!({"vehicle": p.vehicle, "cell": p.cell, "x": p.x, "y": p.y, "z": p.z, "heading": p.heading}),
                );
            }
        }
        v.to_string()
    })
}

/// Compass heading (0 = north/+y, clockwise) → the AC quaternion of an upright body facing it.
pub(crate) fn heading_quat(heading: f32) -> holtburger_common::math::Quaternion {
    // rotation about +z by -heading: (w, x, y, z) = (cos(-h/2), 0, 0, sin(-h/2))
    let half = -heading * 0.5;
    holtburger_common::math::Quaternion {
        w: half.cos(),
        x: 0.0,
        y: 0.0,
        z: half.sin(),
    }
}

/// Whether an opcode is one of the HBV1 events (used by the wire stats elsewhere).
#[allow(dead_code)]
pub(crate) fn is_vehicle_event(opcode: u32) -> bool {
    matches!(
        opcode,
        s2c::CAPABILITIES_ACK | s2c::PROFILE | s2c::SEAT | s2c::STATE | s2c::FIRE | s2c::EVENT
    )
}
