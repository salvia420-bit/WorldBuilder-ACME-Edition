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

#[derive(serde::Serialize)]
pub(crate) struct VehicleWireStats {
    /// Vehicle events received, by opcode offset from 0x0900 (0x0900..=0x091F).
    pub received: [u32; 32],
    pub received_total: u64,
    pub sent_total: u64,
    pub sent_inputs: u64,
    pub inbox_overflow: u64,
    pub seat_ticks: u64,
    pub seat_releases_by_server: u64,
    pub snaps: u64,
}

impl Default for VehicleWireStats {
    fn default() -> Self {
        Self {
            received: [0; 32],
            received_total: 0,
            sent_total: 0,
            sent_inputs: 0,
            inbox_overflow: 0,
            seat_ticks: 0,
            seat_releases_by_server: 0,
            snaps: 0,
        }
    }
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
#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
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
                // v3 ground dynamics
                o.insert("wheelbase".into(), json!(p.wheelbase));
                o.insert("trackWidth".into(), json!(p.track_width));
                o.insert("wheelRadius".into(), json!(p.wheel_radius));
                o.insert("maxSteerRad".into(), json!(p.max_steer_rad));
                o.insert("reverseMax".into(), json!(p.reverse_max));
                o.insert("climbLimitCos".into(), json!(p.climb_limit_cos));
                o.insert("fordDepthMax".into(), json!(p.ford_depth_max));
                o.insert("cargoWcid".into(), json!(p.cargo_wcid));
                // v6 heavy tractor / fifth-wheel
                o.insert("fifthWheelOffsetY".into(), json!(p.fifth_wheel_offset_y));
                o.insert("fifthWheelOffsetZ".into(), json!(p.fifth_wheel_offset_z));
                o.insert("liveryId".into(), json!(p.livery_id));
                o.insert("vehicleClass".into(), json!(p.vehicle_class));
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
            "steerAngle": s.steer_angle, "groundFlags": s.ground_flags,
            "surfaceFamily": s.surface_family, "wheelSpinQ16": s.wheel_spin_q16,
            "cargoMask": s.cargo_mask,
            "palletSize0": s.pallet_size0,
            "palletSize1": s.pallet_size1,
            "cargoSlot0Wcid": s.cargo_slot0_wcid,
            "cargoSlot1Wcid": s.cargo_slot1_wcid,
            "cargoLoaded": (s.cargo_mask != 0) || (s.cargo_slot0_wcid != 0),
            "hitchedTrailerGuid": s.hitched_trailer_guid,
            "trailerHeading": s.trailer_heading,
            "trailerPitch": s.trailer_pitch,
            "trailerFlags": s.trailer_flags,
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
        VehicleS2C::RadarContacts(rc) => json!({
            "type": "radar_contacts",
            "radar": rc.radar_guid,
            "parentVehicle": rc.parent_vehicle,
            "radarPos": [rc.radar_x, rc.radar_y, rc.radar_z],
            "rangeM": rc.range_m,
            "ceilingM": rc.ceiling_m,
            "contactCount": rc.contacts.len(),
            "contacts": rc.contacts.iter().map(|c| json!({
                "vehicleGuid": c.vehicle_guid,
                "dxM": c.dx_m,
                "dyM": c.dy_m,
                "altAglM": c.alt_agl_m,
                "heading": c.heading_u8 as f32 * (std::f32::consts::TAU / 256.0),
                "headingU8": c.heading_u8,
                "standing": c.standing,
                "speedMps": c.speed_mps_u8,
                "flags": c.flags,
            })).collect::<Vec<_>>(),
        }),
        VehicleS2C::DeployableState(ds) => json!({
            "type": "deployable_state",
            "deployable": ds.deployable_guid,
            "kind": ds.deployable_kind,
            "palletSize": ds.pallet_size,
            "onlineFlags": ds.online_flags,
            "ammo": ds.ammo_remaining,
            "owner": ds.owner_guid,
            "parentVehicle": ds.parent_vehicle,
            "cell": ds.cell,
            "x": ds.position[0], "y": ds.position[1], "z": ds.position[2],
            "heading": ds.heading,
            "powerWatts": ds.power_watts,
            "energyJoules": ds.energy_stored_joules,
            "energyCapacity": ds.energy_capacity_joules,
            "fuelSec": ds.fuel_remaining,
            "pitch": ds.pitch_rad,
            "yaw": ds.yaw_rad,
            "roll": ds.roll_rad,
            "elevation": ds.elevation_m,
        }),
        VehicleS2C::DeployableFire(df) => json!({
            "type": "deployable_fire",
            "deployable": df.deployable_guid,
            "weaponKind": df.weapon_kind,
            "step": df.step,
            "target": df.target_guid,
            "cell": df.cell,
            "muzzle": [df.muzzle[0], df.muzzle[1], df.muzzle[2]],
            "targetPos": [df.target_pos[0], df.target_pos[1], df.target_pos[2]],
            "velocity": [df.velocity[0], df.velocity[1], df.velocity[2]],
            "energyJoules": df.energy_joules,
            "burstCount": df.burst_count,
        }),
        VehicleS2C::GroundContacts(gc) => json!({
            "type": "ground_contacts",
            "radar": gc.radar_guid,
            "parentVehicle": gc.parent_vehicle,
            "radarPos": [gc.radar_x, gc.radar_y, gc.radar_z],
            "rangeM": gc.range_m,
            "sweepAngleRad": gc.sweep_angle_rad,
            "contactCount": gc.contacts.len(),
            "contacts": gc.contacts.iter().map(|c| json!({
                "targetGuid": c.target_guid,
                "dxM": c.dx_m,
                "dyM": c.dy_m,
                "dzM": c.dz_m,
                "kind": c.kind,
                "standing": c.standing,
                "heading": c.heading_u8 as f32 * (std::f32::consts::TAU / 256.0),
                "headingU8": c.heading_u8,
                "speedMps": c.speed_mps_u8,
                "flags": c.flags,
            })).collect::<Vec<_>>(),
        }),
        VehicleS2C::ContainerState(cs) => json!({
            "type": "container_state",
            "containerGuid": cs.container_guid,
            "containerKind": cs.container_kind,
            "doorState": cs.door_state,
            "liveryId": cs.livery_id,
            "maxFullSlots": cs.max_full_slots,
            "flags": cs.flags,
            "ownerGuid": cs.owner_guid,
            "cell": cs.cell,
            "position": v3(cs.position),
            "heading": cs.heading as f64,
            "doorProgress": cs.door_progress as f64,
            "serialNumber": cs.serial_number,
            "slots": cs.slots.iter().map(|s| json!({
                "slotIndex": s.slot_index,
                "palletSize": s.pallet_size,
                "subSlot": s.sub_slot,
                "reserved": s.reserved,
                "cargoWcid": s.cargo_wcid,
            })).collect::<Vec<_>>(),
        }),
        VehicleS2C::TrailerState(ts) => json!({
            "type": "trailer_state",
            "trailerGuid": ts.trailer_guid,
            "kind": ts.kind,
            "cell": ts.cell,
            "position": v3(ts.position),
            "heading": ts.heading as f64,
            "pitch": ts.pitch as f64,
            "bank": ts.bank as f64,
            "coupledTractorGuid": ts.coupled_tractor_guid,
            "mountedContainerGuid": ts.mounted_container_guid,
            "containerSlot": ts.container_slot,
            "trailerFlags": ts.trailer_flags,
            "ownerGuid": ts.owner_guid,
            "sideliftPhase": ts.sidelift_phase,
            "sideliftSide": ts.sidelift_side,
            "sideliftFlags": ts.sidelift_flags,
            "sideliftProgress": ts.sidelift_progress as f64,
            "outriggerProgress": ts.outrigger_progress as f64,
            "craneSpanY": ts.crane_span_y as f64,
            "stowedPalletJackGuid": ts.stowed_pallet_jack_guid,
            "transferContainerGuid": ts.transfer_container_guid,
        }),
        VehicleS2C::PalletJackState(pj) => json!({
            "type": "pallet_jack_state",
            "palletJackGuid": pj.pallet_jack_guid,
            "operatorGuid": pj.operator_guid,
            "stowedOnTrailerGuid": pj.stowed_on_trailer_guid,
            "cell": pj.cell,
            "position": v3(pj.position),
            "heading": pj.heading as f64,
            "tillerAngle": pj.tiller_angle as f64,
            "forkHeightM": pj.fork_height_m as f64,
            "forkState": pj.fork_state,
            "carriedPalletSize": pj.carried_pallet_size,
            "flags": pj.flags,
            "carriedWcid": pj.carried_wcid,
            "ownerGuid": pj.owner_guid,
        }),
        VehicleS2C::EconomyTownState(ts) => json!({
            "type": "economy_town_state",
            "townId": ts.town_id,
            "controlState": ts.control_state,
            "ownerMonarchId": ts.owner_monarch_id,
            "attackerMonarchId": ts.attacker_monarch_id,
            "flags": ts.flags,
            "anchorLandblock": ts.anchor_landblock,
            "holdElapsedSec": ts.hold_elapsed_sec,
            "supplyMeterSec": ts.supply_meter_sec,
            "starvingSec": ts.starving_sec,
            "treasuryPyreals": ts.treasury_pyreals,
            "escrowPyreals": ts.escrow_pyreals,
            "tariffBuyMul": ts.tariff_buy_mul as f64,
            "tariffSellMul": ts.tariff_sell_mul as f64,
        }),
        VehicleS2C::EconomySiegeEvent(se) => json!({
            "type": "economy_siege_event",
            "townId": se.town_id,
            "kind": se.kind,
            "controlState": se.control_state,
            "ownerMonarchId": se.owner_monarch_id,
            "attackerMonarchId": se.attacker_monarch_id,
            "holdElapsedSec": se.hold_elapsed_sec,
            "supplyMeterSec": se.supply_meter_sec,
            "starvingSec": se.starving_sec,
            "treasurySpoils": se.treasury_spoils,
        }),
        VehicleS2C::IndustrySurveyResult(sr) => json!({
            "type": "industry_survey_result",
            "depositId": sr.deposit_id,
            "landblockId": sr.landblock_id,
            "toolKind": sr.tool_kind,
            "flags": sr.flags,
            "terrainCode": sr.terrain_code,
            "resourceKind": sr.resource_kind,
            "depthM": sr.depth_m as f64,
            "gradeBps": sr.grade_bps,
            "apiGravity": sr.api_gravity as f64,
            "sulfurBps": sr.sulfur_bps,
            "remainingTonnes": sr.remaining_tonnes as f64,
        }),
        VehicleS2C::IndustryFacilityState(fs) => json!({
            "type": "industry_facility_state",
            "facilityGuid": fs.facility_guid,
            "kind": fs.kind,
            "townId": fs.town_id,
            "depositId": fs.deposit_id,
            "ownerMonarchId": fs.owner_monarch_id,
            "status": fs.status,
            "onlineFlags": fs.online_flags,
            "powerWatts": fs.power_watts as f64,
            "bufferJoules": fs.buffer_joules as f64,
            "progressPct": fs.progress_pct as f64,
            "recipeId": fs.recipe_id,
        }),
        VehicleS2C::LogisticsConvoyState(cs) => json!({
            "type": "logistics_convoy_state",
            "convoyId": cs.convoy_id,
            "ownerMonarchId": cs.owner_monarch_id,
            "vehicleGuid": cs.vehicle_guid,
            "vehicleClass": cs.vehicle_class,
            "lodState": cs.lod_state,
            "status": cs.status,
            "originTownId": cs.origin_town_id,
            "destTownId": cs.dest_town_id,
            "originLandblock": cs.origin_landblock,
            "splineSM": cs.spline_s_m as f64,
            "fuelLiters": cs.fuel_liters as f64,
            "cell": cs.cell,
            "position": v3(cs.position),
            "heading": cs.heading as f64,
        }),
        VehicleS2C::EconomyMonarchOrderState(mo) => json!({
            "type": "economy_monarch_order_state",
            "orderId": mo.order_id,
            "monarchId": mo.monarch_id,
            "townId": mo.town_id,
            "orderType": mo.order_type,
            "status": mo.status,
            "flags": mo.flags,
            "claimedByGuid": mo.claimed_by_guid,
            "itemWcid": mo.item_wcid,
            "quantity": mo.quantity,
            "rewardPyreals": mo.reward_pyreals,
            "valueF32": mo.value_f32 as f64,
        }),
    }
}

