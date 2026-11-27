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
fn gu64(o: &Value, k: &str) -> u64 {
    o[k].as_u64().unwrap_or_else(|| panic!("missing ulong {k}"))
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
        VehicleC2S::Cargo {
            vehicle,
            action,
            target,
            slot,
            reserved0,
            reserved1,
            cargo_wcid,
        } => json!({
            "Vehicle": vehicle,
            "Action": action,
            "Target": target,
            "Slot": slot,
            "Reserved0": reserved0,
            "Reserved1": reserved1,
            "CargoWcid": cargo_wcid,
        }),
        VehicleC2S::ContainerAction(ca) => json!({
            "Container": ca.container,
            "Action": ca.action,
            "SlotIndex": ca.slot_index,
            "SubSlot": ca.sub_slot,
            "Reserved": ca.reserved,
            "CargoWcid": ca.cargo_wcid,
        }),
        VehicleC2S::TrailerAction(ta) => json!({
            "TrailerGuid": ta.trailer_guid,
            "VehicleGuid": ta.vehicle_guid,
            "ContainerGuid": ta.container_guid,
            "Action": ta.action,
            "Slot": ta.slot,
            "Flags": ta.flags,
        }),
        VehicleC2S::PalletJackAction(pj) => json!({
            "PalletJackGuid": pj.pallet_jack_guid,
            "Action": pj.action,
            "SlotIndex": pj.slot_index,
            "SubSlot": pj.sub_slot,
            "Flags": pj.flags,
            "TargetGuid": pj.target_guid,
            "Cell": pj.cell,
            "Position": v3(pj.position),
            "Heading": f(pj.heading),
            "TillerAngle": f(pj.tiller_angle),
        }),
        VehicleC2S::EconomySiegeAction(sa) => json!({
            "TownId": sa.town_id,
            "BeaconGuid": sa.beacon_guid,
            "Action": sa.action,
            "Flags": sa.flags,
            "Reserved": sa.reserved,
            "SupplyPoints": sa.supply_points,
            "OriginLandblock": sa.origin_landblock,
        }),
        VehicleC2S::IndustryProspecting(ip) => json!({
            "ToolGuid": ip.tool_guid,
            "ToolKind": ip.tool_kind,
            "Mode": ip.mode,
            "Reserved0": ip.reserved0,
            "Reserved1": ip.reserved1,
            "Cell": ip.cell,
            "Position": v3(ip.position),
        }),
        VehicleC2S::IndustryFacilityAction(fa) => json!({
            "FacilityGuid": fa.facility_guid,
            "Action": fa.action,
            "Reserved0": fa.reserved0,
            "Reserved1": fa.reserved1,
            "RecipeId": fa.recipe_id,
            "Param": fa.param,
        }),
        VehicleC2S::LogisticsConvoyOrder(co) => json!({
            "ConvoyId": co.convoy_id,
            "Action": co.action,
            "VehicleClass": co.vehicle_class,
            "Flags": co.flags,
            "OriginTownId": co.origin_town_id,
            "DestTownId": co.dest_town_id,
            "ContainerKind": co.container_kind,
            "CommodityId": co.commodity_id,
        }),
        VehicleC2S::EconomyMonarchOrder(mo) => json!({
            "OrderId": mo.order_id,
            "TownId": mo.town_id,
            "Action": mo.action,
            "OrderType": mo.order_type,
            "Flags": mo.flags,
            "TargetGuid": mo.target_guid,
            "ItemWcid": mo.item_wcid,
            "Quantity": mo.quantity,
            "RewardPyreals": mo.reward_pyreals,
            "ParamF32": f(mo.param_f32),
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
        c2s::CARGO => VehicleC2S::Cargo {
            vehicle: gu(o, "Vehicle"),
            action: gu(o, "Action") as u8,
            target: gu(o, "Target"),
            slot: o.get("Slot").and_then(|v| v.as_u64()).unwrap_or(0) as u8,
            reserved0: o.get("Reserved0").and_then(|v| v.as_u64()).unwrap_or(0) as u8,
            reserved1: o.get("Reserved1").and_then(|v| v.as_u64()).unwrap_or(0) as u16,
            cargo_wcid: o.get("CargoWcid").and_then(|v| v.as_u64()).unwrap_or(0) as u32,
        },
        c2s::CONTAINER_ACTION => VehicleC2S::ContainerAction(VehicleContainerAction {
            container: gu(o, "Container"),
            action: gu(o, "Action") as u8,
            slot_index: gu(o, "SlotIndex") as u8,
            sub_slot: gu(o, "SubSlot") as u8,
            reserved: gu(o, "Reserved") as u8,
            cargo_wcid: gu(o, "CargoWcid"),
        }),
        c2s::TRAILER_ACTION => VehicleC2S::TrailerAction(VehicleTrailerAction {
            trailer_guid: gu(o, "TrailerGuid"),
            vehicle_guid: gu(o, "VehicleGuid"),
            container_guid: gu(o, "ContainerGuid"),
            action: gu(o, "Action") as u8,
            slot: gu(o, "Slot") as u8,
            flags: gu(o, "Flags") as u16,
        }),
        c2s::PALLET_JACK_ACTION => VehicleC2S::PalletJackAction(VehiclePalletJackAction {
            pallet_jack_guid: gu(o, "PalletJackGuid"),
            action: gu(o, "Action") as u8,
            slot_index: gu(o, "SlotIndex") as u8,
            sub_slot: gu(o, "SubSlot") as u8,
            flags: gu(o, "Flags") as u8,
            target_guid: gu(o, "TargetGuid"),
            cell: gu(o, "Cell"),
            position: gv3(o, "Position"),
            heading: gf(o, "Heading"),
            tiller_angle: gf(o, "TillerAngle"),
        }),
        c2s::ECONOMY_SIEGE_ACTION => VehicleC2S::EconomySiegeAction(EconomySiegeAction {
            town_id: gu(o, "TownId"),
            beacon_guid: gu(o, "BeaconGuid"),
            action: gu(o, "Action") as u8,
            flags: gu(o, "Flags") as u8,
            reserved: gu(o, "Reserved") as u16,
            supply_points: gu(o, "SupplyPoints"),
            origin_landblock: gu(o, "OriginLandblock"),
        }),
        c2s::INDUSTRY_PROSPECTING => VehicleC2S::IndustryProspecting(IndustryProspecting {
            tool_guid: gu(o, "ToolGuid"),
            tool_kind: gu(o, "ToolKind"),
            mode: gu(o, "Mode") as u8,
            reserved0: gu(o, "Reserved0") as u8,
            reserved1: gu(o, "Reserved1") as u16,
            cell: gu(o, "Cell"),
            position: gv3(o, "Position"),
        }),
        c2s::INDUSTRY_FACILITY_ACTION => VehicleC2S::IndustryFacilityAction(IndustryFacilityAction {
            facility_guid: gu(o, "FacilityGuid"),
            action: gu(o, "Action") as u8,
            reserved0: gu(o, "Reserved0") as u8,
            reserved1: gu(o, "Reserved1") as u16,
            recipe_id: gu(o, "RecipeId"),
            param: gu(o, "Param"),
        }),
        c2s::LOGISTICS_CONVOY_ORDER => VehicleC2S::LogisticsConvoyOrder(LogisticsConvoyOrder {
            convoy_id: gu64(o, "ConvoyId"),
            action: gu(o, "Action") as u8,
            vehicle_class: gu(o, "VehicleClass") as u8,
            flags: gu(o, "Flags") as u16,
            origin_town_id: gu(o, "OriginTownId"),
            dest_town_id: gu(o, "DestTownId"),
            container_kind: gu(o, "ContainerKind"),
            commodity_id: gu(o, "CommodityId"),
        }),
        c2s::ECONOMY_MONARCH_ORDER => VehicleC2S::EconomyMonarchOrder(EconomyMonarchOrder {
            order_id: gu64(o, "OrderId"),
            town_id: gu(o, "TownId"),
            action: gu(o, "Action") as u8,
            order_type: gu(o, "OrderType") as u8,
            flags: gu(o, "Flags") as u16,
            target_guid: gu(o, "TargetGuid"),
            item_wcid: gu(o, "ItemWcid"),
            quantity: gu(o, "Quantity"),
            reward_pyreals: gu64(o, "RewardPyreals"),
            param_f32: gf(o, "ParamF32"),
        }),
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
            // v3
            o.insert("Wheelbase".into(), f(p.wheelbase));
            o.insert("TrackWidth".into(), f(p.track_width));
            o.insert("WheelRadius".into(), f(p.wheel_radius));
            o.insert("MaxSteerRad".into(), f(p.max_steer_rad));
            o.insert("ReverseMax".into(), f(p.reverse_max));
            o.insert("ClimbLimitCos".into(), f(p.climb_limit_cos));
            o.insert("FordDepthMax".into(), f(p.ford_depth_max));
            o.insert("CargoWcid".into(), json!(p.cargo_wcid));
            // v6
            o.insert("FifthWheelOffsetY".into(), f(p.fifth_wheel_offset_y));
            o.insert("FifthWheelOffsetZ".into(), f(p.fifth_wheel_offset_z));
            o.insert("LiveryId".into(), json!(p.livery_id));
            o.insert("VehicleClass".into(), json!(p.vehicle_class));
            o.insert("Reserved4".into(), json!(p.reserved4));
            v
        }
        VehicleS2C::Seat(s) => json!({
            "Vehicle": s.vehicle, "Seat": s.seat, "Occupant": s.occupant, "State": s.state, "Reason": s.reason,
        }),
        VehicleS2C::State(s) => {
            let mut v = json!({
                "Vehicle": s.vehicle, "Step": s.step, "AckInputSeq": s.ack_input_seq, "Cell": s.cell,
                "Position": v3(s.position), "Heading": f(s.heading), "Pitch": f(s.pitch), "Bank": f(s.bank),
                "Speed": f(s.speed), "VCap": f(s.v_cap), "Ammo": s.ammo, "Mode": s.mode, "Flags": s.flags,
                "MissileMask": s.missile_mask, "BombMask": s.bomb_mask, "Reserved2": s.reserved2,
                "SteerAngle": f(s.steer_angle), "GroundFlags": s.ground_flags, "SurfaceFamily": s.surface_family, "WheelSpinQ16": s.wheel_spin_q16,
                "CargoMask": s.cargo_mask, "PalletSize0": s.pallet_size0, "PalletSize1": s.pallet_size1, "Reserved3": s.reserved3,
                "CargoSlot0Wcid": s.cargo_slot0_wcid, "CargoSlot1Wcid": s.cargo_slot1_wcid,
            });
            let o = v.as_object_mut().unwrap();
            o.insert("HitchedTrailerGuid".into(), json!(s.hitched_trailer_guid));
            o.insert("TrailerHeading".into(), f(s.trailer_heading));
            o.insert("TrailerPitch".into(), f(s.trailer_pitch));
            o.insert("TrailerFlags".into(), json!(s.trailer_flags));
            o.insert("Reserved4".into(), json!(s.reserved4));
            o.insert("Reserved5".into(), json!(s.reserved5));
            v
        }
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
        VehicleS2C::RadarContacts(rc) => json!({
            "RadarGuid": rc.radar_guid,
            "ParentVehicle": rc.parent_vehicle,
            "RadarX": f(rc.radar_x),
            "RadarY": f(rc.radar_y),
            "RadarZ": f(rc.radar_z),
            "RangeM": f(rc.range_m),
            "CeilingM": f(rc.ceiling_m),
            "ContactCount": rc.contacts.len(),
            "Contacts": rc.contacts.iter().map(|c| json!({
                "VehicleGuid": c.vehicle_guid,
                "DxM": f(c.dx_m),
                "DyM": f(c.dy_m),
                "AltAglM": c.alt_agl_m,
                "HeadingU8": c.heading_u8,
                "Standing": c.standing,
                "SpeedMpsU8": c.speed_mps_u8,
                "Flags": c.flags,
            })).collect::<Vec<_>>(),
        }),
        VehicleS2C::DeployableState(ds) => json!({
            "DeployableGuid": ds.deployable_guid,
            "DeployableKind": ds.deployable_kind,
            "PalletSize": ds.pallet_size,
            "OnlineFlags": ds.online_flags,
            "AmmoRemaining": ds.ammo_remaining,
            "OwnerGuid": ds.owner_guid,
            "ParentVehicle": ds.parent_vehicle,
            "Cell": ds.cell,
            "Position": v3(ds.position),
            "Heading": f(ds.heading),
            "PowerWatts": f(ds.power_watts),
            "EnergyStoredJoules": f(ds.energy_stored_joules),
            "EnergyCapacityJoules": f(ds.energy_capacity_joules),
            "FuelRemaining": f(ds.fuel_remaining),
            "PitchRad": f(ds.pitch_rad),
            "YawRad": f(ds.yaw_rad),
            "RollRad": f(ds.roll_rad),
            "ElevationM": f(ds.elevation_m),
        }),
        VehicleS2C::DeployableFire(df) => json!({
            "DeployableGuid": df.deployable_guid,
            "WeaponKind": df.weapon_kind,
            "Step": df.step,
            "TargetGuid": df.target_guid,
            "Cell": df.cell,
            "Muzzle": v3(df.muzzle),
            "TargetPos": v3(df.target_pos),
            "Velocity": v3(df.velocity),
            "EnergyJoules": f(df.energy_joules),
            "BurstCount": df.burst_count,
            "Reserved": df.reserved,
        }),
        VehicleS2C::GroundContacts(gc) => json!({
            "RadarGuid": gc.radar_guid,
            "ParentVehicle": gc.parent_vehicle,
            "RadarX": f(gc.radar_x),
            "RadarY": f(gc.radar_y),
            "RadarZ": f(gc.radar_z),
            "RangeM": f(gc.range_m),
            "SweepAngleRad": f(gc.sweep_angle_rad),
            "ContactCount": gc.contacts.len(),
            "Contacts": gc.contacts.iter().map(|c| json!({
                "TargetGuid": c.target_guid,
                "DxM": f(c.dx_m),
                "DyM": f(c.dy_m),
                "DzM": f(c.dz_m),
                "Kind": c.kind,
                "Standing": c.standing,
                "HeadingU8": c.heading_u8,
                "SpeedMpsU8": c.speed_mps_u8,
                "Flags": c.flags,
                "Reserved0": c.reserved0,
                "Reserved1": c.reserved1,
                "Reserved2": c.reserved2,
            })).collect::<Vec<_>>(),
        }),
        VehicleS2C::ContainerState(cs) => json!({
            "ContainerGuid": cs.container_guid,
            "ContainerKind": cs.container_kind,
            "DoorState": cs.door_state,
            "LiveryId": cs.livery_id,
            "MaxFullSlots": cs.max_full_slots,
            "Flags": cs.flags,
            "OwnerGuid": cs.owner_guid,
            "Cell": cs.cell,
            "Position": v3(cs.position),
            "Heading": f(cs.heading),
            "DoorProgress": f(cs.door_progress),
            "SerialNumber": cs.serial_number,
            "SlotCount": cs.slots.len(),
            "Slots": cs.slots.iter().map(|s| json!({
                "SlotIndex": s.slot_index,
                "PalletSize": s.pallet_size,
                "SubSlot": s.sub_slot,
                "Reserved": s.reserved,
                "CargoWcid": s.cargo_wcid,
            })).collect::<Vec<_>>(),
        }),
        VehicleS2C::TrailerState(ts) => json!({
            "TrailerGuid": ts.trailer_guid,
            "Kind": ts.kind,
            "Cell": ts.cell,
            "Position": v3(ts.position),
            "Heading": f(ts.heading),
            "Pitch": f(ts.pitch),
            "Bank": f(ts.bank),
            "CoupledTractorGuid": ts.coupled_tractor_guid,
            "MountedContainerGuid": ts.mounted_container_guid,
            "ContainerSlot": ts.container_slot,
            "TrailerFlags": ts.trailer_flags,
            "Reserved": ts.reserved,
            "OwnerGuid": ts.owner_guid,
            "SideliftPhase": ts.sidelift_phase,
            "SideliftSide": ts.sidelift_side,
            "SideliftFlags": ts.sidelift_flags,
            "Reserved7": ts.reserved7,
            "SideliftProgress": f(ts.sidelift_progress),
            "OutriggerProgress": f(ts.outrigger_progress),
            "CraneSpanY": f(ts.crane_span_y),
            "StowedPalletJackGuid": ts.stowed_pallet_jack_guid,
            "TransferContainerGuid": ts.transfer_container_guid,
        }),
        VehicleS2C::PalletJackState(pj) => json!({
            "PalletJackGuid": pj.pallet_jack_guid,
            "OperatorGuid": pj.operator_guid,
            "StowedOnTrailerGuid": pj.stowed_on_trailer_guid,
            "Cell": pj.cell,
            "Position": v3(pj.position),
            "Heading": f(pj.heading),
            "TillerAngle": f(pj.tiller_angle),
            "ForkHeightM": f(pj.fork_height_m),
            "ForkState": pj.fork_state,
            "CarriedPalletSize": pj.carried_pallet_size,
            "Flags": pj.flags,
            "Reserved": pj.reserved,
            "CarriedWcid": pj.carried_wcid,
            "OwnerGuid": pj.owner_guid,
        }),
        VehicleS2C::EconomyTownState(ts) => json!({
            "TownId": ts.town_id,
            "ControlState": ts.control_state,
            "OwnerMonarchId": ts.owner_monarch_id,
            "AttackerMonarchId": ts.attacker_monarch_id,
            "Flags": ts.flags,
            "Reserved": ts.reserved,
            "AnchorLandblock": ts.anchor_landblock,
            "HoldElapsedSec": ts.hold_elapsed_sec,
            "SupplyMeterSec": ts.supply_meter_sec,
            "StarvingSec": ts.starving_sec,
            "TreasuryPyreals": ts.treasury_pyreals,
            "EscrowPyreals": ts.escrow_pyreals,
            "TariffBuyMul": f(ts.tariff_buy_mul),
            "TariffSellMul": f(ts.tariff_sell_mul),
        }),
        VehicleS2C::EconomySiegeEvent(se) => json!({
            "TownId": se.town_id,
            "Kind": se.kind,
            "ControlState": se.control_state,
            "Reserved": se.reserved,
            "OwnerMonarchId": se.owner_monarch_id,
            "AttackerMonarchId": se.attacker_monarch_id,
            "HoldElapsedSec": se.hold_elapsed_sec,
            "SupplyMeterSec": se.supply_meter_sec,
            "StarvingSec": se.starving_sec,
            "TreasurySpoils": se.treasury_spoils,
        }),
        VehicleS2C::IndustrySurveyResult(sr) => json!({
            "DepositId": sr.deposit_id,
            "LandblockId": sr.landblock_id,
            "ToolKind": sr.tool_kind,
            "Flags": sr.flags,
            "TerrainCode": sr.terrain_code,
            "ResourceKind": sr.resource_kind,
            "Reserved": sr.reserved,
            "DepthM": f(sr.depth_m),
            "GradeBps": sr.grade_bps,
            "ApiGravity": f(sr.api_gravity),
            "SulfurBps": sr.sulfur_bps,
            "RemainingTonnes": f(sr.remaining_tonnes),
        }),
        VehicleS2C::IndustryFacilityState(fs) => json!({
            "FacilityGuid": fs.facility_guid,
            "Kind": fs.kind,
            "TownId": fs.town_id,
            "DepositId": fs.deposit_id,
            "OwnerMonarchId": fs.owner_monarch_id,
            "Status": fs.status,
            "OnlineFlags": fs.online_flags,
            "Reserved": fs.reserved,
            "PowerWatts": f(fs.power_watts),
            "BufferJoules": f(fs.buffer_joules),
            "ProgressPct": f(fs.progress_pct),
            "RecipeId": fs.recipe_id,
        }),
        VehicleS2C::LogisticsConvoyState(cs) => json!({
            "ConvoyId": cs.convoy_id,
            "OwnerMonarchId": cs.owner_monarch_id,
            "VehicleGuid": cs.vehicle_guid,
            "VehicleClass": cs.vehicle_class,
            "LodState": cs.lod_state,
            "Status": cs.status,
            "Reserved": cs.reserved,
            "OriginTownId": cs.origin_town_id,
            "DestTownId": cs.dest_town_id,
            "OriginLandblock": cs.origin_landblock,
            "SplineSM": f(cs.spline_s_m),
            "FuelLiters": f(cs.fuel_liters),
            "Cell": cs.cell,
            "Position": v3(cs.position),
            "Heading": f(cs.heading),
        }),
        VehicleS2C::EconomyMonarchOrderState(mo) => json!({
            "OrderId": mo.order_id,
            "MonarchId": mo.monarch_id,
            "TownId": mo.town_id,
            "OrderType": mo.order_type,
            "Status": mo.status,
            "Flags": mo.flags,
            "ClaimedByGuid": mo.claimed_by_guid,
            "ItemWcid": mo.item_wcid,
            "Quantity": mo.quantity,
            "RewardPyreals": mo.reward_pyreals,
            "ValueF32": f(mo.value_f32),
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
            wheelbase: gf(o, "Wheelbase"),
            track_width: gf(o, "TrackWidth"),
            wheel_radius: gf(o, "WheelRadius"),
            max_steer_rad: gf(o, "MaxSteerRad"),
            reverse_max: gf(o, "ReverseMax"),
            climb_limit_cos: gf(o, "ClimbLimitCos"),
            ford_depth_max: gf(o, "FordDepthMax"),
            cargo_wcid: gu(o, "CargoWcid"),
            fifth_wheel_offset_y: o.get("FifthWheelOffsetY").and_then(|v| v.as_f64()).unwrap_or(0.0) as f32,
            fifth_wheel_offset_z: o.get("FifthWheelOffsetZ").and_then(|v| v.as_f64()).unwrap_or(0.0) as f32,
            livery_id: o.get("LiveryId").and_then(|v| v.as_u64()).unwrap_or(0) as u8,
            vehicle_class: o.get("VehicleClass").and_then(|v| v.as_u64()).unwrap_or(0) as u8,
            reserved4: o.get("Reserved4").and_then(|v| v.as_u64()).unwrap_or(0) as u16,
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
            steer_angle: gf(o, "SteerAngle"),
            ground_flags: gu(o, "GroundFlags") as u8,
            surface_family: gu(o, "SurfaceFamily") as u8,
            wheel_spin_q16: gi(o, "WheelSpinQ16") as i16,
            cargo_mask: o.get("CargoMask").and_then(|v| v.as_u64()).unwrap_or(0) as u8,
            pallet_size0: o.get("PalletSize0").and_then(|v| v.as_u64()).unwrap_or(0) as u8,
            pallet_size1: o.get("PalletSize1").and_then(|v| v.as_u64()).unwrap_or(0) as u8,
            reserved3: o.get("Reserved3").and_then(|v| v.as_u64()).unwrap_or(0) as u8,
            cargo_slot0_wcid: o.get("CargoSlot0Wcid").and_then(|v| v.as_u64()).unwrap_or(0) as u32,
            cargo_slot1_wcid: o.get("CargoSlot1Wcid").and_then(|v| v.as_u64()).unwrap_or(0) as u32,
            hitched_trailer_guid: o.get("HitchedTrailerGuid").and_then(|v| v.as_u64()).unwrap_or(0) as u32,
            trailer_heading: o.get("TrailerHeading").and_then(|v| v.as_f64()).unwrap_or(0.0) as f32,
            trailer_pitch: o.get("TrailerPitch").and_then(|v| v.as_f64()).unwrap_or(0.0) as f32,
            trailer_flags: o.get("TrailerFlags").and_then(|v| v.as_u64()).unwrap_or(0) as u8,
            reserved4: o.get("Reserved4").and_then(|v| v.as_u64()).unwrap_or(0) as u8,
            reserved5: o.get("Reserved5").and_then(|v| v.as_u64()).unwrap_or(0) as u16,
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
        s2c::RADAR_CONTACTS => VehicleS2C::RadarContacts(VehicleRadarContacts {
            radar_guid: gu(o, "RadarGuid"),
            parent_vehicle: gu(o, "ParentVehicle"),
            radar_x: gf(o, "RadarX"),
            radar_y: gf(o, "RadarY"),
            radar_z: gf(o, "RadarZ"),
            range_m: gf(o, "RangeM"),
            ceiling_m: gf(o, "CeilingM"),
            contacts: o["Contacts"]
                .as_array()
                .unwrap()
                .iter()
                .map(|c| RadarContactWire {
                    vehicle_guid: gu(c, "VehicleGuid"),
                    dx_m: gf(c, "DxM"),
                    dy_m: gf(c, "DyM"),
                    alt_agl_m: gu(c, "AltAglM") as u16,
                    heading_u8: gu(c, "HeadingU8") as u8,
                    standing: gu(c, "Standing") as u8,
                    speed_mps_u8: gu(c, "SpeedMpsU8") as u8,
                    flags: gu(c, "Flags") as u8,
                })
                .collect(),
        }),
        s2c::DEPLOYABLE_STATE => VehicleS2C::DeployableState(VehicleDeployableState {
            deployable_guid: gu(o, "DeployableGuid"),
            deployable_kind: gu(o, "DeployableKind"),
            pallet_size: gu(o, "PalletSize") as u8,
            online_flags: gu(o, "OnlineFlags") as u8,
            ammo_remaining: gu(o, "AmmoRemaining") as u16,
            owner_guid: gu(o, "OwnerGuid"),
            parent_vehicle: gu(o, "ParentVehicle"),
            cell: gu(o, "Cell"),
            position: gv3(o, "Position"),
            heading: gf(o, "Heading"),
            power_watts: gf(o, "PowerWatts"),
            energy_stored_joules: gf(o, "EnergyStoredJoules"),
            energy_capacity_joules: gf(o, "EnergyCapacityJoules"),
            fuel_remaining: gf(o, "FuelRemaining"),
            pitch_rad: gf(o, "PitchRad"),
            yaw_rad: gf(o, "YawRad"),
            roll_rad: gf(o, "RollRad"),
            elevation_m: gf(o, "ElevationM"),
        }),
        s2c::DEPLOYABLE_FIRE => VehicleS2C::DeployableFire(VehicleDeployableFire {
            deployable_guid: gu(o, "DeployableGuid"),
            weapon_kind: gu(o, "WeaponKind"),
            step: gu(o, "Step"),
            target_guid: gu(o, "TargetGuid"),
            cell: gu(o, "Cell"),
            muzzle: gv3(o, "Muzzle"),
            target_pos: gv3(o, "TargetPos"),
            velocity: gv3(o, "Velocity"),
            energy_joules: gf(o, "EnergyJoules"),
            burst_count: gu(o, "BurstCount") as u16,
            reserved: gu(o, "Reserved") as u16,
        }),
        s2c::GROUND_CONTACTS => VehicleS2C::GroundContacts(VehicleGroundContacts {
            radar_guid: gu(o, "RadarGuid"),
            parent_vehicle: gu(o, "ParentVehicle"),
            radar_x: gf(o, "RadarX"),
            radar_y: gf(o, "RadarY"),
            radar_z: gf(o, "RadarZ"),
            range_m: gf(o, "RangeM"),
            sweep_angle_rad: gf(o, "SweepAngleRad"),
            contacts: o["Contacts"]
                .as_array()
                .unwrap()
                .iter()
                .map(|c| GroundContactWire {
                    target_guid: gu(c, "TargetGuid"),
                    dx_m: gf(c, "DxM"),
                    dy_m: gf(c, "DyM"),
                    dz_m: gf(c, "DzM"),
                    kind: gu(c, "Kind") as u8,
                    standing: gu(c, "Standing") as u8,
                    heading_u8: gu(c, "HeadingU8") as u8,
                    speed_mps_u8: gu(c, "SpeedMpsU8") as u8,
                    flags: gu(c, "Flags") as u8,
                    reserved0: gu(c, "Reserved0") as u8,
                    reserved1: gu(c, "Reserved1") as u8,
                    reserved2: gu(c, "Reserved2") as u8,
                })
                .collect(),
        }),
        s2c::CONTAINER_STATE => VehicleS2C::ContainerState(VehicleContainerState {
            container_guid: gu(o, "ContainerGuid"),
            container_kind: gu(o, "ContainerKind"),
            door_state: gu(o, "DoorState") as u8,
            livery_id: gu(o, "LiveryId") as u8,
            max_full_slots: gu(o, "MaxFullSlots") as u8,
            flags: gu(o, "Flags") as u8,
            owner_guid: gu(o, "OwnerGuid"),
            cell: gu(o, "Cell"),
            position: gv3(o, "Position"),
            heading: gf(o, "Heading"),
            door_progress: gf(o, "DoorProgress"),
            serial_number: gu(o, "SerialNumber"),
            slots: o["Slots"]
                .as_array()
                .unwrap()
                .iter()
                .map(|s| ContainerSlotWire {
                    slot_index: gu(s, "SlotIndex") as u8,
                    pallet_size: gu(s, "PalletSize") as u8,
                    sub_slot: gu(s, "SubSlot") as u8,
                    reserved: gu(s, "Reserved") as u8,
                    cargo_wcid: gu(s, "CargoWcid"),
                })
                .collect(),
        }),
        s2c::TRAILER_STATE => VehicleS2C::TrailerState(VehicleTrailerState {
            trailer_guid: gu(o, "TrailerGuid"),
            kind: gu(o, "Kind"),
            cell: gu(o, "Cell"),
            position: gv3(o, "Position"),
            heading: gf(o, "Heading"),
            pitch: gf(o, "Pitch"),
            bank: gf(o, "Bank"),
            coupled_tractor_guid: gu(o, "CoupledTractorGuid"),
            mounted_container_guid: gu(o, "MountedContainerGuid"),
            container_slot: gu(o, "ContainerSlot") as u8,
            trailer_flags: gu(o, "TrailerFlags") as u8,
            reserved: gu(o, "Reserved") as u16,
            owner_guid: gu(o, "OwnerGuid"),
            sidelift_phase: o.get("SideliftPhase").and_then(|v| v.as_u64()).unwrap_or(0) as u8,
            sidelift_side: o.get("SideliftSide").and_then(|v| v.as_i64()).unwrap_or(1) as i8,
            sidelift_flags: o.get("SideliftFlags").and_then(|v| v.as_u64()).unwrap_or(0) as u8,
            reserved7: o.get("Reserved7").and_then(|v| v.as_u64()).unwrap_or(0) as u8,
            sidelift_progress: o.get("SideliftProgress").and_then(|v| v.as_f64()).unwrap_or(0.0) as f32,
            outrigger_progress: o.get("OutriggerProgress").and_then(|v| v.as_f64()).unwrap_or(0.0) as f32,
            crane_span_y: o.get("CraneSpanY").and_then(|v| v.as_f64()).unwrap_or(5.9925) as f32,
            stowed_pallet_jack_guid: o.get("StowedPalletJackGuid").and_then(|v| v.as_u64()).unwrap_or(0) as u32,
            transfer_container_guid: o.get("TransferContainerGuid").and_then(|v| v.as_u64()).unwrap_or(0) as u32,
        }),
        s2c::PALLET_JACK_STATE => VehicleS2C::PalletJackState(VehiclePalletJackState {
            pallet_jack_guid: gu(o, "PalletJackGuid"),
            operator_guid: gu(o, "OperatorGuid"),
            stowed_on_trailer_guid: gu(o, "StowedOnTrailerGuid"),
            cell: gu(o, "Cell"),
            position: gv3(o, "Position"),
            heading: gf(o, "Heading"),
            tiller_angle: gf(o, "TillerAngle"),
            fork_height_m: gf(o, "ForkHeightM"),
            fork_state: gu(o, "ForkState") as u8,
            carried_pallet_size: gu(o, "CarriedPalletSize") as u8,
            flags: gu(o, "Flags") as u8,
            reserved: gu(o, "Reserved") as u8,
            carried_wcid: gu(o, "CarriedWcid"),
            owner_guid: gu(o, "OwnerGuid"),
        }),
        s2c::ECONOMY_TOWN_STATE => VehicleS2C::EconomyTownState(EconomyTownState {
            town_id: gu(o, "TownId"),
            control_state: gu(o, "ControlState") as u8,
            owner_monarch_id: gu(o, "OwnerMonarchId"),
            attacker_monarch_id: gu(o, "AttackerMonarchId"),
            flags: gu(o, "Flags") as u8,
            reserved: gu(o, "Reserved") as u16,
            anchor_landblock: gu(o, "AnchorLandblock"),
            hold_elapsed_sec: gu(o, "HoldElapsedSec"),
            supply_meter_sec: gu(o, "SupplyMeterSec"),
            starving_sec: gu(o, "StarvingSec"),
            treasury_pyreals: gu64(o, "TreasuryPyreals"),
            escrow_pyreals: gu64(o, "EscrowPyreals"),
            tariff_buy_mul: gf(o, "TariffBuyMul"),
            tariff_sell_mul: gf(o, "TariffSellMul"),
        }),
        s2c::ECONOMY_SIEGE_EVENT => VehicleS2C::EconomySiegeEvent(EconomySiegeEvent {
            town_id: gu(o, "TownId"),
            kind: gu(o, "Kind") as u8,
            control_state: gu(o, "ControlState") as u8,
            reserved: gu(o, "Reserved") as u16,
            owner_monarch_id: gu(o, "OwnerMonarchId"),
            attacker_monarch_id: gu(o, "AttackerMonarchId"),
            hold_elapsed_sec: gu(o, "HoldElapsedSec"),
            supply_meter_sec: gu(o, "SupplyMeterSec"),
            starving_sec: gu(o, "StarvingSec"),
            treasury_spoils: gu64(o, "TreasurySpoils"),
        }),
        s2c::INDUSTRY_SURVEY_RESULT => VehicleS2C::IndustrySurveyResult(IndustrySurveyResult {
            deposit_id: gu64(o, "DepositId"),
            landblock_id: gu(o, "LandblockId"),
            tool_kind: gu(o, "ToolKind"),
            flags: gu(o, "Flags") as u8,
            terrain_code: gu(o, "TerrainCode") as u8,
            resource_kind: gu(o, "ResourceKind") as u8,
            reserved: gu(o, "Reserved") as u8,
            depth_m: gf(o, "DepthM"),
            grade_bps: gu(o, "GradeBps"),
            api_gravity: gf(o, "ApiGravity"),
            sulfur_bps: gu(o, "SulfurBps"),
            remaining_tonnes: gf(o, "RemainingTonnes"),
        }),
        s2c::INDUSTRY_FACILITY_STATE => VehicleS2C::IndustryFacilityState(IndustryFacilityState {
            facility_guid: gu(o, "FacilityGuid"),
            kind: gu(o, "Kind"),
            town_id: gu(o, "TownId"),
            deposit_id: gu64(o, "DepositId"),
            owner_monarch_id: gu(o, "OwnerMonarchId"),
            status: gu(o, "Status") as u8,
            online_flags: gu(o, "OnlineFlags") as u8,
            reserved: gu(o, "Reserved") as u16,
            power_watts: gf(o, "PowerWatts"),
            buffer_joules: gf(o, "BufferJoules"),
            progress_pct: gf(o, "ProgressPct"),
            recipe_id: gu(o, "RecipeId"),
        }),
        s2c::LOGISTICS_CONVOY_STATE => VehicleS2C::LogisticsConvoyState(LogisticsConvoyState {
            convoy_id: gu64(o, "ConvoyId"),
            owner_monarch_id: gu(o, "OwnerMonarchId"),
            vehicle_guid: gu(o, "VehicleGuid"),
            vehicle_class: gu(o, "VehicleClass") as u8,
            lod_state: gu(o, "LodState") as u8,
            status: gu(o, "Status") as u8,
            reserved: gu(o, "Reserved") as u8,
            origin_town_id: gu(o, "OriginTownId"),
            dest_town_id: gu(o, "DestTownId"),
            origin_landblock: gu(o, "OriginLandblock"),
            spline_s_m: gf(o, "SplineSM"),
            fuel_liters: gf(o, "FuelLiters"),
            cell: gu(o, "Cell"),
            position: gv3(o, "Position"),
            heading: gf(o, "Heading"),
        }),
        s2c::ECONOMY_MONARCH_ORDER_STATE => VehicleS2C::EconomyMonarchOrderState(EconomyMonarchOrderState {
            order_id: gu64(o, "OrderId"),
            monarch_id: gu(o, "MonarchId"),
            town_id: gu(o, "TownId"),
            order_type: gu(o, "OrderType") as u8,
            status: gu(o, "Status") as u8,
            flags: gu(o, "Flags") as u16,
            claimed_by_guid: gu(o, "ClaimedByGuid"),
            item_wcid: gu(o, "ItemWcid"),
            quantity: gu(o, "Quantity"),
            reward_pyreals: gu64(o, "RewardPyreals"),
            value_f32: gf(o, "ValueF32"),
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
    assert!(fixtures.len() >= 24, "fixture file shrank");
    let (mut checked, mut legacy, mut future) = (0, 0, 0);
    for fx in fixtures {
        let name = fx["name"].as_str().unwrap();
        let opcode = fx["opcode"].as_u64().unwrap() as u32;
        let version = fx["version"].as_u64().unwrap() as u16;
        let bytes = hex::decode(fx["hex"].as_str().unwrap()).unwrap();
        let reject = fx["expect"].as_str() == Some("reject");
        // what this (v3) writer emits for the fixture's fields: the payload itself for a current-version
        // fixture, else the generator's repack (v1/v2 → v3 header + the v3 fields at their defaults; a future
        // version → v3 header, its trailing bytes dropped)
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
    assert!(legacy >= 7, "legacy payloads parse ({legacy})");
    assert!(future >= 1, "a future-version payload");
}

#[test]
fn hbv1_v1_and_v2_payloads_default_the_v3_fields() {
    let VehicleS2C::Profile(p) = unpack_s2c(s2c::PROFILE, &fixture_bytes("vehicle_profile_hellcat_v2")) else {
        panic!("profile v2")
    };
    assert_eq!(p.wheelbase, 0.0);
    assert_eq!(p.cargo_wcid, 0);

    let VehicleS2C::State(s) = unpack_s2c(s2c::STATE, &fixture_bytes("vehicle_state_pilot_v2")) else {
        panic!("state v2")
    };
    assert_eq!(s.steer_angle, 0.0);
    assert_eq!(s.ground_flags, 0);
    assert_eq!(s.surface_family, 0);
    assert_eq!(s.wheel_spin_q16, 0);

    let VehicleS2C::State(s3) = unpack_s2c(s2c::STATE, &fixture_bytes("vehicle_state_pilot_v3")) else {
        panic!("state v3")
    };
    assert_eq!(s3.cargo_mask, 0);
    assert_eq!(s3.pallet_size0, 0);
    assert_eq!(s3.pallet_size1, 0);
    assert_eq!(s3.cargo_slot0_wcid, 0);
    assert_eq!(s3.cargo_slot1_wcid, 0);
}

#[test]
fn hbv1_v3_fields_and_enums() {
    let VehicleS2C::Profile(p) = unpack_s2c(s2c::PROFILE, &fixture_bytes("vehicle_profile_jeep")) else {
        panic!("profile jeep")
    };
    assert_eq!(p.locomotion, locomotion::GROUND);
    assert_eq!(p.wheelbase, 2.04);
    assert_eq!(p.track_width, 1.48);
    assert_eq!(p.wheel_radius, 0.38);
    assert_eq!(p.cargo_wcid, 4000002);
    assert_eq!(p.seats.len(), 4);
    assert_eq!(p.part_roles, vec![part_role::WHEEL_FL, part_role::WHEEL_FR, part_role::WHEEL_RL, part_role::WHEEL_RR]);

    let VehicleS2C::State(s) = unpack_s2c(s2c::STATE, &fixture_bytes("vehicle_state_driving")) else {
        panic!("state driving")
    };
    assert_eq!(s.mode, mode::DRIVING);
    assert_eq!(s.steer_angle, 0.15);
    assert_eq!(s.ground_flags, 5);
    assert_eq!(s.surface_family, 2);
    assert_eq!(s.wheel_spin_q16, 1200);

    let VehicleS2C::RadarContacts(rc) = unpack_s2c(s2c::RADAR_CONTACTS, &fixture_bytes("vehicle_radar_contacts")) else {
        panic!("radar contacts")
    };
    assert_eq!(rc.radar_guid, 1342177300);
    assert_eq!(rc.contacts.len(), 2);
    assert_eq!(rc.contacts[0].standing, iff_standing::FRIENDLY);
    assert_eq!(rc.contacts[1].standing, iff_standing::HOSTILE);

    let mut off = 0;
    let Some(VehicleC2S::Cargo { vehicle, action, target, slot, cargo_wcid, .. }) =
        VehicleC2S::unpack_payload(c2s::CARGO, &fixture_bytes("vehicle_cargo_deploy"), &mut off)
    else {
        panic!("cargo")
    };
    assert_eq!(vehicle, 2147486210);
    assert_eq!(action, 1);
    assert_eq!(target, 0);
    assert_eq!(slot, 0);
    assert_eq!(cargo_wcid, 4000002);
}

#[test]
fn hbv1_v4_fields_and_enums() {
    let VehicleS2C::DeployableState(ds) = unpack_s2c(s2c::DEPLOYABLE_STATE, &fixture_bytes("vehicle_deployable_state")) else {
        panic!("deployable state")
    };
    assert_eq!(ds.deployable_guid, 1342177300);
    assert_eq!(ds.deployable_kind, deployable_kind::FLUX_POD);
    assert_eq!(ds.pallet_size, pallet_size::FULL);
    assert_eq!(ds.online_flags, 7);
    assert_eq!(ds.power_watts, 45000.0);
    assert_eq!(ds.energy_stored_joules, 300000.0);
    assert_eq!(ds.energy_capacity_joules, 600000.0);

    let VehicleS2C::DeployableFire(df) = unpack_s2c(s2c::DEPLOYABLE_FIRE, &fixture_bytes("vehicle_deployable_fire")) else {
        panic!("deployable fire")
    };
    assert_eq!(df.deployable_guid, 1342177301);
    assert_eq!(df.weapon_kind, deployable_weapon_kind::LASER);
    assert_eq!(df.energy_joules, 120000.0);

    let VehicleS2C::GroundContacts(gc) = unpack_s2c(s2c::GROUND_CONTACTS, &fixture_bytes("vehicle_ground_contacts")) else {
        panic!("ground contacts")
    };
    assert_eq!(gc.radar_guid, 1342177302);
    assert_eq!(gc.range_m, 600.0);
    assert_eq!(gc.contacts.len(), 2);
    assert_eq!(gc.contacts[0].kind, ground_contact_kind::PLAYER);
    assert_eq!(gc.contacts[0].standing, iff_standing::FRIENDLY);
    assert_eq!(gc.contacts[1].kind, ground_contact_kind::VEHICLE);
    assert_eq!(gc.contacts[1].standing, iff_standing::HOSTILE);

    let mut off = 0;
    let Some(VehicleC2S::Cargo { vehicle, action, target, slot, cargo_wcid, .. }) =
        VehicleC2S::unpack_payload(c2s::CARGO, &fixture_bytes("vehicle_cargo_deploy_slot1"), &mut off)
    else {
        panic!("cargo slot 1")
    };
    assert_eq!(vehicle, 2147486210);
    assert_eq!(action, 1);
    assert_eq!(target, 0);
    assert_eq!(slot, 1);
    assert_eq!(cargo_wcid, 4000015);
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
    // v3 ground tail (32B) + v6 trailer tail (12B) follow weapon_ext
    const V3_GROUND_TAIL: usize = 32;
    const V6_TRAILER_TAIL: usize = 12;
    let ext_count_at = bytes.len() - V3_GROUND_TAIL - V6_TRAILER_TAIL - (4 + VehicleWeaponExt::WIRE * exts);
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
fn hbv1_truncated_v3_tail_and_hostile_v3_counts_rejected() {
    // a v3 payload cut inside its v3 tail is truncated
    for (name, opcode) in [
        ("vehicle_state_driving", s2c::STATE),
        ("vehicle_profile_jeep", s2c::PROFILE),
        ("vehicle_radar_contacts", s2c::RADAR_CONTACTS),
    ] {
        let bytes = fixture_bytes(name);
        for cut in [bytes.len() - 1, bytes.len() - 4] {
            let mut off = 0;
            assert!(VehicleS2C::unpack_payload(opcode, &bytes[..cut], &mut off).is_none(), "{name} cut {cut}");
            assert_eq!(off, 0, "{name}: offset restored");
        }
    }
    // C2S cargo
    let bytes = fixture_bytes("vehicle_cargo_deploy");
    for cut in [bytes.len() - 1, bytes.len() - 4] {
        let mut off = 0;
        assert!(VehicleC2S::unpack_payload(c2s::CARGO, &bytes[..cut], &mut off).is_none());
        assert_eq!(off, 0);
    }
    // hostile ContactCount cannot allocate past the payload
    let fx = fixture("vehicle_radar_contacts");
    let contacts = gu(&fx["fields"], "ContactCount") as usize;
    let bytes = fixture_bytes("vehicle_radar_contacts");
    let contact_count_at = bytes.len() - (4 + RadarContactWire::WIRE * contacts);
    let mut evil = bytes.clone();
    evil[contact_count_at..contact_count_at + 4].copy_from_slice(&u32::MAX.to_le_bytes());
    let mut off = 0;
    assert!(VehicleS2C::unpack_payload(s2c::RADAR_CONTACTS, &evil, &mut off).is_none(), "hostile count at {contact_count_at}");
    assert_eq!(off, 0);
}

#[test]
fn hbv1_truncated_v4_tail_and_hostile_v4_counts_rejected() {
    for (name, opcode) in [
        ("vehicle_deployable_state", s2c::DEPLOYABLE_STATE),
        ("vehicle_deployable_fire", s2c::DEPLOYABLE_FIRE),
        ("vehicle_ground_contacts", s2c::GROUND_CONTACTS),
    ] {
        let bytes = fixture_bytes(name);
        for cut in [bytes.len() - 1, bytes.len() - 4] {
            let mut off = 0;
            assert!(VehicleS2C::unpack_payload(opcode, &bytes[..cut], &mut off).is_none(), "{name} cut {cut}");
            assert_eq!(off, 0, "{name}: offset restored");
        }
    }
    // hostile GroundContact count cannot allocate past the payload
    let fx = fixture("vehicle_ground_contacts");
    let contacts = gu(&fx["fields"], "ContactCount") as usize;
    let bytes = fixture_bytes("vehicle_ground_contacts");
    let contact_count_at = bytes.len() - (4 + GroundContactWire::WIRE * contacts);
    let mut evil = bytes.clone();
    evil[contact_count_at..contact_count_at + 4].copy_from_slice(&u32::MAX.to_le_bytes());
    let mut off = 0;
    assert!(VehicleS2C::unpack_payload(s2c::GROUND_CONTACTS, &evil, &mut off).is_none(), "hostile count at {contact_count_at}");
    assert_eq!(off, 0);
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

#[test]
fn hbv1_v6_fields_and_enums() {
    assert!(HBV1_VERSION >= 6);
    assert_eq!(deployable_kind::TRAILER_CHASSIS_20, 13);
    assert_eq!(deployable_kind::TRAILER_CHASSIS_40, 14);
    assert_eq!(event_kind::TRAILER_HITCHED, 19);
    assert_eq!(event_kind::TRAILER_UNHITCHED, 20);
    assert_eq!(event_kind::TWISTLOCK_TOGGLED, 21);
    assert_eq!(trailer_action_kind::NONE, 0);
    assert_eq!(trailer_action_kind::HITCH, 1);
    assert_eq!(trailer_action_kind::UNHITCH, 2);
    assert_eq!(trailer_action_kind::TOGGLE_TWISTLOCK, 3);
    assert_eq!(trailer_action_kind::MOUNT_CONTAINER, 4);
    assert_eq!(trailer_action_kind::UNMOUNT_CONTAINER, 5);
    assert_eq!(trailer_flags::COUPLED, 0x01);
    assert_eq!(trailer_flags::TWISTLOCKS_LOCKED, 0x02);
    assert_eq!(trailer_flags::GEAR_RETRACTED, 0x04);
    assert_eq!(trailer_flags::BRAKE_LIGHTS, 0x08);

    let VehicleS2C::Profile(p) = unpack_s2c(s2c::PROFILE, &fixture_bytes("vehicle_profile_semi")) else {
        panic!("profile semi")
    };
    assert_eq!(p.profile_key, "semi-379");
    assert_eq!(p.locomotion, locomotion::GROUND);
    assert_eq!(p.fifth_wheel_offset_y, -2.01);
    assert_eq!(p.fifth_wheel_offset_z, 0.96);
    assert_eq!(p.livery_id, 1);
    assert_eq!(p.vehicle_class, 3);
    assert_eq!(p.reserved4, 0);

    let state_bytes = fixture_bytes("vehicle_state_coupled");
    assert_eq!(state_bytes.len(), 100);
    let VehicleS2C::State(s) = unpack_s2c(s2c::STATE, &state_bytes) else {
        panic!("state coupled")
    };
    assert_eq!(s.hitched_trailer_guid, 1342177500);
    assert_eq!(s.trailer_heading, 1.62);
    assert_eq!(s.trailer_pitch, 0.015);
    assert_eq!(s.trailer_flags, 7);

    let ta_bytes = fixture_bytes("vehicle_trailer_action");
    assert_eq!(ta_bytes.len(), 24);
    let mut off = 0;
    let Some(VehicleC2S::TrailerAction(ta)) =
        VehicleC2S::unpack_payload(c2s::TRAILER_ACTION, &ta_bytes, &mut off)
    else {
        panic!("trailer action")
    };
    assert_eq!(off, ta_bytes.len());
    assert_eq!(ta.trailer_guid, 1342177500);
    assert_eq!(ta.vehicle_guid, 2147486211);
    assert_eq!(ta.container_guid, 1342177400);
    assert_eq!(ta.action, trailer_action_kind::MOUNT_CONTAINER);
    assert_eq!(ta.slot, 1);

    let ts_bytes = fixture_bytes("vehicle_trailer_state");
    assert_eq!(ts_bytes.len(), 84);
    let VehicleS2C::TrailerState(ts) = unpack_s2c(s2c::TRAILER_STATE, &ts_bytes) else {
        panic!("trailer state")
    };
    assert_eq!(ts.trailer_guid, 1342177500);
    assert_eq!(ts.kind, deployable_kind::TRAILER_CHASSIS_40);
    assert_eq!(ts.coupled_tractor_guid, 2147486211);
    assert_eq!(ts.mounted_container_guid, 1342177400);
    assert_eq!(ts.container_slot, 1);
    assert_eq!(ts.trailer_flags, 7);
    assert_eq!(ts.owner_guid, 1342177281);
}

#[test]
fn hbv1_v5_payloads_default_v6_fields() {
    let fx_p = fixture("vehicle_profile_jeep_v5");
    let bytes_p = hex::decode(fx_p["hex"].as_str().unwrap()).unwrap();
    let VehicleS2C::Profile(p) = unpack_s2c(s2c::PROFILE, &bytes_p) else {
        panic!("profile jeep v5")
    };
    assert_eq!(p.fifth_wheel_offset_y, 0.0);
    assert_eq!(p.fifth_wheel_offset_z, 0.0);
    assert_eq!(p.livery_id, 0);
    assert_eq!(p.vehicle_class, 0);
    assert_eq!(p.reserved4, 0);
    let mut repacked_p = Vec::new();
    VehicleS2C::Profile(p).pack_payload(&mut repacked_p);
    assert_eq!(repacked_p.len(), bytes_p.len() + 12);
    assert_eq!(hex::encode(&repacked_p), fx_p["repack_hex"].as_str().unwrap());

    let fx_s = fixture("vehicle_state_driving_v5");
    let bytes_s = hex::decode(fx_s["hex"].as_str().unwrap()).unwrap();
    assert_eq!(bytes_s.len(), 84);
    let VehicleS2C::State(s) = unpack_s2c(s2c::STATE, &bytes_s) else {
        panic!("state driving v5")
    };
    assert_eq!(s.hitched_trailer_guid, 0);
    assert_eq!(s.trailer_heading, 0.0);
    assert_eq!(s.trailer_pitch, 0.0);
    assert_eq!(s.trailer_flags, 0);
    assert_eq!(s.reserved4, 0);
    assert_eq!(s.reserved5, 0);
    let mut repacked_s = Vec::new();
    VehicleS2C::State(s).pack_payload(&mut repacked_s);
    assert_eq!(repacked_s.len(), 100);
    assert_eq!(hex::encode(&repacked_s), fx_s["repack_hex"].as_str().unwrap());
}

#[test]
fn hbv1_v8_future_version_extra_bytes() {
    let fx = fixture("future_version_extra_bytes");
    assert_eq!(fx["version"].as_u64(), Some(9));
    let bytes = hex::decode(fx["hex"].as_str().unwrap()).unwrap();
    assert_eq!(bytes.len(), 104);
    let VehicleS2C::State(s) = unpack_s2c(s2c::STATE, &bytes) else {
        panic!("future state")
    };
    let mut buf = Vec::new();
    VehicleS2C::State(s).pack_payload(&mut buf);
    assert_eq!(buf.len(), 100);
    assert_eq!(hex::encode(&buf), fx["repack_hex"].as_str().unwrap());

    // Synthetic v9 TrailerAction & TrailerState with trailing bytes skip cleanly
    let mut ta_v9 = fixture_bytes("vehicle_trailer_action");
    ta_v9[4..6].copy_from_slice(&9u16.to_le_bytes());
    ta_v9.extend_from_slice(&[0xDE, 0xAD, 0xBE, 0xEF]);
    let mut off = 0;
    let ta = VehicleC2S::unpack_payload(c2s::TRAILER_ACTION, &ta_v9, &mut off).expect("v9 trailer action");
    assert_eq!(off, ta_v9.len());
    assert!(matches!(ta, VehicleC2S::TrailerAction(_)));

    let mut ts_v9 = fixture_bytes("vehicle_trailer_state");
    ts_v9[4..6].copy_from_slice(&9u16.to_le_bytes());
    ts_v9.extend_from_slice(&[0xCA, 0xFE, 0xBA, 0xBE]);
    let mut off = 0;
    let ts = VehicleS2C::unpack_payload(s2c::TRAILER_STATE, &ts_v9, &mut off).expect("v9 trailer state");
    assert_eq!(off, ts_v9.len());
    assert!(matches!(ts, VehicleS2C::TrailerState(_)));

    // Synthetic v9 PalletJackAction & PalletJackState with trailing bytes skip cleanly
    let mut pja_v9 = fixture_bytes("vehicle_pallet_jack_action");
    pja_v9[4..6].copy_from_slice(&9u16.to_le_bytes());
    pja_v9.extend_from_slice(&[0x12, 0x34, 0x56, 0x78]);
    let mut off = 0;
    let pja = VehicleC2S::unpack_payload(c2s::PALLET_JACK_ACTION, &pja_v9, &mut off).expect("v9 pallet jack action");
    assert_eq!(off, pja_v9.len());
    assert!(matches!(pja, VehicleC2S::PalletJackAction(_)));

    let mut pjs_v9 = fixture_bytes("vehicle_pallet_jack_state");
    pjs_v9[4..6].copy_from_slice(&9u16.to_le_bytes());
    pjs_v9.extend_from_slice(&[0xAB, 0xCD, 0xEF, 0x01]);
    let mut off = 0;
    let pjs = VehicleS2C::unpack_payload(s2c::PALLET_JACK_STATE, &pjs_v9, &mut off).expect("v9 pallet jack state");
    assert_eq!(off, pjs_v9.len());
    assert!(matches!(pjs, VehicleS2C::PalletJackState(_)));
}

#[test]
fn hbv1_truncated_v6_and_trailer_rejected() {
    let prof = fixture_bytes("vehicle_profile_semi");
    for cut in [prof.len() - 1, prof.len() - 4, prof.len() - 11] {
        let mut off = 0;
        assert!(VehicleS2C::unpack_payload(s2c::PROFILE, &prof[..cut], &mut off).is_none());
        assert_eq!(off, 0);
    }

    let st = fixture_bytes("vehicle_state_coupled");
    for cut in [st.len() - 1, st.len() - 4, st.len() - 15] {
        let mut off = 0;
        assert!(VehicleS2C::unpack_payload(s2c::STATE, &st[..cut], &mut off).is_none());
        assert_eq!(off, 0);
    }

    let ta = fixture_bytes("vehicle_trailer_action");
    for cut in [ta.len() - 1, ta.len() - 4, 8, 4, 0] {
        let mut off = 0;
        assert!(VehicleC2S::unpack_payload(c2s::TRAILER_ACTION, &ta[..cut], &mut off).is_none());
        assert_eq!(off, 0);
    }
    let mut ta_bad_tag = ta.clone();
    ta_bad_tag[0] ^= 0xFF;
    let mut off = 0;
    assert!(VehicleC2S::unpack_payload(c2s::TRAILER_ACTION, &ta_bad_tag, &mut off).is_none());
    assert_eq!(off, 0);
    let mut ta_v0 = ta.clone();
    ta_v0[4..6].copy_from_slice(&0u16.to_le_bytes());
    let mut off = 0;
    assert!(VehicleC2S::unpack_payload(c2s::TRAILER_ACTION, &ta_v0, &mut off).is_none());
    assert_eq!(off, 0);

    let ts = fixture_bytes("vehicle_trailer_state");
    for cut in [ts.len() - 1, ts.len() - 4, 12, 8, 0] {
        let mut off = 0;
        assert!(VehicleS2C::unpack_payload(s2c::TRAILER_STATE, &ts[..cut], &mut off).is_none());
        assert_eq!(off, 0);
    }
    let mut ts_bad_tag = ts.clone();
    ts_bad_tag[0] ^= 0xFF;
    let mut off = 0;
    assert!(VehicleS2C::unpack_payload(s2c::TRAILER_STATE, &ts_bad_tag, &mut off).is_none());
    assert_eq!(off, 0);
    let mut ts_v0 = ts.clone();
    ts_v0[4..6].copy_from_slice(&0u16.to_le_bytes());
    let mut off = 0;
    assert!(VehicleS2C::unpack_payload(s2c::TRAILER_STATE, &ts_v0, &mut off).is_none());
    assert_eq!(off, 0);
}

#[test]
fn hbv1_trailer_0x090f_routes_through_game_message() {
    use crate::messages::{GameActionMessage, GameEventMessage};
    use holtburger_common::Guid;

    let ta = VehicleTrailerAction {
        trailer_guid: 1342177500,
        vehicle_guid: 2147486211,
        container_guid: 1342177400,
        action: trailer_action_kind::MOUNT_CONTAINER,
        slot: 1,
        flags: 0,
    };
    let ga = GameMessage::GameAction(Box::new(GameActionMessage {
        sequence: 77,
        action: GameAction::Vehicle(Box::new(VehicleC2S::TrailerAction(ta))),
    }));
    let mut ga_buf = Vec::new();
    ga.pack(&mut ga_buf);
    // 0xF7B1 (4) + seq (4) + opcode 0x090F (4) + 24B HBV1 payload = 36B
    assert_eq!(ga_buf.len(), 36);
    let mut off = 0;
    let ga_unpacked = GameMessage::unpack(&ga_buf, &mut off).expect("unpack 0x090F GameAction");
    assert_eq!(off, ga_buf.len());
    let GameMessage::GameAction(a) = ga_unpacked else {
        panic!("expected GameAction")
    };
    assert_eq!(a.sequence, 77);
    assert!(matches!(&a.action, GameAction::Vehicle(v) if **v == VehicleC2S::TrailerAction(ta)));

    let ts = VehicleTrailerState {
        trailer_guid: 1342177500,
        kind: deployable_kind::TRAILER_CHASSIS_40,
        cell: 2847146009,
        position: [84.5, 112.25, 12.0],
        heading: 1.62,
        pitch: 0.015,
        bank: -0.005,
        coupled_tractor_guid: 2147486211,
        mounted_container_guid: 1342177400,
        container_slot: 1,
        trailer_flags: 7,
        reserved: 0,
        owner_guid: 1342177281,
        sidelift_phase: 0,
        sidelift_side: 1,
        sidelift_flags: 0,
        reserved7: 0,
        sidelift_progress: 0.0,
        outrigger_progress: 0.0,
        crane_span_y: 5.9925,
        stowed_pallet_jack_guid: 0,
        transfer_container_guid: 0,
    };
    let ge = GameMessage::GameEvent(Box::new(GameEventMessage {
        target: Guid(1342177281),
        sequence: 88,
        event: GameEvent::Vehicle(Box::new(VehicleS2C::TrailerState(ts))),
    }));
    let mut ge_buf = Vec::new();
    ge.pack(&mut ge_buf);
    // 0xF7B0 (4) + target (4) + seq (4) + opcode 0x090F (4) + 84B HBV1 payload = 100B
    assert_eq!(ge_buf.len(), 100);
    let mut off = 0;
    let ge_unpacked = GameMessage::unpack(&ge_buf, &mut off).expect("unpack 0x090F GameEvent");
    assert_eq!(off, ge_buf.len());
    let GameMessage::GameEvent(e) = ge_unpacked else {
        panic!("expected GameEvent")
    };
    assert_eq!(e.target, Guid(1342177281));
    assert_eq!(e.sequence, 88);
    assert!(matches!(&e.event, GameEvent::Vehicle(v) if **v == VehicleS2C::TrailerState(ts)));

    // Bad-tag 0x090F event unpacks as GameEvent::Unknown(0x090F, _)
    let mut bad = hex::decode("b0f7000001000050010000000f090000").unwrap();
    bad.extend_from_slice(b"XXXXjunkjunk");
    let mut off = 0;
    let bad_msg = GameMessage::unpack(&bad, &mut off).expect("bad tag 0x090F frame still parses");
    let GameMessage::GameEvent(e) = bad_msg else {
        panic!("expected event")
    };
    assert!(matches!(e.event, GameEvent::Unknown(0x090F, _)), "{:?}", e.event);
}

#[test]
fn hbv1_v7_fields_and_enums() {
    assert!(HBV1_VERSION >= 7);
    assert_eq!(deployable_kind::TRAILER_SIDELIFTER_40, 15);
    assert_eq!(deployable_kind::PALLET_JACK, 16);
    assert_eq!(event_kind::SIDELIFT_STARTED, 22);
    assert_eq!(event_kind::SIDELIFT_COMPLETE, 23);
    assert_eq!(event_kind::SIDELIFT_REFUSED, 24);
    assert_eq!(event_kind::PALLET_JACK_EVENT, 25);
    assert_eq!(trailer_action_kind::DEPLOY_OUTRIGGERS, 6);
    assert_eq!(trailer_action_kind::AUTO_LOAD, 14);
    assert_eq!(sidelift_phase::IDLE, 0);
    assert_eq!(sidelift_phase::SWINGING, 6);
    assert_eq!(sidelift_phase::OUTRIGGERS_RETRACTING, 10);
    assert_eq!(sidelift_flags::IS_SIDELIFTER, 0x01);
    assert_eq!(sidelift_flags::IS_LOAD_DIRECTION, 0x10);
    assert_eq!(pallet_jack_action_kind::GRAB, 1);
    assert_eq!(pallet_jack_action_kind::TOGGLE_DEPLOYABLE_STOW, 10);
    assert_eq!(pallet_jack_flags::CARRYING, 0x01);
    assert_eq!(pallet_jack_flags::ON_CONTAINER_RAMP_OR_FLOOR, 0x02);
    assert_eq!(pallet_jack_flags::STOWED, 0x04);
    assert_eq!(online_flags::STOWED, 0x10);

    let sl_bytes = fixture_bytes("vehicle_trailer_state_sidelifter");
    assert_eq!(sl_bytes.len(), 84);
    let VehicleS2C::TrailerState(sl) = unpack_s2c(s2c::TRAILER_STATE, &sl_bytes) else {
        panic!("sidelifter trailer state")
    };
    assert_eq!(sl.kind, deployable_kind::TRAILER_SIDELIFTER_40);
    assert_eq!(sl.sidelift_phase, sidelift_phase::SWINGING);
    assert_eq!(sl.sidelift_side, -1);
    assert_eq!(sl.sidelift_flags, 15);
    assert_eq!(sl.sidelift_progress, 0.5);
    assert_eq!(sl.outrigger_progress, 1.0);
    assert_eq!(sl.crane_span_y, 2.9265);
    assert_eq!(sl.stowed_pallet_jack_guid, 1342177600);
    assert_eq!(sl.transfer_container_guid, 1342177400);

    let pja_bytes = fixture_bytes("vehicle_pallet_jack_action");
    assert_eq!(pja_bytes.len(), 44);
    let mut off = 0;
    let Some(VehicleC2S::PalletJackAction(pja)) =
        VehicleC2S::unpack_payload(c2s::PALLET_JACK_ACTION, &pja_bytes, &mut off)
    else {
        panic!("pallet jack action")
    };
    assert_eq!(off, pja_bytes.len());
    assert_eq!(pja.pallet_jack_guid, 1342177600);
    assert_eq!(pja.action, pallet_jack_action_kind::UPDATE_POSE);
    assert_eq!(pja.slot_index, 18);
    assert_eq!(pja.sub_slot, 1);
    assert_eq!(pja.tiller_angle, -0.35);

    let pjs_bytes = fixture_bytes("vehicle_pallet_jack_state");
    assert_eq!(pjs_bytes.len(), 60);
    let VehicleS2C::PalletJackState(pjs) = unpack_s2c(s2c::PALLET_JACK_STATE, &pjs_bytes) else {
        panic!("pallet jack state")
    };
    assert_eq!(pjs.pallet_jack_guid, 1342177600);
    assert_eq!(pjs.operator_guid, 1342177281);
    assert_eq!(pjs.fork_height_m, 0.2);
    assert_eq!(pjs.fork_state, 2);
    assert_eq!(pjs.carried_pallet_size, pallet_size::FULL);
    assert_eq!(pjs.flags, 3);
    assert_eq!(pjs.carried_wcid, 4000010);
}

#[test]
fn hbv1_v6_payloads_default_v7_fields() {
    let fx = fixture("vehicle_trailer_state_v6");
    let bytes = hex::decode(fx["hex"].as_str().unwrap()).unwrap();
    assert_eq!(bytes.len(), 60);
    let VehicleS2C::TrailerState(ts) = unpack_s2c(s2c::TRAILER_STATE, &bytes) else {
        panic!("trailer state v6")
    };
    assert_eq!(ts.sidelift_phase, 0);
    assert_eq!(ts.sidelift_side, 1);
    assert_eq!(ts.sidelift_flags, 0);
    assert_eq!(ts.reserved7, 0);
    assert_eq!(ts.sidelift_progress, 0.0);
    assert_eq!(ts.outrigger_progress, 0.0);
    assert_eq!(ts.crane_span_y, 5.9925);
    assert_eq!(ts.stowed_pallet_jack_guid, 0);
    assert_eq!(ts.transfer_container_guid, 0);

    let mut repacked = Vec::new();
    VehicleS2C::TrailerState(ts).pack_payload(&mut repacked);
    assert_eq!(repacked.len(), 84);
    assert_eq!(hex::encode(&repacked), fx["repack_hex"].as_str().unwrap());
}

#[test]
fn hbv1_truncated_v7_and_pallet_jack_rejected() {
    let sl = fixture_bytes("vehicle_trailer_state_sidelifter");
    for cut in [sl.len() - 1, sl.len() - 12, sl.len() - 24, 60] {
        let mut off = 0;
        assert!(VehicleS2C::unpack_payload(s2c::TRAILER_STATE, &sl[..cut], &mut off).is_none());
        assert_eq!(off, 0);
    }

    let pja = fixture_bytes("vehicle_pallet_jack_action");
    for cut in [pja.len() - 1, pja.len() - 8, 8, 4, 0] {
        let mut off = 0;
        assert!(VehicleC2S::unpack_payload(c2s::PALLET_JACK_ACTION, &pja[..cut], &mut off).is_none());
        assert_eq!(off, 0);
    }
    let mut pja_bad = pja.clone();
    pja_bad[0] ^= 0xFF;
    let mut off = 0;
    assert!(VehicleC2S::unpack_payload(c2s::PALLET_JACK_ACTION, &pja_bad, &mut off).is_none());
    assert_eq!(off, 0);

    let pjs = fixture_bytes("vehicle_pallet_jack_state");
    for cut in [pjs.len() - 1, pjs.len() - 8, 12, 8, 0] {
        let mut off = 0;
        assert!(VehicleS2C::unpack_payload(s2c::PALLET_JACK_STATE, &pjs[..cut], &mut off).is_none());
        assert_eq!(off, 0);
    }
    let mut pjs_bad = pjs.clone();
    pjs_bad[0] ^= 0xFF;
    let mut off = 0;
    assert!(VehicleS2C::unpack_payload(s2c::PALLET_JACK_STATE, &pjs_bad, &mut off).is_none());
    assert_eq!(off, 0);
}

#[test]
fn hbv1_pallet_jack_0x0910_routes_through_game_message() {
    use crate::messages::{GameActionMessage, GameEventMessage};
    use holtburger_common::Guid;

    let pja = VehiclePalletJackAction {
        pallet_jack_guid: 1342177600,
        action: pallet_jack_action_kind::LOAD_CONTAINER_SLOT,
        slot_index: 18,
        sub_slot: 1,
        flags: 0,
        target_guid: 1342177400,
        cell: 2847146009,
        position: [94.25, 118.0, 12.162],
        heading: 1.570796,
        tiller_angle: -0.35,
    };
    let ga = GameMessage::GameAction(Box::new(GameActionMessage {
        sequence: 91,
        action: GameAction::Vehicle(Box::new(VehicleC2S::PalletJackAction(pja))),
    }));
    let mut ga_buf = Vec::new();
    ga.pack(&mut ga_buf);
    // 0xF7B1 (4) + seq (4) + opcode 0x0910 (4) + 44B HBV1 payload = 56B
    assert_eq!(ga_buf.len(), 56);
    let mut off = 0;
    let ga_unpacked = GameMessage::unpack(&ga_buf, &mut off).expect("unpack 0x0910 GameAction");
    assert_eq!(off, ga_buf.len());
    let GameMessage::GameAction(a) = ga_unpacked else {
        panic!("expected GameAction")
    };
    assert_eq!(a.sequence, 91);
    assert!(matches!(&a.action, GameAction::Vehicle(v) if **v == VehicleC2S::PalletJackAction(pja)));

    let pjs = VehiclePalletJackState {
        pallet_jack_guid: 1342177600,
        operator_guid: 1342177281,
        stowed_on_trailer_guid: 0,
        cell: 2847146009,
        position: [94.25, 118.0, 12.162],
        heading: 1.570796,
        tiller_angle: -0.35,
        fork_height_m: 0.2,
        fork_state: 2,
        carried_pallet_size: pallet_size::FULL,
        flags: 3,
        reserved: 0,
        carried_wcid: 4000010,
        owner_guid: 1342177281,
    };
    let ge = GameMessage::GameEvent(Box::new(GameEventMessage {
        target: Guid(1342177281),
        sequence: 92,
        event: GameEvent::Vehicle(Box::new(VehicleS2C::PalletJackState(pjs))),
    }));
    let mut ge_buf = Vec::new();
    ge.pack(&mut ge_buf);
    // 0xF7B0 (4) + target (4) + seq (4) + opcode 0x0910 (4) + 60B HBV1 payload = 76B
    assert_eq!(ge_buf.len(), 76);
    let mut off = 0;
    let ge_unpacked = GameMessage::unpack(&ge_buf, &mut off).expect("unpack 0x0910 GameEvent");
    assert_eq!(off, ge_buf.len());
    let GameMessage::GameEvent(e) = ge_unpacked else {
        panic!("expected GameEvent")
    };
    assert_eq!(e.target, Guid(1342177281));
    assert_eq!(e.sequence, 92);
    assert!(matches!(&e.event, GameEvent::Vehicle(v) if **v == VehicleS2C::PalletJackState(pjs)));
}

#[test]
fn hbv1_v8_fields_and_enums() {
    assert_eq!(HBV1_VERSION, 8);
    assert_eq!(locomotion::MARINE, 3);
    assert_eq!(vehicle_class::LEGACY, 0);
    assert_eq!(vehicle_class::AIR, 1);
    assert_eq!(vehicle_class::LIGHT_GROUND, 2);
    assert_eq!(vehicle_class::HEAVY_TRACTOR, 3);
    assert_eq!(vehicle_class::CONTAINER_SHIP_FEEDER, 4);
    assert_eq!(deployable_kind::RESERVED_WAREHOUSE_17, 17);
    assert_eq!(deployable_kind::RESERVED_WAREHOUSE_22, 22);
    assert_eq!(deployable_kind::STS_GANTRY_CRANE, 23);
    assert_eq!(deployable_kind::MARINE_FENDER, 29);
    assert_eq!(deployable_kind::ISO_REEFER_20, 30);
    assert_eq!(deployable_kind::ISO_FLAT_RACK_40, 37);
    assert_eq!(deployable_kind::GPR_SCANNER, 38);
    assert_eq!(deployable_kind::CORE_SAMPLE_CRATE, 42);
    assert_eq!(deployable_kind::BOREHOLE_MINER, 43);
    assert_eq!(deployable_kind::INDUSTRIAL_GENSET_150KW, 54);
    assert_eq!(deployable_kind::INDUSTRIAL_BESS_18MJ, 55);
    assert_eq!(deployable_kind::TOWN_CONTROL_NODE, 56);
    assert_eq!(deployable_kind::TOWN_MINT, 59);
    assert_eq!(deployable_kind::TOWN_WORKSHOP, 60);
    assert_eq!(deployable_kind::PUBLIC_COMMONS_STARTER_HEARTH, 61);

    // 64-bit values > u32::MAX round-trip cleanly
    let town_bytes = fixture_bytes("economy_town_state");
    assert_eq!(town_bytes.len(), 8 + EconomyTownState::WIRE);
    let VehicleS2C::EconomyTownState(ts) = unpack_s2c(s2c::ECONOMY_TOWN_STATE, &town_bytes) else {
        panic!("economy town state")
    };
    assert_eq!(ts.treasury_pyreals, 5_000_000_123);
    assert_eq!(ts.escrow_pyreals, 4_294_967_300);

    let mo_bytes = fixture_bytes("economy_monarch_order_state");
    assert_eq!(mo_bytes.len(), 8 + EconomyMonarchOrderState::WIRE);
    let VehicleS2C::EconomyMonarchOrderState(mo) = unpack_s2c(s2c::ECONOMY_MONARCH_ORDER_STATE, &mo_bytes) else {
        panic!("economy monarch order state")
    };
    assert_eq!(mo.order_id, 8_800_000_001);
    assert_eq!(mo.reward_pyreals, 6_000_000_000);

    // Every v8 struct WIRE constant matches both fixture byte length and packed payload length (8 + WIRE)
    for (name, opcode, wire) in [
        ("economy_siege_action", c2s::ECONOMY_SIEGE_ACTION, EconomySiegeAction::WIRE),
        ("industry_prospecting", c2s::INDUSTRY_PROSPECTING, IndustryProspecting::WIRE),
        ("industry_facility_action", c2s::INDUSTRY_FACILITY_ACTION, IndustryFacilityAction::WIRE),
        ("logistics_convoy_order", c2s::LOGISTICS_CONVOY_ORDER, LogisticsConvoyOrder::WIRE),
        ("economy_monarch_order", c2s::ECONOMY_MONARCH_ORDER, EconomyMonarchOrder::WIRE),
    ] {
        let bytes = fixture_bytes(name);
        assert_eq!(bytes.len(), 8 + wire, "{name} fixture len");
        let mut off = 0;
        let msg = VehicleC2S::unpack_payload(opcode, &bytes, &mut off).expect(name);
        assert_eq!(off, bytes.len(), "{name} unpack off");
        let mut repacked = Vec::new();
        msg.pack_payload(&mut repacked);
        assert_eq!(repacked.len(), 8 + wire, "{name} repacked len");
    }
    for (name, opcode, wire) in [
        ("economy_town_state", s2c::ECONOMY_TOWN_STATE, EconomyTownState::WIRE),
        ("economy_siege_event", s2c::ECONOMY_SIEGE_EVENT, EconomySiegeEvent::WIRE),
        ("industry_survey_result", s2c::INDUSTRY_SURVEY_RESULT, IndustrySurveyResult::WIRE),
        ("industry_facility_state", s2c::INDUSTRY_FACILITY_STATE, IndustryFacilityState::WIRE),
        ("logistics_convoy_state", s2c::LOGISTICS_CONVOY_STATE, LogisticsConvoyState::WIRE),
        ("economy_monarch_order_state", s2c::ECONOMY_MONARCH_ORDER_STATE, EconomyMonarchOrderState::WIRE),
    ] {
        let bytes = fixture_bytes(name);
        assert_eq!(bytes.len(), 8 + wire, "{name} fixture len");
        let mut off = 0;
        let msg = VehicleS2C::unpack_payload(opcode, &bytes, &mut off).expect(name);
        assert_eq!(off, bytes.len(), "{name} unpack off");
        let mut repacked = Vec::new();
        msg.pack_payload(&mut repacked);
        assert_eq!(repacked.len(), 8 + wire, "{name} repacked len");
    }
}

#[test]
fn hbv1_truncated_v8_rejected() {
    for (name, opcode) in [
        ("economy_siege_action", c2s::ECONOMY_SIEGE_ACTION),
        ("industry_prospecting", c2s::INDUSTRY_PROSPECTING),
        ("industry_facility_action", c2s::INDUSTRY_FACILITY_ACTION),
        ("logistics_convoy_order", c2s::LOGISTICS_CONVOY_ORDER),
        ("economy_monarch_order", c2s::ECONOMY_MONARCH_ORDER),
    ] {
        let bytes = fixture_bytes(name);
        for cut in [bytes.len() - 1, bytes.len() - 4, 8, 4, 0] {
            let mut off = 0;
            assert!(
                VehicleC2S::unpack_payload(opcode, &bytes[..cut], &mut off).is_none(),
                "{name} cut {cut}"
            );
            assert_eq!(off, 0);
        }
    }
    for (name, opcode) in [
        ("economy_town_state", s2c::ECONOMY_TOWN_STATE),
        ("economy_siege_event", s2c::ECONOMY_SIEGE_EVENT),
        ("industry_survey_result", s2c::INDUSTRY_SURVEY_RESULT),
        ("industry_facility_state", s2c::INDUSTRY_FACILITY_STATE),
        ("logistics_convoy_state", s2c::LOGISTICS_CONVOY_STATE),
        ("economy_monarch_order_state", s2c::ECONOMY_MONARCH_ORDER_STATE),
    ] {
        let bytes = fixture_bytes(name);
        for cut in [bytes.len() - 1, bytes.len() - 4, 8, 4, 0] {
            let mut off = 0;
            assert!(
                VehicleS2C::unpack_payload(opcode, &bytes[..cut], &mut off).is_none(),
                "{name} cut {cut}"
            );
            assert_eq!(off, 0);
        }
    }
}

#[test]
fn hbv1_v8_0x0911_to_0x0916_route_through_game_message() {
    use crate::messages::{GameActionMessage, GameEventMessage};
    use holtburger_common::Guid;

    let c2s_cases: Vec<VehicleC2S> = vec![
        VehicleC2S::EconomySiegeAction(EconomySiegeAction {
            town_id: 1,
            beacon_guid: 100,
            action: 2,
            flags: 1,
            reserved: 0,
            supply_points: 250,
            origin_landblock: 0xA9C90000,
        }),
        VehicleC2S::IndustryProspecting(IndustryProspecting {
            tool_guid: 200,
            tool_kind: deployable_kind::GPR_SCANNER,
            mode: 1,
            reserved0: 0,
            reserved1: 0,
            cell: 0xA9B40100,
            position: [64.5, 128.25, 14.0],
        }),
        VehicleC2S::IndustryFacilityAction(IndustryFacilityAction {
            facility_guid: 300,
            action: 3,
            reserved0: 0,
            reserved1: 0,
            recipe_id: 401,
            param: 12,
        }),
        VehicleC2S::LogisticsConvoyOrder(LogisticsConvoyOrder {
            convoy_id: 7_000_000_042,
            action: 1,
            vehicle_class: vehicle_class::CONTAINER_SHIP_FEEDER,
            flags: 3,
            origin_town_id: 1,
            dest_town_id: 12,
            container_kind: deployable_kind::ISO_REEFER_20,
            commodity_id: 4000060,
        }),
        VehicleC2S::EconomyMonarchOrder(EconomyMonarchOrder {
            order_id: 8_800_000_001,
            town_id: 1,
            action: 1,
            order_type: 2,
            flags: 1,
            target_guid: 0,
            item_wcid: 4000060,
            quantity: 20,
            reward_pyreals: 6_000_000_000,
            param_f32: 1.15,
        }),
    ];
    for (idx, msg) in c2s_cases.into_iter().enumerate() {
        let ga = GameMessage::GameAction(Box::new(GameActionMessage {
            sequence: 100 + idx as u32,
            action: GameAction::Vehicle(Box::new(msg.clone())),
        }));
        let mut buf = Vec::new();
        ga.pack(&mut buf);
        let mut off = 0;
        let unpacked = GameMessage::unpack(&buf, &mut off).expect("unpack v8 GameAction");
        assert_eq!(off, buf.len());
        let GameMessage::GameAction(a) = unpacked else {
            panic!("expected GameAction")
        };
        assert!(matches!(&a.action, GameAction::Vehicle(v) if **v == msg));
    }

    let s2c_cases: Vec<VehicleS2C> = vec![
        VehicleS2C::EconomyTownState(EconomyTownState {
            town_id: 1,
            control_state: 3,
            owner_monarch_id: 1342177281,
            attacker_monarch_id: 1342177999,
            flags: 1,
            reserved: 0,
            anchor_landblock: 0xA9B40000,
            hold_elapsed_sec: 14400,
            supply_meter_sec: 4800,
            starving_sec: 0,
            treasury_pyreals: 5_000_000_123,
            escrow_pyreals: 4_294_967_300,
            tariff_buy_mul: 1.05,
            tariff_sell_mul: 0.92,
        }),
        VehicleS2C::EconomySiegeEvent(EconomySiegeEvent {
            town_id: 1,
            kind: 6,
            control_state: 1,
            reserved: 0,
            owner_monarch_id: 1342177999,
            attacker_monarch_id: 1342177281,
            hold_elapsed_sec: 28800,
            supply_meter_sec: 5400,
            starving_sec: 0,
            treasury_spoils: 4_500_000_999,
        }),
        VehicleS2C::IndustrySurveyResult(IndustrySurveyResult {
            deposit_id: 9_001_002_003,
            landblock_id: 0xA9B4,
            tool_kind: deployable_kind::MOBILE_ASSAY_LAB,
            flags: 2,
            terrain_code: 4,
            resource_kind: 7,
            reserved: 0,
            depth_m: 185.5,
            grade_bps: 6450,
            api_gravity: 34.2,
            sulfur_bps: 120,
            remaining_tonnes: 12500.0,
        }),
        VehicleS2C::IndustryFacilityState(IndustryFacilityState {
            facility_guid: 1342178200,
            kind: deployable_kind::ADU_REFINERY,
            town_id: 1,
            deposit_id: 9_001_002_003,
            owner_monarch_id: 1342177281,
            status: 2,
            online_flags: 7,
            reserved: 0,
            power_watts: -45000.0,
            buffer_joules: 18_000_000.0,
            progress_pct: 0.625,
            recipe_id: 401,
        }),
        VehicleS2C::LogisticsConvoyState(LogisticsConvoyState {
            convoy_id: 7_000_000_042,
            owner_monarch_id: 1342177281,
            vehicle_guid: 2147486300,
            vehicle_class: vehicle_class::CONTAINER_SHIP_FEEDER,
            lod_state: 1,
            status: 2,
            reserved: 0,
            origin_town_id: 1,
            dest_town_id: 12,
            origin_landblock: 0xA9B4,
            spline_s_m: 1842.75,
            fuel_liters: 420.5,
            cell: 0xA9B40100,
            position: [96.0, 144.0, 0.0],
            heading: 2.356194,
        }),
        VehicleS2C::EconomyMonarchOrderState(EconomyMonarchOrderState {
            order_id: 8_800_000_001,
            monarch_id: 1342177281,
            town_id: 1,
            order_type: 2,
            status: 1,
            flags: 1,
            claimed_by_guid: 1342177350,
            item_wcid: 4000060,
            quantity: 20,
            reward_pyreals: 6_000_000_000,
            value_f32: 1.15,
        }),
    ];
    for (idx, msg) in s2c_cases.into_iter().enumerate() {
        let ge = GameMessage::GameEvent(Box::new(GameEventMessage {
            target: Guid(1342177281),
            sequence: 200 + idx as u32,
            event: GameEvent::Vehicle(Box::new(msg.clone())),
        }));
        let mut buf = Vec::new();
        ge.pack(&mut buf);
        let mut off = 0;
        let unpacked = GameMessage::unpack(&buf, &mut off).expect("unpack v8 GameEvent");
        assert_eq!(off, buf.len());
        let GameMessage::GameEvent(e) = unpacked else {
            panic!("expected GameEvent")
        };
        assert!(matches!(&e.event, GameEvent::Vehicle(v) if **v == msg));
    }
}
