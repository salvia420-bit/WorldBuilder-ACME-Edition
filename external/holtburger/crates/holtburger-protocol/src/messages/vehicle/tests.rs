//! HBV1 fixture round-trips: the bytes in `vehicle-wire-fixtures.json` (generated from the XML spec by
//! `gen_fixtures.py`) must unpack to the fixture's fields, and the fields must pack to the same bytes.
//! The ACE side runs the same fixtures (ACE.Server.Tests/Vehicles/VehicleWireTests.cs).

use super::*;
use crate::messages::{GameAction, GameEvent, GameMessage};
use crate::traits::{ProtocolPack, ProtocolUnpack};
use serde_json::{Value, json};

const FIXTURES: &str = include_str!(
    "../../../../../apps/holtburger-web/docs/vehicles-2026-11-01/protocol/vehicle-wire-fixtures.json"
);

fn v3(v: [f32; 3]) -> Value {
    json!({"X": v[0] as f64, "Y": v[1] as f64, "Z": v[2] as f64})
}
fn f(v: f32) -> Value {
    json!(v as f64)
}
fn gf(o: &Value, k: &str) -> f32 {
    o[k].as_f64().unwrap_or_else(|| panic!("missing float {k}")) as f32
}
fn gu(o: &Value, k: &str) -> u32 {
    o[k].as_u64().unwrap_or_else(|| panic!("missing uint {k}")) as u32
}
fn gi(o: &Value, k: &str) -> i64 {
    o[k].as_i64().unwrap_or_else(|| panic!("missing int {k}"))
}
fn gv3(o: &Value, k: &str) -> [f32; 3] {
    let v = &o[k];
    [gf(v, "X"), gf(v, "Y"), gf(v, "Z")]
}

fn c2s_fields(m: &VehicleC2S) -> Value {
    match m {
        VehicleC2S::ClientCapabilities { flags } => json!({"Flags": flags}),
        VehicleC2S::Board { vehicle, seat } => json!({"Vehicle": vehicle, "Seat": seat}),
        VehicleC2S::Exit { vehicle, mode } => json!({"Vehicle": vehicle, "Mode": mode}),
        VehicleC2S::Input { vehicle, frames } => json!({
            "Vehicle": vehicle,
            "Count": frames.len(),
            "Frames": frames.iter().map(|fr| json!({
                "Seq": fr.seq, "Throttle": fr.throttle, "Pitch": fr.pitch, "Roll": fr.roll,
                "Yaw": fr.yaw, "Buttons": fr.buttons, "Reserved0": fr.reserved[0],
                "Reserved1": fr.reserved[1], "Reserved2": fr.reserved[2],
            })).collect::<Vec<_>>(),
        }),
    }
}

fn c2s_from(opcode: u32, o: &Value) -> VehicleC2S {
    match opcode {
        c2s::CLIENT_CAPABILITIES => VehicleC2S::ClientCapabilities {
            flags: gu(o, "Flags"),
        },
        c2s::BOARD => VehicleC2S::Board {
            vehicle: gu(o, "Vehicle"),
            seat: gu(o, "Seat"),
        },
        c2s::EXIT => VehicleC2S::Exit {
            vehicle: gu(o, "Vehicle"),
            mode: gu(o, "Mode"),
        },
        c2s::INPUT => VehicleC2S::Input {
            vehicle: gu(o, "Vehicle"),
            frames: o["Frames"]
                .as_array()
                .unwrap()
                .iter()
                .map(|fr| VehicleInputFrame {
                    seq: gu(fr, "Seq"),
                    throttle: gu(fr, "Throttle") as u8,
                    pitch: gi(fr, "Pitch") as i8,
                    roll: gi(fr, "Roll") as i8,
                    yaw: gi(fr, "Yaw") as i8,
                    buttons: gu(fr, "Buttons") as u8,
                    reserved: [
                        gu(fr, "Reserved0") as u8,
                        gu(fr, "Reserved1") as u8,
                        gu(fr, "Reserved2") as u8,
                    ],
                })
                .collect(),
        },
        _ => panic!("not a C2S vehicle opcode {opcode:#x}"),
    }
}