/// Recv-loop hook for every inbound vehicle event.
#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
pub(crate) fn on_s2c(msg: &VehicleS2C, local_player: u32) -> LinkAction {
    LINK.with(|l| {
        let mut l = l.borrow_mut();
        let idx = (msg.opcode().wrapping_sub(0x0900) & 0x1F) as usize;
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
            VehicleS2C::PalletJackState(pj) => {
                if pj.operator_guid != local_player
                    && l.seat.is_some_and(|p| p.vehicle == pj.pallet_jack_guid)
                {
                    l.seat = None;
                    l.released_vehicle = Some(pj.pallet_jack_guid);
                    l.stats.seat_releases_by_server += 1;
                } else if local_player != 0
                    && pj.operator_guid == local_player
                    && l.released_vehicle == Some(pj.pallet_jack_guid)
                {
                    l.released_vehicle = None;
                }
                LinkAction::None
            }
            VehicleS2C::Event(e) if e.kind == 4 => {
                if l.seat.is_some_and(|p| p.vehicle == e.vehicle) {
                    l.seat = None;
                    l.released_vehicle = Some(e.vehicle);
                    l.stats.seat_releases_by_server += 1;
                }
                LinkAction::None
            }
            VehicleS2C::Event(e) if e.subject == local_player && local_player != 0 => {
                // 7 = Touchdown (back on foot at Cell/Position): releases ANY lock (the bail-out fall lock is keyed on
                // the player)
                if e.kind == 7 {
                    if l.seat.is_some() {
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

#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
pub(crate) fn drain_json() -> String {
    LINK.with(|l| {
        let drained: Vec<Value> = std::mem::take(&mut l.borrow_mut().inbox);
        serde_json::to_string(&drained).unwrap_or_else(|_| "[]".to_string())
    })
}

#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
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

#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
pub(crate) fn clear_seat() {
    LINK.with(|l| {
        let mut l = l.borrow_mut();
        l.seat = None;
        l.released_vehicle = None;
    })
}

#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
pub(crate) fn reset() {
    LINK.with(|l| {
        let mut l = l.borrow_mut();
        l.inbox.clear();
        l.seat = None;
        l.released_vehicle = None;
    })
}

#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
pub(crate) fn seat_pose() -> Option<SeatPose> {
    LINK.with(|l| l.borrow().seat)
}

#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
pub(crate) fn note_seat_tick() {
    LINK.with(|l| l.borrow_mut().stats.seat_ticks += 1)
}

#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
pub(crate) fn note_sent(is_input: bool) {
    LINK.with(|l| {
        let mut l = l.borrow_mut();
        l.stats.sent_total += 1;
        if is_input {
            l.stats.sent_inputs += 1;
        }
    })
}

#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
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
#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
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
        s2c::CAPABILITIES_ACK
            | s2c::PROFILE
            | s2c::SEAT
            | s2c::STATE
            | s2c::FIRE
            | s2c::EVENT
            | s2c::RADAR_CONTACTS
            | s2c::DEPLOYABLE_STATE
            | s2c::DEPLOYABLE_FIRE
            | s2c::GROUND_CONTACTS
            | s2c::CONTAINER_STATE
            | s2c::TRAILER_STATE
            | s2c::PALLET_JACK_STATE
            | s2c::ECONOMY_TOWN_STATE
            | s2c::ECONOMY_SIEGE_EVENT
            | s2c::INDUSTRY_SURVEY_RESULT
            | s2c::INDUSTRY_FACILITY_STATE
            | s2c::LOGISTICS_CONVOY_STATE
            | s2c::ECONOMY_MONARCH_ORDER_STATE
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use holtburger_protocol::messages::vehicle::{
        EconomyMonarchOrderState, EconomySiegeEvent, EconomyTownState, IndustryFacilityState,
        IndustrySurveyResult, LogisticsConvoyState, VehicleEvent, VehiclePalletJackState,
        VehicleProfile, VehicleState, VehicleTrailerState,
    };

    #[test]
    fn is_vehicle_event_includes_v7_and_v8_opcodes() {
        assert!(is_vehicle_event(s2c::TRAILER_STATE));
        assert!(is_vehicle_event(s2c::CONTAINER_STATE));
        assert!(is_vehicle_event(s2c::PALLET_JACK_STATE));
        assert!(is_vehicle_event(s2c::ECONOMY_TOWN_STATE));
        assert!(is_vehicle_event(s2c::ECONOMY_SIEGE_EVENT));
        assert!(is_vehicle_event(s2c::INDUSTRY_SURVEY_RESULT));
        assert!(is_vehicle_event(s2c::INDUSTRY_FACILITY_STATE));
        assert!(is_vehicle_event(s2c::LOGISTICS_CONVOY_STATE));
        assert!(is_vehicle_event(s2c::ECONOMY_MONARCH_ORDER_STATE));
        assert!(!is_vehicle_event(0x0917));
        assert!(!is_vehicle_event(0x0920));
    }

    #[test]
    fn to_json_serializes_v6_profile_state_and_trailer_state() {
        let prof = VehicleProfile {
            vehicle: 100,
            profile_key: "semi-379".into(),
            display_name: "Ironhorse 379".into(),
            locomotion: 2,
            stand_in_setup: 0x0200_026B,
            sim_hz: 30,
            reserved: 0,
            v_min: 0.0,
            v_cruise: 20.0,
            v_max: 27.0,
            speed_cap: 27.0,
            accel: 4.8,
            decel: 9.5,
            max_bank: 0.0,
            roll_rate: 0.0,
            max_pitch: 0.0,
            pitch_rate: 0.0,
            yaw_rate: 0.0,
            climb_max: 0.0,
            sink_max: 0.0,
            floor_agl: 0.0,
            ceiling_agl: 0.0,
            takeoff_climb: 0.0,
            landing_speed: 0.0,
            lead_seconds: 4.0,
            object_radius: 1,
            seats: vec![],
            weapons: vec![],
            parts: vec![],
            part_roles: vec![],
            weapon_ext: vec![],
            wheelbase: 4.66,
            track_width: 2.12,
            wheel_radius: 0.505,
            max_steer_rad: 0.663225,
            reverse_max: -7.0,
            climb_limit_cos: 0.788,
            ford_depth_max: 1.05,
            cargo_wcid: 0,
            fifth_wheel_offset_y: -2.01,
            fifth_wheel_offset_z: 0.96,
            livery_id: 2,
            vehicle_class: 3,
            reserved4: 0,
        };
        let pj = to_json(&VehicleS2C::Profile(Box::new(prof)));
        assert_eq!(pj["type"], "profile");
        assert_eq!(pj["liveryId"], 2);
        assert_eq!(pj["vehicleClass"], 3);
        assert!((pj["fifthWheelOffsetY"].as_f64().unwrap() + 2.01).abs() < 1e-5);
        assert!((pj["fifthWheelOffsetZ"].as_f64().unwrap() - 0.96).abs() < 1e-5);

        let st = VehicleState {
            vehicle: 100,
            step: 42,
            ack_input_seq: 41,
            cell: 0x0102_0100,
            position: [10.0, 20.0, 30.0],
            heading: 1.25,
            pitch: 0.0,
            bank: 0.0,
            speed: 12.0,
            v_cap: 27.0,
            ammo: 0,
            mode: 6,
            flags: 1,
            missile_mask: 0,
            bomb_mask: 0,
            reserved2: 0,
            steer_angle: 0.1,
            ground_flags: 1,
            surface_family: 0,
            wheel_spin_q16: 0,
            cargo_mask: 0,
            pallet_size0: 0,
            pallet_size1: 0,
            reserved3: 0,
            cargo_slot0_wcid: 0,
            cargo_slot1_wcid: 0,
            hitched_trailer_guid: 500,
            trailer_heading: 1.20,
            trailer_pitch: -0.05,
            trailer_flags: 0x07,
            reserved4: 0,
            reserved5: 0,
        };
        let sj = to_json(&VehicleS2C::State(st));
        assert_eq!(sj["type"], "state");
        assert_eq!(sj["hitchedTrailerGuid"], 500);
        assert_eq!(sj["trailerFlags"], 0x07);
        assert!((sj["trailerHeading"].as_f64().unwrap() - 1.20).abs() < 1e-5);
        assert!((sj["trailerPitch"].as_f64().unwrap() + 0.05).abs() < 1e-5);

        let ts = VehicleTrailerState {
            trailer_guid: 500,
            kind: 15,
            cell: 0x0102_0100,
            position: [10.0, 14.0, 30.0],
            heading: 1.20,
            pitch: -0.05,
            bank: 0.01,
            coupled_tractor_guid: 100,
            mounted_container_guid: 600,
            container_slot: 0,
            trailer_flags: 0x07,
            reserved: 0,
            owner_guid: 77,
            sidelift_phase: 6,
            sidelift_side: -1,
            sidelift_flags: 0x05,
            reserved7: 0,
            sidelift_progress: 0.5,
            outrigger_progress: 1.0,
            crane_span_y: 2.9265,
            stowed_pallet_jack_guid: 700,
            transfer_container_guid: 600,
        };
        let tj = to_json(&VehicleS2C::TrailerState(ts));
        assert_eq!(tj["type"], "trailer_state");
        assert_eq!(tj["trailerGuid"], 500);
        assert_eq!(tj["kind"], 15);
        assert_eq!(tj["cell"], 0x0102_0100);
        assert_eq!(tj["position"].as_array().unwrap().len(), 3);
        assert_eq!(tj["coupledTractorGuid"], 100);
        assert_eq!(tj["mountedContainerGuid"], 600);
        assert_eq!(tj["containerSlot"], 0);
        assert_eq!(tj["trailerFlags"], 0x07);
        assert_eq!(tj["ownerGuid"], 77);
        assert_eq!(tj["sideliftPhase"], 6);
        assert_eq!(tj["sideliftSide"], -1);
        assert_eq!(tj["sideliftFlags"], 0x05);
        assert!((tj["sideliftProgress"].as_f64().unwrap() - 0.5).abs() < 1e-5);
        assert!((tj["outriggerProgress"].as_f64().unwrap() - 1.0).abs() < 1e-5);
        assert!((tj["craneSpanY"].as_f64().unwrap() - 2.9265).abs() < 1e-4);
        assert_eq!(tj["stowedPalletJackGuid"], 700);
        assert_eq!(tj["transferContainerGuid"], 600);

        let pjs = VehiclePalletJackState {
            pallet_jack_guid: 700,
            operator_guid: 77,
            stowed_on_trailer_guid: 0,
            cell: 0x0102_0100,
            position: [12.0, 15.0, 30.162],
            heading: 0.5,
            tiller_angle: -0.25,
            fork_height_m: 0.2,
            fork_state: 2,
            carried_pallet_size: 2,
            flags: 3,
            reserved: 0,
            carried_wcid: 4000010,
            owner_guid: 77,
        };
        let pjj = to_json(&VehicleS2C::PalletJackState(pjs));
        assert_eq!(pjj["type"], "pallet_jack_state");
        assert_eq!(pjj["palletJackGuid"], 700);
        assert_eq!(pjj["operatorGuid"], 77);
        assert_eq!(pjj["stowedOnTrailerGuid"], 0);
        assert!((pjj["forkHeightM"].as_f64().unwrap() - 0.2).abs() < 1e-5);
        assert_eq!(pjj["forkState"], 2);
        assert_eq!(pjj["carriedPalletSize"], 2);
        assert_eq!(pjj["flags"], 3);
        assert_eq!(pjj["carriedWcid"], 4000010);
        assert_eq!(pjj["ownerGuid"], 77);
    }

    #[test]
    fn on_s2c_records_trailer_state_in_inbox_and_stats() {
        reset();
        let ts = VehicleTrailerState {
            trailer_guid: 500,
            kind: 14,
            cell: 0x0102_0100,
            position: [10.0, 14.0, 30.0],
            heading: 1.20,
            pitch: -0.05,
            bank: 0.01,
            coupled_tractor_guid: 100,
            mounted_container_guid: 0,
            container_slot: 0,
            trailer_flags: 0x05,
            reserved: 0,
            owner_guid: 77,
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
        let action = on_s2c(&VehicleS2C::TrailerState(ts), 77);
        assert!(matches!(action, LinkAction::None));
        let drained: Value = serde_json::from_str(&drain_json()).unwrap();
        let arr = drained.as_array().unwrap();
        assert_eq!(arr.len(), 1);
        assert_eq!(arr[0]["type"], "trailer_state");
        assert_eq!(arr[0]["trailerGuid"], 500);
        let stats: Value = serde_json::from_str(&stats_json()).unwrap();
        assert!(stats["received"][15].as_u64().unwrap() >= 1);
    }

    #[test]
    fn on_s2c_pallet_jack_state_stats_and_seat_autoclear() {
        reset();
        let jack_guid = 700;
        let local_player = 77;
        assert!(set_seat(SeatPose {
            vehicle: jack_guid,
            cell: 0x0102_0100,
            x: 12.0,
            y: 15.0,
            z: 30.0,
            heading: 0.0,
        }));
        assert!(seat_pose().is_some());

        // Server clears operator -> seat lock releases automatically and rejects re-lock until cleared/confirmed
        let cleared = VehiclePalletJackState {
            pallet_jack_guid: jack_guid,
            operator_guid: 0,
            stowed_on_trailer_guid: 0,
            cell: 0x0102_0100,
            position: [12.0, 15.0, 30.0],
            heading: 0.0,
            tiller_angle: 0.0,
            fork_height_m: 0.085,
            fork_state: 0,
            carried_pallet_size: 0,
            flags: 0,
            reserved: 0,
            carried_wcid: 0,
            owner_guid: local_player,
        };
        on_s2c(&VehicleS2C::PalletJackState(cleared), local_player);
        assert!(seat_pose().is_none());
        assert!(!set_seat(SeatPose {
            vehicle: jack_guid,
            cell: 0x0102_0100,
            x: 12.0,
            y: 15.0,
            z: 30.0,
            heading: 0.0,
        }));

        let stats: Value = serde_json::from_str(&stats_json()).unwrap();
        assert!(stats["received"][16].as_u64().unwrap() >= 1);
        assert!(stats["seat_releases_by_server"].as_u64().unwrap() >= 1);

        // Server re-assigning operator_guid == local_player lifts released_vehicle gate
        let regrabbed = VehiclePalletJackState {
            operator_guid: local_player,
            ..cleared
        };
        on_s2c(&VehicleS2C::PalletJackState(regrabbed), local_player);
        assert!(set_seat(SeatPose {
            vehicle: jack_guid,
            cell: 0x0102_0100,
            x: 12.0,
            y: 15.0,
            z: 30.0,
            heading: 0.0,
        }));
        let drained: Value = serde_json::from_str(&drain_json()).unwrap();
        assert_eq!(drained.as_array().unwrap().len(), 2);
        assert_eq!(drained[0]["type"], "pallet_jack_state");
    }

    #[test]
    fn on_s2c_vehicle_despawn_clears_seat_regardless_of_subject() {
        reset();
        let jack_guid = 777;
        let local_player = 77;
        assert!(set_seat(SeatPose {
            vehicle: jack_guid,
            cell: 0x0102_0100,
            x: 12.0,
            y: 15.0,
            z: 30.0,
            heading: 0.0,
        }));
        assert!(seat_pose().is_some());

        let ev = VehicleEvent {
            vehicle: jack_guid,
            kind: 4, // Despawn
            step: 0,
            subject: jack_guid, // != local_player
            cell: 0x0102_0100,
            position: [12.0, 15.0, 30.0],
            value: 0.0,
            aux: 0,
            velocity: [0.0, 0.0, 0.0],
        };
        let action = on_s2c(&VehicleS2C::Event(ev), local_player);
        assert!(matches!(action, LinkAction::None));
        assert!(seat_pose().is_none(), "Despawn must release l.seat even when subject != local_player");

        let stats: Value = serde_json::from_str(&stats_json()).unwrap();
        assert!(stats["seat_releases_by_server"].as_u64().unwrap() >= 1);
    }

    #[test]
    fn to_json_and_on_s2c_handle_v8_economy_and_industry_messages() {
        reset();
        let ts = EconomyTownState {
            town_id: 1,
            control_state: 3,
            owner_monarch_id: 100,
            attacker_monarch_id: 200,
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
        };
        let se = EconomySiegeEvent {
            town_id: 1,
            kind: 6,
            control_state: 1,
            reserved: 0,
            owner_monarch_id: 200,
            attacker_monarch_id: 100,
            hold_elapsed_sec: 28800,
            supply_meter_sec: 5400,
            starving_sec: 0,
            treasury_spoils: 4_500_000_999,
        };
        let sr = IndustrySurveyResult {
            deposit_id: 9_001_002_003,
            landblock_id: 0xA9B4,
            tool_kind: 41,
            flags: 2,
            terrain_code: 4,
            resource_kind: 7,
            reserved: 0,
            depth_m: 185.5,
            grade_bps: 6450,
            api_gravity: 34.2,
            sulfur_bps: 120,
            remaining_tonnes: 12500.0,
        };
        let fs = IndustryFacilityState {
            facility_guid: 1342178200,
            kind: 49,
            town_id: 1,
            deposit_id: 9_001_002_003,
            owner_monarch_id: 100,
            status: 2,
            online_flags: 7,
            reserved: 0,
            power_watts: -45000.0,
            buffer_joules: 18_000_000.0,
            progress_pct: 0.625,
            recipe_id: 401,
        };
        let cs = LogisticsConvoyState {
            convoy_id: 7_000_000_042,
            owner_monarch_id: 100,
            vehicle_guid: 2147486300,
            vehicle_class: 4,
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
        };
        let mo = EconomyMonarchOrderState {
            order_id: 8_800_000_001,
            monarch_id: 100,
            town_id: 1,
            order_type: 2,
            status: 1,
            flags: 1,
            claimed_by_guid: 300,
            item_wcid: 4000060,
            quantity: 20,
            reward_pyreals: 6_000_000_000,
            value_f32: 1.15,
        };

        for msg in [
            VehicleS2C::EconomyTownState(ts),
            VehicleS2C::EconomySiegeEvent(se),
            VehicleS2C::IndustrySurveyResult(sr),
            VehicleS2C::IndustryFacilityState(fs),
            VehicleS2C::LogisticsConvoyState(cs),
            VehicleS2C::EconomyMonarchOrderState(mo),
        ] {
            let action = on_s2c(&msg, 100);
            assert!(matches!(action, LinkAction::None));
        }

        let drained: Value = serde_json::from_str(&drain_json()).unwrap();
        let arr = drained.as_array().unwrap();
        assert_eq!(arr.len(), 6);
        assert_eq!(arr[0]["type"], "economy_town_state");
        assert_eq!(arr[0]["treasuryPyreals"], 5_000_000_123u64);
        assert_eq!(arr[1]["type"], "economy_siege_event");
        assert_eq!(arr[1]["treasurySpoils"], 4_500_000_999u64);
        assert_eq!(arr[2]["type"], "industry_survey_result");
        assert_eq!(arr[2]["depositId"], 9_001_002_003u64);
        assert_eq!(arr[3]["type"], "industry_facility_state");
        assert_eq!(arr[4]["type"], "logistics_convoy_state");
        assert_eq!(arr[4]["vehicleClass"], 4);
        assert_eq!(arr[5]["type"], "economy_monarch_order_state");
        assert_eq!(arr[5]["rewardPyreals"], 6_000_000_000u64);

        let stats: Value = serde_json::from_str(&stats_json()).unwrap();
        for idx in 17..=22 {
            assert!(stats["received"][idx].as_u64().unwrap() >= 1, "received[{idx}]");
        }
    }
}
