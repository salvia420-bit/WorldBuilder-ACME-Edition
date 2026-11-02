//! HBV1 fixture round-trips: the bytes in `vehicle-wire-fixtures.json` (generated from the XML spec by
//! `gen_fixtures.py`) must unpack to the fixture's fields, and the fields (and the unpacked message) must
//! pack to the same bytes — or, for a payload of another version (v1, or a future one with trailing bytes),
//! to the fixture's `repack_hex`: what this (v2) writer emits for those fields. v1 fixtures list the v2
//! fields at their defaults (what a v2 reader yields). The ACE side runs the same fixtures
//! (ACE.Server.Tests/Vehicles/VehicleWireTests.cs).

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
        VehicleS2C::Profile(p) => {
            let mut v = json!({
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
            });
            // v2 (inserted separately: one more nested json! would push the macro past the recursion limit)
            let o = v.as_object_mut().unwrap();
            o.insert("PartRoleCount".into(), json!(p.part_roles.len()));
            o.insert("PartRoles".into(), json!(p.part_roles));
            o.insert("WeaponExtCount".into(), json!(p.weapon_ext.len()));
            o.insert(
                "WeaponExt".into(),
                Value::Array(
                    p.weapon_ext
                        .iter()
                        .map(|x| {
                            json!({
                                "MuzzleVelocity": f(x.muzzle_velocity), "Convergence": f(x.convergence),
                                "MassKg": f(x.mass_kg), "DragTerminal": f(x.drag_terminal), "SpellId": x.spell_id,
                            })
                        })
                        .collect(),
                ),
            );
            v
        }
        VehicleS2C::Seat(s) => json!({
            "Vehicle": s.vehicle, "Seat": s.seat, "Occupant": s.occupant, "State": s.state, "Reason": s.reason,
        }),
        VehicleS2C::State(s) => json!({
            "Vehicle": s.vehicle, "Step": s.step, "AckInputSeq": s.ack_input_seq, "Cell": s.cell,
            "Position": v3(s.position), "Heading": f(s.heading), "Pitch": f(s.pitch), "Bank": f(s.bank),
            "Speed": f(s.speed), "VCap": f(s.v_cap), "Ammo": s.ammo, "Mode": s.mode, "Flags": s.flags,
            "MissileMask": s.missile_mask, "BombMask": s.bomb_mask, "Reserved2": s.reserved2,
        }),
        VehicleS2C::Fire(fi) => json!({
            "Vehicle": fi.vehicle, "Step": fi.step, "Mount": fi.mount, "Count": fi.count, "Cell": fi.cell,
            "Muzzle": v3(fi.muzzle), "DirX": fi.dir[0], "DirY": fi.dir[1], "DirZ": fi.dir[2],
            "Reserved": fi.reserved, "Seed": fi.seed,
            "MountCount": fi.mount_count, "Reserved2": fi.reserved2, "Speed": f(fi.speed),
        }),
        VehicleS2C::Event(e) => json!({
            "Vehicle": e.vehicle, "Kind": e.kind, "Step": e.step, "Subject": e.subject, "Cell": e.cell,
            "Position": v3(e.position), "Value": f(e.value),
            "Aux": e.aux, "Velocity": v3(e.velocity),
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
            part_roles: o["PartRoles"]
                .as_array()
                .unwrap()
                .iter()
                .map(|r| r.as_u64().expect("PartRoles: uint") as u32)
                .collect(),
            weapon_ext: o["WeaponExt"]
                .as_array()
                .unwrap()
                .iter()
                .map(|x| VehicleWeaponExt {
                    muzzle_velocity: gf(x, "MuzzleVelocity"),
                    convergence: gf(x, "Convergence"),
                    mass_kg: gf(x, "MassKg"),
                    drag_terminal: gf(x, "DragTerminal"),
                    spell_id: gu(x, "SpellId"),
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
            missile_mask: gu(o, "MissileMask") as u8,
            bomb_mask: gu(o, "BombMask") as u8,
            reserved2: gu(o, "Reserved2") as u16,
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
            mount_count: gu(o, "MountCount") as u16,
            reserved2: gu(o, "Reserved2") as u16,
            speed: gf(o, "Speed"),
        }),
        s2c::EVENT => VehicleS2C::Event(VehicleEvent {
            vehicle: gu(o, "Vehicle"),
            kind: gu(o, "Kind"),
            step: gu(o, "Step"),
            subject: gu(o, "Subject"),
            cell: gu(o, "Cell"),
            position: gv3(o, "Position"),
            value: gf(o, "Value"),
            aux: gu(o, "Aux"),
            velocity: gv3(o, "Velocity"),
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

fn all_fixtures() -> Vec<Value> {
    let doc: Value = serde_json::from_str(FIXTURES).expect("fixtures JSON");
    doc["fixtures"].as_array().unwrap().clone()
}

fn fixture(name: &str) -> Value {
    all_fixtures()
        .into_iter()
        .find(|f| f["name"] == name)
        .unwrap_or_else(|| panic!("no fixture {name}"))
}

fn fixture_bytes(name: &str) -> Vec<u8> {
    hex::decode(fixture(name)["hex"].as_str().unwrap()).unwrap()
}

fn unpack_s2c(opcode: u32, bytes: &[u8]) -> VehicleS2C {
    let mut off = 0;
    let msg = VehicleS2C::unpack_payload(opcode, bytes, &mut off).expect("unpack");
    assert_eq!(off, bytes.len(), "consumed");
    msg
}

#[test]
fn hbv1_fixtures_round_trip() {
    let doc: Value = serde_json::from_str(FIXTURES).expect("fixtures JSON");
    assert_eq!(doc["tag"].as_u64(), Some(HBV1_TAG as u64));
    assert_eq!(doc["version"].as_u64(), Some(HBV1_VERSION as u64), "fixtures are for this protocol version");
    let fixtures = doc["fixtures"].as_array().unwrap();
    assert!(fixtures.len() >= 19, "fixture file shrank");
    let (mut checked, mut legacy, mut future) = (0, 0, 0);
    for fx in fixtures {
        let name = fx["name"].as_str().unwrap();
        let opcode = fx["opcode"].as_u64().unwrap() as u32;
        let version = fx["version"].as_u64().unwrap() as u16;
        let bytes = hex::decode(fx["hex"].as_str().unwrap()).unwrap();
        let reject = fx["expect"].as_str() == Some("reject");
        // what this (v2) writer emits for the fixture's fields: the payload itself for a current-version
        // fixture, else the generator's repack (v1 → v2 header + the v2 fields at their defaults; a future
        // version → v2 header, its trailing bytes dropped)
        let want = fx
            .get("repack_hex")
            .and_then(Value::as_str)
            .unwrap_or_else(|| fx["hex"].as_str().unwrap());
        if !reject {
            assert_eq!(
                fx.get("repack_hex").is_none(),
                version == HBV1_VERSION && fx.get("trailing_hex").is_none(),
                "{name}: repack_hex exactly for other-version payloads"
            );
        }
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
                msg.pack_payload(&mut buf);
                assert_eq!(hex::encode(&buf), want, "{name}: unpack → pack");
                let mut buf = Vec::new();
                c2s_from(opcode, &body_fields(fx)).pack_payload(&mut buf);
                assert_eq!(hex::encode(&buf), want, "{name}: fields → pack");
            }
            "S2C" => {
                assert!(VehicleS2C::is_vehicle_opcode(opcode), "{name}");
                let got = VehicleS2C::unpack_payload(opcode, &bytes, &mut off);
                if reject {
                    assert!(got.is_none(), "{name}: must be rejected");
                    assert_eq!(off, 0, "{name}: offset restored on reject");
                    continue;
                }
                let msg = got.unwrap_or_else(|| panic!("{name}: unpack failed"));
                assert_eq!(off, bytes.len(), "{name}: consumed (incl. future trailing bytes)");
                assert_eq!(norm(&s2c_fields(&msg)), body_fields(fx), "{name}: fields");
                let mut buf = Vec::new();
                msg.pack_payload(&mut buf);
                assert_eq!(hex::encode(&buf), want, "{name}: unpack → pack");
                let mut buf = Vec::new();
                s2c_from(opcode, &body_fields(fx)).pack_payload(&mut buf);
                assert_eq!(hex::encode(&buf), want, "{name}: fields → pack");
            }
            other => panic!("{name}: bad dir {other}"),
        }
        if version < HBV1_VERSION {
            legacy += 1;
        }
        if version > HBV1_VERSION {
            assert!(fx.get("trailing_hex").is_some(), "{name}: a future fixture carries trailing bytes");
            future += 1;
        }
        checked += 1;
    }
    assert_eq!(checked, fixtures.len() - 1, "every non-reject fixture checked");
    assert!(legacy >= 5, "v1 Profile / State / Fire / Event / a C2S action still parse ({legacy})");
    assert!(future >= 1, "a future-version payload");
}

#[test]
fn hbv1_v1_payloads_default_the_v2_fields() {
    let VehicleS2C::Profile(p) = unpack_s2c(s2c::PROFILE, &fixture_bytes("vehicle_profile_hellcat_v1")) else {
        panic!("profile")
    };
    assert!(p.part_roles.is_empty() && p.weapon_ext.is_empty());
    assert_eq!(p.parts.len(), 2);
    let VehicleS2C::State(s) = unpack_s2c(s2c::STATE, &fixture_bytes("vehicle_state_pilot_v1")) else {
        panic!("state")
    };
    assert_eq!((s.missile_mask, s.bomb_mask, s.reserved2), (0, 0, 0));
    assert_eq!(s.ammo, 187);
    let VehicleS2C::Fire(fi) = unpack_s2c(s2c::FIRE, &fixture_bytes("vehicle_fire_v1")) else {
        panic!("fire")
    };
    assert_eq!(fi.mount_count, 1, "a v1 burst is one mount");
    assert_eq!((fi.reserved2, fi.speed), (0, 0.0));
    let VehicleS2C::Event(e) = unpack_s2c(s2c::EVENT, &fixture_bytes("vehicle_event_crashed_v1")) else {
        panic!("event")
    };
    assert_eq!((e.kind, e.aux, e.velocity), (event_kind::CRASHED, 0, [0.0; 3]));
    // a v1 C2S action from an old client
    let bytes = fixture_bytes("vehicle_board_v1");
    let mut off = 0;
    assert_eq!(
        VehicleC2S::unpack_payload(c2s::BOARD, &bytes, &mut off),
        Some(VehicleC2S::Board {
            vehicle: 2147486209,
            seat: 0
        })
    );
}

#[test]
fn hbv1_v2_fields_and_enums() {
    let VehicleS2C::Profile(p) = unpack_s2c(s2c::PROFILE, &fixture_bytes("vehicle_profile_hellcat")) else {
        panic!("profile")
    };
    assert_eq!(p.part_roles.len(), p.parts.len());
    assert_eq!(p.weapon_ext.len(), p.weapons.len());
    let kinds: Vec<u32> = p.weapons.iter().map(|w| w.kind).collect();
    assert_eq!(kinds, [weapon_kind::REPEATING_CROSSBOW, weapon_kind::MISSILE, weapon_kind::BOMB]);
    assert_eq!(p.part_roles[1], part_role::PROPELLER);
    assert_eq!(p.part_roles[2], part_role::GEAR);
    assert_eq!(p.part_roles[3], part_role::ordnance(2));
    assert_eq!(part_role::role(p.part_roles[3]), part_role::ORDNANCE);
    assert_eq!(part_role::weapon_index(p.part_roles[3]), 2);
    assert_eq!(p.weapon_ext[1].spell_id, 80);
    let VehicleS2C::Fire(fi) = unpack_s2c(s2c::FIRE, &fixture_bytes("vehicle_fire")) else {
        panic!("fire")
    };
    assert_eq!((fi.mount_count, fi.speed), (2, 152.5));
    let VehicleS2C::Event(e) = unpack_s2c(s2c::EVENT, &fixture_bytes("vehicle_event_bomb_release")) else {
        panic!("event")
    };
    assert_eq!((e.kind, e.aux, e.velocity), (event_kind::BOMB_RELEASE, 2, [12.5, 66.25, -1.5]));
    // the input fixture's middle frame holds Missile + Bomb
    let mut off = 0;
    let Some(VehicleC2S::Input { frames, .. }) =
        VehicleC2S::unpack_payload(c2s::INPUT, &fixture_bytes("vehicle_input_3"), &mut off)
    else {
        panic!("input")
    };
    assert_eq!(frames[1].buttons, buttons::MISSILE | buttons::BOMB);
}

#[test]
fn hbv1_truncated_v2_tail_and_hostile_v2_counts_rejected() {
    // a v2 payload cut inside its v2 tail is truncated, not a v1 payload
    for (name, opcode) in [
        ("vehicle_state_pilot", s2c::STATE),
        ("vehicle_fire", s2c::FIRE),
        ("vehicle_event_bomb_release", s2c::EVENT),
        ("vehicle_profile_hellcat", s2c::PROFILE),
    ] {
        let bytes = fixture_bytes(name);
        for cut in [bytes.len() - 1, bytes.len() - 4] {
            let mut off = 0;
            assert!(VehicleS2C::unpack_payload(opcode, &bytes[..cut], &mut off).is_none(), "{name} cut {cut}");
            assert_eq!(off, 0, "{name}: offset restored");
        }
    }
    // hostile PartRoleCount / WeaponExtCount cannot allocate past the payload
    let fx = fixture("vehicle_profile_hellcat");
    let roles = gu(&fx["fields"], "PartRoleCount") as usize;
    let exts = gu(&fx["fields"], "WeaponExtCount") as usize;
    let bytes = fixture_bytes("vehicle_profile_hellcat");
    let ext_count_at = bytes.len() - (4 + VehicleWeaponExt::WIRE * exts);
    let role_count_at = ext_count_at - (4 + 4 * roles);
    for at in [role_count_at, ext_count_at] {
        let mut evil = bytes.clone();
        evil[at..at + 4].copy_from_slice(&u32::MAX.to_le_bytes());
        let mut off = 0;
        assert!(VehicleS2C::unpack_payload(s2c::PROFILE, &evil, &mut off).is_none(), "hostile count at {at}");
        assert_eq!(off, 0);
    }
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