fn s2c_fields(m: &VehicleS2C) -> Value {
    match m {
        VehicleS2C::CapabilitiesAck {
            granted,
            sim_hz,
            reserved,
        } => json!({"Granted": granted, "SimHz": sim_hz, "Reserved": reserved}),
        VehicleS2C::Profile(p) => json!({
            "Vehicle": p.vehicle, "ProfileKey": p.profile_key, "DisplayName": p.display_name,
            "Locomotion": p.locomotion, "StandInSetup": p.stand_in_setup, "SimHz": p.sim_hz,
            "Reserved": p.reserved,
            "VMin": f(p.v_min), "VCruise": f(p.v_cruise), "VMax": f(p.v_max), "SpeedCap": f(p.speed_cap),
            "Accel": f(p.accel), "Decel": f(p.decel), "MaxBank": f(p.max_bank), "RollRate": f(p.roll_rate),
            "MaxPitch": f(p.max_pitch), "PitchRate": f(p.pitch_rate), "YawRate": f(p.yaw_rate),
            "ClimbMax": f(p.climb_max), "SinkMax": f(p.sink_max), "FloorAgl": f(p.floor_agl),
            "CeilingAgl": f(p.ceiling_agl), "TakeoffClimb": f(p.takeoff_climb),
            "LandingSpeed": f(p.landing_speed), "LeadSeconds": f(p.lead_seconds),
            "ObjectRadius": p.object_radius,
            "SeatCount": p.seats.len(),
            "Seats": p.seats.iter().map(|s| json!({"Role": s.role, "Motion": s.motion, "Offset": v3(s.offset)})).collect::<Vec<_>>(),
            "WeaponCount": p.weapons.len(),
            "Weapons": p.weapons.iter().map(|w| json!({
                "Kind": w.kind, "RoundsPerSecond": f(w.rounds_per_second), "Spread": f(w.spread),
                "Range": f(w.range), "Damage": f(w.damage), "Magazine": w.magazine, "Muzzle": v3(w.muzzle),
            })).collect::<Vec<_>>(),
            "PartCount": p.parts.len(),
            "Parts": p.parts.iter().map(|pt| json!({
                "Did": pt.did, "Offset": v3(pt.offset),
                "Rotation": {"W": pt.rotation[0] as f64, "X": pt.rotation[1] as f64, "Y": pt.rotation[2] as f64, "Z": pt.rotation[3] as f64},
                "Scale": f(pt.scale),
            })).collect::<Vec<_>>(),
        }),
        VehicleS2C::Seat(s) => json!({
            "Vehicle": s.vehicle, "Seat": s.seat, "Occupant": s.occupant, "State": s.state, "Reason": s.reason,
        }),
        VehicleS2C::State(s) => json!({
            "Vehicle": s.vehicle, "Step": s.step, "AckInputSeq": s.ack_input_seq, "Cell": s.cell,
            "Position": v3(s.position), "Heading": f(s.heading), "Pitch": f(s.pitch), "Bank": f(s.bank),
            "Speed": f(s.speed), "VCap": f(s.v_cap), "Ammo": s.ammo, "Mode": s.mode, "Flags": s.flags,
        }),
        VehicleS2C::Fire(fi) => json!({
            "Vehicle": fi.vehicle, "Step": fi.step, "Mount": fi.mount, "Count": fi.count, "Cell": fi.cell,
            "Muzzle": v3(fi.muzzle), "DirX": fi.dir[0], "DirY": fi.dir[1], "DirZ": fi.dir[2],
            "Reserved": fi.reserved, "Seed": fi.seed,
        }),
        VehicleS2C::Event(e) => json!({
            "Vehicle": e.vehicle, "Kind": e.kind, "Step": e.step, "Subject": e.subject, "Cell": e.cell,
            "Position": v3(e.position), "Value": f(e.value),
        }),
    }
}

fn s2c_from(opcode: u32, o: &Value) -> VehicleS2C {
    match opcode {
        s2c::CAPABILITIES_ACK => VehicleS2C::CapabilitiesAck {
            granted: gu(o, "Granted"),
            sim_hz: gu(o, "SimHz") as u16,
            reserved: gu(o, "Reserved") as u16,
        },
        s2c::PROFILE => VehicleS2C::Profile(Box::new(VehicleProfile {
            vehicle: gu(o, "Vehicle"),
            profile_key: o["ProfileKey"].as_str().unwrap().to_string(),
            display_name: o["DisplayName"].as_str().unwrap().to_string(),
            locomotion: gu(o, "Locomotion"),
            stand_in_setup: gu(o, "StandInSetup"),
            sim_hz: gu(o, "SimHz") as u16,
            reserved: gu(o, "Reserved") as u16,
            v_min: gf(o, "VMin"),
            v_cruise: gf(o, "VCruise"),
            v_max: gf(o, "VMax"),
            speed_cap: gf(o, "SpeedCap"),
            accel: gf(o, "Accel"),
            decel: gf(o, "Decel"),
            max_bank: gf(o, "MaxBank"),
            roll_rate: gf(o, "RollRate"),
            max_pitch: gf(o, "MaxPitch"),
            pitch_rate: gf(o, "PitchRate"),
            yaw_rate: gf(o, "YawRate"),
            climb_max: gf(o, "ClimbMax"),
            sink_max: gf(o, "SinkMax"),
            floor_agl: gf(o, "FloorAgl"),
            ceiling_agl: gf(o, "CeilingAgl"),
            takeoff_climb: gf(o, "TakeoffClimb"),
            landing_speed: gf(o, "LandingSpeed"),
            lead_seconds: gf(o, "LeadSeconds"),
            object_radius: gu(o, "ObjectRadius"),
            seats: o["Seats"]
                .as_array()
                .unwrap()
                .iter()
                .map(|s| VehicleSeatDef {
                    role: gu(s, "Role"),
                    motion: gu(s, "Motion"),
                    offset: gv3(s, "Offset"),
                })
                .collect(),
            weapons: o["Weapons"]
                .as_array()
                .unwrap()
                .iter()
                .map(|w| VehicleWeaponDef {
                    kind: gu(w, "Kind"),
                    rounds_per_second: gf(w, "RoundsPerSecond"),
                    spread: gf(w, "Spread"),
                    range: gf(w, "Range"),
                    damage: gf(w, "Damage"),
                    magazine: gu(w, "Magazine"),
                    muzzle: gv3(w, "Muzzle"),
                })
                .collect(),
            parts: o["Parts"]
                .as_array()
                .unwrap()
                .iter()
                .map(|p| VehiclePartDef {
                    did: gu(p, "Did"),
                    offset: gv3(p, "Offset"),
                    rotation: [
                        gf(&p["Rotation"], "W"),
                        gf(&p["Rotation"], "X"),
                        gf(&p["Rotation"], "Y"),
                        gf(&p["Rotation"], "Z"),
                    ],
                    scale: gf(p, "Scale"),
                })
                .collect(),
        })),
        s2c::SEAT => VehicleS2C::Seat(VehicleSeat {
            vehicle: gu(o, "Vehicle"),
            seat: gu(o, "Seat"),
            occupant: gu(o, "Occupant"),
            state: gu(o, "State"),
            reason: gu(o, "Reason"),
        }),
        s2c::STATE => VehicleS2C::State(VehicleState {
            vehicle: gu(o, "Vehicle"),
            step: gu(o, "Step"),
            ack_input_seq: gu(o, "AckInputSeq"),
            cell: gu(o, "Cell"),
            position: gv3(o, "Position"),
            heading: gf(o, "Heading"),
            pitch: gf(o, "Pitch"),
            bank: gf(o, "Bank"),
            speed: gf(o, "Speed"),
            v_cap: gf(o, "VCap"),
            ammo: gu(o, "Ammo") as u16,
            mode: gu(o, "Mode") as u8,
            flags: gu(o, "Flags") as u8,
        }),
        s2c::FIRE => VehicleS2C::Fire(VehicleFire {
            vehicle: gu(o, "Vehicle"),
            step: gu(o, "Step"),
            mount: gu(o, "Mount") as u16,
            count: gu(o, "Count") as u16,
            cell: gu(o, "Cell"),
            muzzle: gv3(o, "Muzzle"),
            dir: [
                gi(o, "DirX") as i16,
                gi(o, "DirY") as i16,
                gi(o, "DirZ") as i16,
            ],
            reserved: gu(o, "Reserved") as u16,
            seed: gu(o, "Seed"),
        }),
        s2c::EVENT => VehicleS2C::Event(VehicleEvent {
            vehicle: gu(o, "Vehicle"),
            kind: gu(o, "Kind"),
            step: gu(o, "Step"),
            subject: gu(o, "Subject"),
            cell: gu(o, "Cell"),
            position: gv3(o, "Position"),
            value: gf(o, "Value"),
        }),
        _ => panic!("not an S2C vehicle opcode {opcode:#x}"),
    }
}

/// The fixture's fields without an explicit Header override (the header is implied), floats
/// normalized to f32 (serde_json's default float parse may land 1 f64-ULP off the exact f32 value).
fn body_fields(fx: &Value) -> Value {
    let mut v = fx["fields"].clone();
    if let Some(o) = v.as_object_mut() {
        o.remove("Header");
    }
    norm(&v)
}

/// Round every float to f32 (both sides of a fields comparison go through this).
fn norm(v: &Value) -> Value {
    match v {
        Value::Number(n) if n.is_f64() => json!(n.as_f64().unwrap() as f32 as f64),
        Value::Array(a) => Value::Array(a.iter().map(norm).collect()),
        Value::Object(o) => Value::Object(o.iter().map(|(k, x)| (k.clone(), norm(x))).collect()),
        other => other.clone(),
    }
}

#[test]
fn hbv1_fixtures_round_trip() {
    let doc: Value = serde_json::from_str(FIXTURES).expect("fixtures JSON");
    assert_eq!(doc["tag"].as_u64(), Some(HBV1_TAG as u64));
    let fixtures = doc["fixtures"].as_array().unwrap();
    assert!(fixtures.len() >= 13, "fixture file shrank");
    let mut checked = 0;
    for fx in fixtures {
        let name = fx["name"].as_str().unwrap();
        let opcode = fx["opcode"].as_u64().unwrap() as u32;
        let bytes = hex::decode(fx["hex"].as_str().unwrap()).unwrap();
        let reject = fx["expect"].as_str() == Some("reject");
        let future = fx.get("trailing_hex").is_some();
        let mut off = 0usize;
        match fx["dir"].as_str().unwrap() {
            "C2S" => {
                assert!(VehicleC2S::is_vehicle_opcode(opcode), "{name}");
                let got = VehicleC2S::unpack_payload(opcode, &bytes, &mut off);
                if reject {
                    assert!(got.is_none(), "{name}: must be rejected");
                    assert_eq!(off, 0, "{name}: offset restored on reject");
                    continue;
                }
                let msg = got.unwrap_or_else(|| panic!("{name}: unpack failed"));
                assert_eq!(off, bytes.len(), "{name}: consumed");
                assert_eq!(norm(&c2s_fields(&msg)), body_fields(fx), "{name}: fields");
                let mut buf = Vec::new();
                c2s_from(opcode, &body_fields(fx)).pack_payload(&mut buf);
                if !future {
                    assert_eq!(hex::encode(&buf), fx["hex"].as_str().unwrap(), "{name}: pack");
                }
            }
            "S2C" => {
                assert!(VehicleS2C::is_vehicle_opcode(opcode), "{name}");
                let got = VehicleS2C::unpack_payload(opcode, &bytes, &mut off);
                if reject {
                    assert!(got.is_none(), "{name}: must be rejected");
                    continue;
                }
                let msg = got.unwrap_or_else(|| panic!("{name}: unpack failed"));
                assert_eq!(off, bytes.len(), "{name}: consumed (incl. future trailing bytes)");
                assert_eq!(norm(&s2c_fields(&msg)), body_fields(fx), "{name}: fields");
                let mut buf = Vec::new();
                s2c_from(opcode, &body_fields(fx)).pack_payload(&mut buf);
                if !future {
                    assert_eq!(hex::encode(&buf), fx["hex"].as_str().unwrap(), "{name}: pack");
                } else {
                    // A v1 writer emits version 1 and no trailing bytes.
                    let trailing = fx["trailing_hex"].as_str().unwrap().len() / 2;
                    let mut want = bytes[..bytes.len() - trailing].to_vec();
                    want[4] = 1;
                    want[5] = 0;
                    assert_eq!(buf, want, "{name}: v1 repack");
                }
            }
            other => panic!("{name}: bad dir {other}"),
        }
        checked += 1;
    }
    assert_eq!(checked, fixtures.len() - 1, "every non-reject fixture checked");
}

#[test]
fn hbv1_frames_route_through_game_message() {
    let doc: Value = serde_json::from_str(FIXTURES).unwrap();
    let mut seen = 0;
    for fx in doc["fixtures"].as_array().unwrap() {
        let Some(frame_hex) = fx["frame_hex"].as_str() else {
            continue;
        };
        let name = fx["name"].as_str().unwrap();
        let data = hex::decode(frame_hex).unwrap();
        let mut off = 0;
        let msg = GameMessage::unpack(&data, &mut off).unwrap_or_else(|| panic!("{name}: frame"));
        match &msg {
            GameMessage::GameAction(a) => {
                assert_eq!(a.sequence as u64, fx["frame"]["sequence"].as_u64().unwrap());
                let GameAction::Vehicle(v) = &a.action else {
                    panic!("{name}: expected GameAction::Vehicle, got {:?}", a.action)
                };
                assert_eq!(norm(&c2s_fields(v)), body_fields(fx), "{name}");
            }
            GameMessage::GameEvent(e) => {
                assert_eq!(e.sequence as u64, fx["frame"]["sequence"].as_u64().unwrap());
                assert_eq!(e.target.0 as u64, fx["frame"]["target"].as_u64().unwrap());
                let GameEvent::Vehicle(v) = &e.event else {
                    panic!("{name}: expected GameEvent::Vehicle, got {:?}", e.event)
                };
                assert_eq!(norm(&s2c_fields(v)), body_fields(fx), "{name}");
            }
            other => panic!("{name}: unexpected {other:?}"),
        }
        let mut buf = Vec::new();
        msg.pack(&mut buf);
        assert_eq!(hex::encode(&buf), frame_hex, "{name}: frame repack");
        seen += 1;
    }
    assert_eq!(seen, 3, "three framed fixtures");
}

#[test]
fn hbv1_bad_tag_event_is_dropped_not_fatal() {
    // A vehicle event opcode with a foreign payload (e.g. another mod reusing 0x0906) must not break the
    // message stream: the event dispatcher keeps it as Unknown and the session carries on.
    let mut data = hex::decode("b0f70000010000500100000006090000").unwrap();
    data.extend_from_slice(b"XXXXjunkjunk");
    let mut off = 0;
    let msg = GameMessage::unpack(&data, &mut off).expect("frame still parses");
    let GameMessage::GameEvent(e) = msg else {
        panic!("event")
    };
    assert!(matches!(e.event, GameEvent::Unknown(0x0906, _)), "{:?}", e.event);
}

#[test]
fn hbv1_truncated_input_rejected() {
    let doc: Value = serde_json::from_str(FIXTURES).unwrap();
    let fx = doc["fixtures"]
        .as_array()
        .unwrap()
        .iter()
        .find(|f| f["name"] == "vehicle_input_3")
        .unwrap();
    let bytes = hex::decode(fx["hex"].as_str().unwrap()).unwrap();
    for cut in [bytes.len() - 1, 20, 9, 0] {
        let mut off = 0;
        assert!(VehicleC2S::unpack_payload(c2s::INPUT, &bytes[..cut], &mut off).is_none());
        assert_eq!(off, 0);
    }
    // A hostile count cannot allocate past the payload.
    let mut evil = bytes[..16].to_vec();
    evil[12..16].copy_from_slice(&u32::MAX.to_le_bytes());
    let mut off = 0;
    assert!(VehicleC2S::unpack_payload(c2s::INPUT, &evil, &mut off).is_none());
}
