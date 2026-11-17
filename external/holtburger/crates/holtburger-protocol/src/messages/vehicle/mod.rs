//! HBV1 — the holtburger vehicle messages (vehicles design 2026-11-01, DESIGN.md §5).
//!
//! The wire spec is `apps/holtburger-web/docs/vehicles-2026-11-01/protocol/vehicles.protocol.xml`
//! (Chorizite style; ONE definition shared with ACE and a future Chorizite plugin). This module is its
//! Rust mirror; `tests.rs` round-trips the shared byte fixtures (`vehicle-wire-fixtures.json`, generated
//! from the XML) so the C# (ACE) and Rust sides cannot drift.
//!
//! Framing: C2S = game actions 0x0900–0x0905 (inside 0xF7B1), S2C = game events 0x0900–0x0908 (inside
//! 0xF7B0). Every payload starts with the 8-byte [`VehicleHeader`] (`"HBV1"`, version, reserved). A payload
//! without the tag is rejected (`unpack_payload` → `None`; the event dispatcher then keeps it as
//! `GameEvent::Unknown`, i.e. dropped).
//!
//! Versions only append fields. Writers emit [`HBV1_VERSION`] (2). A v1 payload parses with the v2 fields at
//! their defaults (0 / empty; `VehicleFire::mount_count` = 1); a payload newer than v2 is parsed for its v2
//! fields and its trailing bytes are skipped. v2 appends: `VehicleProfile::{part_roles, weapon_ext}`,
//! `VehicleState::{missile_mask, bomb_mask, reserved2}`, `VehicleFire::{mount_count, reserved2, speed}`,
//! `VehicleEvent::{aux, velocity}`. C2S messages are unchanged apart from the header version.

use crate::messages::utils::{read_string16, write_string16};
use byteorder::{ByteOrder, LittleEndian, WriteBytesExt};

#[cfg(test)]
mod tests;

/// `"HBV1"` as a little-endian u32 (bytes `48 42 56 31`).
pub const HBV1_TAG: u32 = 0x3156_4248;
/// The protocol version this module writes (and the newest it parses fully).
pub const HBV1_VERSION: u16 = 6;
/// The first version carrying the v2 fields.
const V2: u16 = 2;
/// The first version carrying the v3 fields.
const V3: u16 = 3;
/// The first version carrying the v4 fields.
const V4: u16 = 4;
/// The first version carrying the v5 fields.
const V5: u16 = 5;
/// The first version carrying the v6 fields.
const V6: u16 = 6;

/// ClientCapabilities / CapabilitiesAck bits.
pub mod caps {
    /// Receive VehicleProfile / Seat / State / Fire / Event.
    pub const OBSERVE: u32 = 0x1;
    /// May send VehicleBoard / Input / Exit.
    pub const PILOT: u32 = 0x2;
    /// Has the vehicle DAT patch (tier 1).
    pub const DAT_PATCH: u32 = 0x4;
}

/// C2S game-action opcodes.
pub mod c2s {
    pub const CLIENT_CAPABILITIES: u32 = 0x0900;
    pub const BOARD: u32 = 0x0902;
    pub const EXIT: u32 = 0x0903;
    pub const INPUT: u32 = 0x0905;
    /// v3: cargo deployment or packing (1=Deploy, 2=Pack).
    pub const CARGO: u32 = 0x0909;
    /// v5: container action request (1=OpenDoors, 2=CloseDoors, 3=Load, 4=Pack, 5=Unpack, 6=UnpackAll).
    pub const CONTAINER_ACTION: u32 = 0x090E;
    /// v6: pallet action request.
    pub const PALLET_ACTION: u32 = 0x090F;
}

/// S2C game-event opcodes.
pub mod s2c {
    pub const CAPABILITIES_ACK: u32 = 0x0900;
    pub const PROFILE: u32 = 0x0901;
    pub const SEAT: u32 = 0x0904;
    pub const STATE: u32 = 0x0906;
    pub const FIRE: u32 = 0x0907;
    pub const EVENT: u32 = 0x0908;
    /// v3: 1 Hz compact radar sweep broadcast.
    pub const RADAR_CONTACTS: u32 = 0x090A;
    /// v4: Authoritative state of deployed units (84 bytes).
    pub const DEPLOYABLE_STATE: u32 = 0x090B;
    /// v4: Deployable weapon discharge event (68 bytes).
    pub const DEPLOYABLE_FIRE: u32 = 0x090C;
    /// v4: Ground radar 30 RPM surface sweep broadcast.
    pub const GROUND_CONTACTS: u32 = 0x090D;
    /// v5: Authoritative container telemetry broadcast.
    pub const CONTAINER_STATE: u32 = 0x090E;
    /// v6: Authoritative pallet state broadcast.
    pub const PALLET_EVENT: u32 = 0x090F;
}

/// `VehicleProfile.locomotion`.
pub mod locomotion {
    pub const AIR: u32 = 1;
    pub const GROUND: u32 = 2;
}

/// `VehicleState.mode`.
pub mod mode {
    pub const PARKED: u8 = 0;
    pub const TAKEOFF: u8 = 1;
    pub const FLIGHT: u8 = 2;
    pub const LANDING: u8 = 3;
    pub const CRASHED: u8 = 4;
    pub const DERELICT: u8 = 5;
    /// v3: ground driving.
    pub const DRIVING: u8 = 6;
}

/// `VehicleInputFrame.buttons`.
pub mod buttons {
    pub const BOOST: u8 = 0x01;
    /// Alias for BOOST on ground vehicles (4WD low-range).
    pub const LOW_RANGE: u8 = 0x01;
    pub const FIRE: u8 = 0x02;
    pub const LAND: u8 = 0x04;
    /// v2: fire a lightning-bolt rail; held: the next rail every 0.3 s.
    pub const MISSILE: u8 = 0x08;
    /// v2: rising edge: release the next bomb.
    pub const BOMB: u8 = 0x10;
    /// v3: ground handbrake.
    pub const HANDBRAKE: u8 = 0x20;
    /// v3: horn.
    pub const HORN: u8 = 0x40;
    /// v3: headlights toggle.
    pub const HEADLIGHTS: u8 = 0x80;
}

/// `VehicleWeaponDef.kind`.
pub mod weapon_kind {
    pub const REPEATING_CROSSBOW: u32 = 1;
    /// A war-magic projectile spell launched from a rail (`VehicleWeaponExt::spell_id`).
    pub const MISSILE: u32 = 2;
    /// Free-fall bomb: `damage` = blast damage at the centre, `range` = blast radius, `magazine` = 1.
    pub const BOMB: u32 = 3;
}

/// `VehicleEvent.kind`.
pub mod event_kind {
    pub const TAKEOFF: u32 = 1;
    pub const LANDED: u32 = 2;
    /// Subject = pilot (0 if none); cell / position = impact point.
    pub const CRASHED: u32 = 3;
    pub const DESPAWN: u32 = 4;
    /// Subject = the player who bailed; cell / position = where.
    pub const BAIL: u32 = 5;
    /// Subject = the falling player; the parachute opened.
    pub const CHUTE: u32 = 6;
    /// Subject = the player; back on foot; value = vertical speed at contact.
    pub const TOUCHDOWN: u32 = 7;
    /// Subject = the creature hit by a bolt; value = damage.
    pub const HIT: u32 = 8;
    /// Subject = the pilot; cell / position = release point; value = mass in lb; aux = the station's weapon
    /// index; velocity = the bomb's initial velocity.
    pub const BOMB_RELEASE: u32 = 9;
    /// Subject = the pilot; cell / position = the impact point; value = mass in lb; aux = the station's weapon
    /// index.
    pub const EXPLOSION: u32 = 10;
    /// Subject = the pilot; the vehicle's guns, rails and bomb stations are full again.
    pub const REARMED: u32 = 11;
    /// v3: Horn honk.
    pub const HORN: u32 = 12;
    /// v3: Headlights toggle.
    pub const HEADLIGHTS: u32 = 13;
    /// v3: Body/undercarriage scraping ground.
    pub const SCRAPE: u32 = 14;
    /// v3: Cargo deployed to ground.
    pub const CARGO_DEPLOYED: u32 = 15;
    /// v3: Cargo packed back into vehicle.
    pub const CARGO_PACKED: u32 = 16;
    /// v3: Vehicle bumper ram impact with monster/object.
    pub const RAM_HIT: u32 = 17;
    /// v3: Radar threat alert.
    pub const RADAR_ALERT: u32 = 18;
}

/// `VehicleProfile.part_roles`: the role in the low 16 bits; `ORDNANCE` carries a weapon index in bits 16–23.
pub mod part_role {
    pub const STATIC: u32 = 0;
    /// Spins about the vehicle's forward (y) axis through the part's offset.
    pub const PROPELLER: u32 = 1;
    /// Drawn only while Parked / Takeoff / Landing.
    pub const GEAR: u32 = 2;
    /// Hidden in the cockpit view.
    pub const CANOPY: u32 = 3;
    /// Drawn while its weapon is loaded (`ORDNANCE | (weapon_index << 16)`).
    pub const ORDNANCE: u32 = 4;
    /// v3: Wheel front left.
    pub const WHEEL_FL: u32 = 5;
    /// v3: Wheel front right.
    pub const WHEEL_FR: u32 = 6;
    /// v3: Wheel rear left.
    pub const WHEEL_RL: u32 = 7;
    /// v3: Wheel rear right.
    pub const WHEEL_RR: u32 = 8;
    /// v3: Steering wheel.
    pub const STEERING_WHEEL: u32 = 9;
    /// v3: Tailgate / rear access.
    pub const TAILGATE: u32 = 10;
    /// v3: Cargo stowage.
    pub const CARGO: u32 = 11;
    /// v3: Windscreen.
    pub const WINDSCREEN: u32 = 12;

    /// The `ORDNANCE` role for weapon `index`.
    pub const fn ordnance(index: u8) -> u32 {
        ORDNANCE | ((index as u32) << 16)
    }
    /// The role without its weapon index.
    pub const fn role(value: u32) -> u32 {
        value & 0xFFFF
    }
    /// The weapon index of an `ORDNANCE` role.
    pub const fn weapon_index(value: u32) -> u8 {
        ((value >> 16) & 0xFF) as u8
    }
}

/// Radar contact IFF classification.
pub mod iff_standing {
    pub const UNKNOWN: u8 = 0;
    pub const FRIENDLY: u8 = 1;
    pub const NEUTRAL: u8 = 2;
    pub const HOSTILE: u8 = 3;
}

/// Deployable unit discriminator (WCID mapping).
pub mod deployable_kind {
    pub const NONE: u32 = 0;
    pub const RADAR_STATION: u32 = 1;
    pub const FLUX_POD: u32 = 2;
    pub const SOLAR_PANELS: u32 = 3;
    pub const POWER_GENERATOR: u32 = 4;
    pub const BATTERY_UNIT: u32 = 5;
    pub const MISSILE_TURRET: u32 = 6;
    pub const GROUND_RADAR: u32 = 7;
    pub const MORTAR_TURRET: u32 = 8;
    pub const HEAVY_LASER_TURRET: u32 = 9;
    pub const ISO_CONTAINER_20: u32 = 10;
    pub const ISO_CONTAINER_40: u32 = 11;
    pub const ISO_CONTAINER_40_HC: u32 = 12;
}

/// Standardized industrial pallet footprint.
pub mod pallet_size {
    pub const NONE: u8 = 0;
    pub const HALF: u8 = 1;
    pub const FULL: u8 = 2;
}

/// Deployable weapon classification.
pub mod deployable_weapon_kind {
    pub const NONE: u32 = 0;
    pub const SAM: u32 = 1;
    pub const MORTAR: u32 = 2;
    pub const LASER: u32 = 3;
}

/// Ground radar contact entity type.
pub mod ground_contact_kind {
    pub const UNKNOWN: u8 = 0;
    pub const PLAYER: u8 = 1;
    pub const VEHICLE: u8 = 2;
    pub const MONSTER: u8 = 3;
}

// ---------------------------------------------------------------- primitives

struct Rd<'a> {
    data: &'a [u8],
    off: &'a mut usize,
}

impl Rd<'_> {
    fn take(&mut self, n: usize) -> Option<&[u8]> {
        let end = self.off.checked_add(n)?;
        if end > self.data.len() {
            return None;
        }
        let s = &self.data[*self.off..end];
        *self.off = end;
        Some(s)
    }
    fn u8(&mut self) -> Option<u8> {
        Some(self.take(1)?[0])
    }
    fn i8(&mut self) -> Option<i8> {
        Some(self.take(1)?[0] as i8)
    }
    fn u16(&mut self) -> Option<u16> {
        Some(LittleEndian::read_u16(self.take(2)?))
    }
    fn i16(&mut self) -> Option<i16> {
        Some(LittleEndian::read_i16(self.take(2)?))
    }
    fn u32(&mut self) -> Option<u32> {
        Some(LittleEndian::read_u32(self.take(4)?))
    }
    fn f32(&mut self) -> Option<f32> {
        Some(LittleEndian::read_f32(self.take(4)?))
    }
    fn vec3(&mut self) -> Option<[f32; 3]> {
        Some([self.f32()?, self.f32()?, self.f32()?])
    }
    fn string(&mut self) -> Option<String> {
        read_string16(self.data, self.off)
    }
    /// Bounded list count: each element needs at least `min_elem` bytes, so a hostile count
    /// cannot make us allocate past the payload.
    fn count(&mut self, min_elem: usize) -> Option<usize> {
        let n = self.u32()? as usize;
        let left = self.data.len().saturating_sub(*self.off);
        if n.checked_mul(min_elem)? > left {
            return None;
        }
        Some(n)
    }
}

fn w_vec3(buf: &mut Vec<u8>, v: [f32; 3]) {
    for c in v {
        buf.write_f32::<LittleEndian>(c).unwrap();
    }
}

/// The 8-byte prefix of every HBV1 payload.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VehicleHeader {
    pub tag: u32,
    pub version: u16,
    pub reserved: u16,
}

impl VehicleHeader {
    /// The `HBV1` header this module writes (version [`HBV1_VERSION`]; "V1" is the tag's name, not the version).
    pub const V1: VehicleHeader = VehicleHeader {
        tag: HBV1_TAG,
        version: HBV1_VERSION,
        reserved: 0,
    };

    fn read(r: &mut Rd<'_>) -> Option<Self> {
        let tag = r.u32()?;
        let version = r.u16()?;
        let reserved = r.u16()?;
        if tag != HBV1_TAG || version == 0 {
            return None;
        }
        Some(Self {
            tag,
            version,
            reserved,
        })
    }

    fn write(buf: &mut Vec<u8>) {
        buf.write_u32::<LittleEndian>(HBV1_TAG).unwrap();
        buf.write_u16::<LittleEndian>(HBV1_VERSION).unwrap();
        buf.write_u16::<LittleEndian>(0).unwrap();
    }
}

/// Skip the bytes a newer version appended after the fields this module knows (v2).
fn skip_future(hdr: &VehicleHeader, data: &[u8], offset: &mut usize) {
    if hdr.version > HBV1_VERSION {
        *offset = data.len();
    }
}

// ---------------------------------------------------------------- shared structs

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct VehicleSeatDef {
    pub role: u32,
    pub motion: u32,
    /// Seat position in the vehicle frame (x right, y forward, z up).
    pub offset: [f32; 3],
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct VehicleWeaponDef {
    pub kind: u32,
    pub rounds_per_second: f32,
    /// Half-angle of the spread cone, radians.
    pub spread: f32,
    pub range: f32,
    pub damage: f32,
    pub magazine: u32,
    pub muzzle: [f32; 3],
}

/// v2: per-weapon extras, parallel to `VehicleProfile::weapons` (20 bytes on the wire).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct VehicleWeaponExt {
    /// m/s relative to the vehicle: the quarrel / bolt launch speed.
    pub muzzle_velocity: f32,
    /// m: guns aim at the boresight point this far ahead; 0 = parallel.
    pub convergence: f32,
    /// Bombs.
    pub mass_kg: f32,
    /// m/s: a bomb's terminal velocity.
    pub drag_terminal: f32,
    /// Missiles: the war spell launched.
    pub spell_id: u32,
}

impl VehicleWeaponExt {
    const WIRE: usize = 20;
}

/// One retail Setup / GfxObj of the vehicle's looks, in the vehicle frame.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct VehiclePartDef {
    pub did: u32,
    pub offset: [f32; 3],
    /// W, X, Y, Z.
    pub rotation: [f32; 4],
    pub scale: f32,
}

/// One 30 Hz step of pilot input (12 bytes on the wire).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct VehicleInputFrame {
    pub seq: u32,
    pub throttle: u8,
    pub pitch: i8,
    pub roll: i8,
    pub yaw: i8,
    pub buttons: u8,
    pub reserved: [u8; 3],
}

impl VehicleInputFrame {
    const WIRE: usize = 12;

    fn read(r: &mut Rd<'_>) -> Option<Self> {
        Some(Self {
            seq: r.u32()?,
            throttle: r.u8()?,
            pitch: r.i8()?,
            roll: r.i8()?,
            yaw: r.i8()?,
            buttons: r.u8()?,
            reserved: [r.u8()?, r.u8()?, r.u8()?],
        })
    }

    fn write(&self, buf: &mut Vec<u8>) {
        buf.write_u32::<LittleEndian>(self.seq).unwrap();
        buf.push(self.throttle);
        buf.push(self.pitch as u8);
        buf.push(self.roll as u8);
        buf.push(self.yaw as u8);
        buf.push(self.buttons);
        buf.extend_from_slice(&self.reserved);
    }
}

/// 18 bytes packed radar contact record on the wire.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RadarContactWire {
    pub vehicle_guid: u32,
    pub dx_m: f32,
    pub dy_m: f32,
    pub alt_agl_m: u16,
    pub heading_u8: u8,
    pub standing: u8,
    pub speed_mps_u8: u8,
    pub flags: u8,
}

impl RadarContactWire {
    pub const WIRE: usize = 18;

    fn read(r: &mut Rd<'_>) -> Option<Self> {
        Some(Self {
            vehicle_guid: r.u32()?,
            dx_m: r.f32()?,
            dy_m: r.f32()?,
            alt_agl_m: r.u16()?,
            heading_u8: r.u8()?,
            standing: r.u8()?,
            speed_mps_u8: r.u8()?,
            flags: r.u8()?,
        })
    }

    fn write(&self, buf: &mut Vec<u8>) {
        buf.write_u32::<LittleEndian>(self.vehicle_guid).unwrap();
        buf.write_f32::<LittleEndian>(self.dx_m).unwrap();
        buf.write_f32::<LittleEndian>(self.dy_m).unwrap();
        buf.write_u16::<LittleEndian>(self.alt_agl_m).unwrap();
        buf.push(self.heading_u8);
        buf.push(self.standing);
        buf.push(self.speed_mps_u8);
        buf.push(self.flags);
    }
}

/// 24 bytes packed surface radar contact record on the wire.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct GroundContactWire {
    pub target_guid: u32,
    pub dx_m: f32,
    pub dy_m: f32,
    pub dz_m: f32,
    pub kind: u8,
    pub standing: u8,
    pub heading_u8: u8,
    pub speed_mps_u8: u8,
    pub flags: u8,
    pub reserved0: u8,
    pub reserved1: u8,
    pub reserved2: u8,
}

impl GroundContactWire {
    pub const WIRE: usize = 24;

    fn read(r: &mut Rd<'_>) -> Option<Self> {
        Some(Self {
            target_guid: r.u32()?,
            dx_m: r.f32()?,
            dy_m: r.f32()?,
            dz_m: r.f32()?,
            kind: r.u8()?,
            standing: r.u8()?,
            heading_u8: r.u8()?,
            speed_mps_u8: r.u8()?,
            flags: r.u8()?,
            reserved0: r.u8()?,
            reserved1: r.u8()?,
            reserved2: r.u8()?,
        })
    }

    fn write(&self, buf: &mut Vec<u8>) {
        buf.write_u32::<LittleEndian>(self.target_guid).unwrap();
        buf.write_f32::<LittleEndian>(self.dx_m).unwrap();
        buf.write_f32::<LittleEndian>(self.dy_m).unwrap();
        buf.write_f32::<LittleEndian>(self.dz_m).unwrap();
        buf.push(self.kind);
        buf.push(self.standing);
        buf.push(self.heading_u8);
        buf.push(self.speed_mps_u8);
        buf.push(self.flags);
        buf.push(self.reserved0);
        buf.push(self.reserved1);
        buf.push(self.reserved2);
    }
}

/// 8-byte packed container slot wire record.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ContainerSlotWire {
    pub slot_index: u8,
    pub pallet_size: u8,
    pub sub_slot: u8,
    pub reserved: u8,
    pub cargo_wcid: u32,
}

impl ContainerSlotWire {
    pub const WIRE: usize = 8;

    fn read(r: &mut Rd<'_>) -> Option<Self> {
        Some(Self {
            slot_index: r.u8()?,
            pallet_size: r.u8()?,
            sub_slot: r.u8()?,
            reserved: r.u8()?,
            cargo_wcid: r.u32()?,
        })
    }

    pub fn write(&self, buf: &mut Vec<u8>) {
        buf.push(self.slot_index);
        buf.push(self.pallet_size);
        buf.push(self.sub_slot);
        buf.push(self.reserved);
        buf.write_u32::<LittleEndian>(self.cargo_wcid).unwrap();
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ContainerBayPalletWire {
    pub pallet_guid: u32,
    pub cargo_wcid: u32,
    pub pallet_size: u8,
    pub flags: u8,
    pub health_u8: u8,
    pub slot_hint: u8,
    pub local_x: f32,
    pub local_y: f32,
    pub local_yaw: f32,
    pub fuel_or_ammo: u32,
}

impl ContainerBayPalletWire {
    pub const WIRE: usize = 28;

    fn read(r: &mut Rd<'_>) -> Option<Self> {
        Some(Self {
            pallet_guid: r.u32()?,
            cargo_wcid: r.u32()?,
            pallet_size: r.u8()?,
            flags: r.u8()?,
            health_u8: r.u8()?,
            slot_hint: r.u8()?,
            local_x: r.f32()?,
            local_y: r.f32()?,
            local_yaw: r.f32()?,
            fuel_or_ammo: r.u32()?,
        })
    }

    pub fn write(&self, buf: &mut Vec<u8>) {
        buf.write_u32::<LittleEndian>(self.pallet_guid).unwrap();
        buf.write_u32::<LittleEndian>(self.cargo_wcid).unwrap();
        buf.push(self.pallet_size);
        buf.push(self.flags);
        buf.push(self.health_u8);
        buf.push(self.slot_hint);
        buf.write_f32::<LittleEndian>(self.local_x).unwrap();
        buf.write_f32::<LittleEndian>(self.local_y).unwrap();
        buf.write_f32::<LittleEndian>(self.local_yaw).unwrap();
        buf.write_u32::<LittleEndian>(self.fuel_or_ammo).unwrap();
    }
}

/// Client request for container actions (1=OpenDoors, 2=CloseDoors, 3=Load, 4=Pack, 5=Unpack, 6=UnpackAll).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VehicleContainerAction {
    pub container: u32,
    pub action: u8,
    pub slot_index: u8,
    pub sub_slot: u8,
    pub reserved: u8,
    pub cargo_wcid: u32,
}

impl VehicleContainerAction {
    pub const WIRE: usize = 12;

    fn read(r: &mut Rd<'_>) -> Option<Self> {
        Some(Self {
            container: r.u32()?,
            action: r.u8()?,
            slot_index: r.u8()?,
            sub_slot: r.u8()?,
            reserved: r.u8()?,
            cargo_wcid: r.u32()?,
        })
    }

    pub fn write(&self, buf: &mut Vec<u8>) {
        buf.write_u32::<LittleEndian>(self.container).unwrap();
        buf.push(self.action);
        buf.push(self.slot_index);
        buf.push(self.sub_slot);
        buf.push(self.reserved);
        buf.write_u32::<LittleEndian>(self.cargo_wcid).unwrap();
    }
}

/// Client pallet action request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(C, packed)]
pub struct VehiclePalletAction {
    pub target_guid: u32,
    pub action: u8,
    pub reserved: [u8; 3],
    pub aux: u32,
}

impl VehiclePalletAction {
    pub const WIRE: usize = 12;

    fn read(r: &mut Rd<'_>) -> Option<Self> {
        Some(Self {
            target_guid: r.u32()?,
            action: r.u8()?,
            reserved: [r.u8()?, r.u8()?, r.u8()?],
            aux: r.u32()?,
        })
    }

    pub fn write(&self, buf: &mut Vec<u8>) {
        buf.write_u32::<LittleEndian>(self.target_guid).unwrap();
        buf.push(self.action);
        buf.extend_from_slice(&self.reserved);
        buf.write_u32::<LittleEndian>(self.aux).unwrap();
    }
}

/// Authoritative pallet state broadcast.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(C, packed)]
pub struct VehiclePalletEvent {
    pub target_guid: u32,
    pub action: u8,
    pub reserved: [u8; 3],
    pub aux: u32,
}

impl VehiclePalletEvent {
    pub const WIRE: usize = 12;

    pub fn read(r: &mut Rd<'_>) -> Option<Self> {
        Some(Self {
            target_guid: r.u32()?,
            action: r.u8()?,
            reserved: [r.u8()?, r.u8()?, r.u8()?],
            aux: r.u32()?,
        })
    }

    pub fn write(&self, buf: &mut Vec<u8>) {
        buf.write_u32::<LittleEndian>(self.target_guid).unwrap();
        buf.push(self.action);
        buf.extend_from_slice(&self.reserved);
        buf.write_u32::<LittleEndian>(self.aux).unwrap();
    }
}

// ---------------------------------------------------------------- C2S

/// Client → server vehicle game actions.
#[derive(Debug, Clone, PartialEq)]
pub enum VehicleC2S {
    ClientCapabilities { flags: u32 },
    Board { vehicle: u32, seat: u32 },
    Exit { vehicle: u32, mode: u32 },
    /// Newest frame first, then up to two older ones (redundancy).
    Input { vehicle: u32, frames: Vec<VehicleInputFrame> },
    /// v3: cargo deployment or packing (1=Deploy, 2=Pack); v4: slot, reserved, cargo_wcid.
    Cargo {
        vehicle: u32,
        action: u8,
        target: u32,
        slot: u8,
        reserved0: u8,
        reserved1: u16,
        cargo_wcid: u32,
    },
    /// v5: container action request (1=OpenDoors, 2=CloseDoors, 3=Load, 4=Pack, 5=Unpack, 6=UnpackAll).
    ContainerAction(VehicleContainerAction),
    /// v6: pallet action request.
    PalletAction(VehiclePalletAction),
}

impl VehicleC2S {
    pub fn opcode(&self) -> u32 {
        match self {
            Self::ClientCapabilities { .. } => c2s::CLIENT_CAPABILITIES,
            Self::Board { .. } => c2s::BOARD,
            Self::Exit { .. } => c2s::EXIT,
            Self::Input { .. } => c2s::INPUT,
            Self::Cargo { .. } => c2s::CARGO,
            Self::ContainerAction(_) => c2s::CONTAINER_ACTION,
            Self::PalletAction(_) => c2s::PALLET_ACTION,
        }
    }

    pub fn is_vehicle_opcode(opcode: u32) -> bool {
        matches!(
            opcode,
            c2s::CLIENT_CAPABILITIES
                | c2s::BOARD
                | c2s::EXIT
                | c2s::INPUT
                | c2s::CARGO
                | c2s::CONTAINER_ACTION
                | c2s::PALLET_ACTION
        )
    }

    /// Header + fields (no action opcode).
    pub fn pack_payload(&self, buf: &mut Vec<u8>) {
        VehicleHeader::write(buf);
        match self {
            Self::ClientCapabilities { flags } => {
                buf.write_u32::<LittleEndian>(*flags).unwrap();
            }
            Self::Board { vehicle, seat } => {
                buf.write_u32::<LittleEndian>(*vehicle).unwrap();
                buf.write_u32::<LittleEndian>(*seat).unwrap();
            }
            Self::Exit { vehicle, mode } => {
                buf.write_u32::<LittleEndian>(*vehicle).unwrap();
                buf.write_u32::<LittleEndian>(*mode).unwrap();
            }
            Self::Input { vehicle, frames } => {
                buf.write_u32::<LittleEndian>(*vehicle).unwrap();
                buf.write_u32::<LittleEndian>(frames.len() as u32).unwrap();
                for f in frames {
                    f.write(buf);
                }
            }
            Self::Cargo {
                vehicle,
                action,
                target,
                slot,
                reserved0,
                reserved1,
                cargo_wcid,
            } => {
                buf.write_u32::<LittleEndian>(*vehicle).unwrap();
                buf.push(*action);
                buf.write_u32::<LittleEndian>(*target).unwrap();
                // v4
                buf.push(*slot);
                buf.push(*reserved0);
                buf.write_u16::<LittleEndian>(*reserved1).unwrap();
                buf.write_u32::<LittleEndian>(*cargo_wcid).unwrap();
            }
            Self::ContainerAction(ca) => {
                ca.write(buf);
            }
            Self::PalletAction(pa) => {
                pa.write(buf);
            }
        }
    }

    /// `None` = not a vehicle opcode, a bad tag, or truncated.
    pub fn unpack_payload(opcode: u32, data: &[u8], offset: &mut usize) -> Option<Self> {
        let start = *offset;
        let res = Self::unpack_inner(opcode, data, offset);
        if res.is_none() {
            *offset = start;
        }
        res
    }

    fn unpack_inner(opcode: u32, data: &[u8], offset: &mut usize) -> Option<Self> {
        let hdr;
        let msg = {
            let mut r = Rd { data, off: &mut *offset };
            hdr = VehicleHeader::read(&mut r)?;
            match opcode {
                c2s::CLIENT_CAPABILITIES => Self::ClientCapabilities { flags: r.u32()? },
                c2s::BOARD => Self::Board {
                    vehicle: r.u32()?,
                    seat: r.u32()?,
                },
                c2s::EXIT => Self::Exit {
                    vehicle: r.u32()?,
                    mode: r.u32()?,
                },
                c2s::INPUT => {
                    let vehicle = r.u32()?;
                    let n = r.count(VehicleInputFrame::WIRE)?;
                    let mut frames = Vec::with_capacity(n);
                    for _ in 0..n {
                        frames.push(VehicleInputFrame::read(&mut r)?);
                    }
                    Self::Input { vehicle, frames }
                }
                c2s::CARGO => {
                    let vehicle = r.u32()?;
                    let action = r.u8()?;
                    let target = r.u32()?;
                    let v4 = hdr.version >= V4;
                    let slot = if v4 { r.u8()? } else { 0 };
                    let reserved0 = if v4 { r.u8()? } else { 0 };
                    let reserved1 = if v4 { r.u16()? } else { 0 };
                    let cargo_wcid = if v4 { r.u32()? } else { 0 };
                    Self::Cargo {
                        vehicle,
                        action,
                        target,
                        slot,
                        reserved0,
                        reserved1,
                        cargo_wcid,
                    }
                }
                c2s::CONTAINER_ACTION => {
                    Self::ContainerAction(VehicleContainerAction::read(&mut r)?)
                }
                c2s::PALLET_ACTION => {
                    Self::PalletAction(VehiclePalletAction::read(&mut r)?)
                }
                _ => return None,
            }
        };
        skip_future(&hdr, data, offset);
        Some(msg)
    }
}

// ---------------------------------------------------------------- S2C

#[derive(Debug, Clone, PartialEq)]
pub struct VehicleProfile {
    pub vehicle: u32,
    pub profile_key: String,
    pub display_name: String,
    pub locomotion: u32,
    pub stand_in_setup: u32,
    pub sim_hz: u16,
    pub reserved: u16,
    pub v_min: f32,
    pub v_cruise: f32,
    pub v_max: f32,
    pub speed_cap: f32,
    pub accel: f32,
    pub decel: f32,
    pub max_bank: f32,
    pub roll_rate: f32,
    pub max_pitch: f32,
    pub pitch_rate: f32,
    pub yaw_rate: f32,
    pub climb_max: f32,
    pub sink_max: f32,
    pub floor_agl: f32,
    pub ceiling_agl: f32,
    pub takeoff_climb: f32,
    pub landing_speed: f32,
    pub lead_seconds: f32,
    pub object_radius: u32,
    pub seats: Vec<VehicleSeatDef>,
    pub weapons: Vec<VehicleWeaponDef>,
    pub parts: Vec<VehiclePartDef>,
    /// v2: a [`part_role`] per part, in `parts` order (empty, or `parts.len()`).
    pub part_roles: Vec<u32>,
    /// v2: one per weapon, in `weapons` order (empty, or `weapons.len()`).
    pub weapon_ext: Vec<VehicleWeaponExt>,
    /// v3: ground dynamics (SI units, radians).
    pub wheelbase: f32,
    pub track_width: f32,
    pub wheel_radius: f32,
    pub max_steer_rad: f32,
    pub reverse_max: f32,
    pub climb_limit_cos: f32,
    pub ford_depth_max: f32,
    pub cargo_wcid: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VehicleSeat {
    pub vehicle: u32,
    pub seat: u32,
    pub occupant: u32,
    pub state: u32,
    pub reason: u32,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct VehicleState {
    pub vehicle: u32,
    pub step: u32,
    pub ack_input_seq: u32,
    pub cell: u32,
    /// Landblock-local.
    pub position: [f32; 3],
    pub heading: f32,
    pub pitch: f32,
    pub bank: f32,
    pub speed: f32,
    pub v_cap: f32,
    /// Rounds left across all gun mounts.
    pub ammo: u16,
    pub mode: u8,
    pub flags: u8,
    /// v2: bit i = the i-th Missile weapon in profile order is loaded.
    pub missile_mask: u8,
    /// v2: bit i = the i-th Bomb weapon is loaded.
    pub bomb_mask: u8,
    /// v2.
    pub reserved2: u16,
    /// v3: ground telemetry.
    pub steer_angle: f32,
    pub ground_flags: u8,
    pub surface_family: u8,
    pub wheel_spin_q16: i16,
    /// v4: bitmask: 0x01=slot 0 loaded, 0x02=slot 1 loaded, 0x04=full pallet.
    pub cargo_mask: u8,
    /// v4: PalletSize.
    pub pallet_size0: u8,
    /// v4: PalletSize.
    pub pallet_size1: u8,
    /// v4.
    pub reserved3: u8,
    /// v4: WCID in slot 0 or full pallet.
    pub cargo_slot0_wcid: u32,
    /// v4: WCID in slot 1.
    pub cargo_slot1_wcid: u32,
    /// v6: 0..255 -> 0.0..1.0, z_fork = 0.075 + 0.120 * liftNorm.
    pub lift_norm_u8: u8,
    /// v6: 0..255 -> handle pump animation phase.
    pub pump_phase_u8: u8,
    /// v6: 0..255 -> wood bind/slat stress warning telemetry.
    pub fork_stress_u8: u8,
    /// v6: 0x01=ForksEngaged, 0x02=LoadLifted, 0x04=RollerOnSlat, 0x08=HighCentered, 0x10=LoadBroken, 0x20=ProngsPokedThrough.
    pub jack_flags: u8,
    /// v6: 0 when empty or forks sliding loose.
    pub carried_pallet_guid: u32,
    /// v6: 0.0..1.2192 m insertion depth into engaged pallet.
    pub fork_insert_m: f32,
    /// v6: relative orientation of pallet on forks: 0, ±π/2, π + crooked bind offset.
    pub carried_rel_yaw: f32,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct VehicleFire {
    pub vehicle: u32,
    pub step: u32,
    pub mount: u16,
    pub count: u16,
    pub cell: u32,
    pub muzzle: [f32; 3],
    /// Unit direction × 32767.
    pub dir: [i16; 3],
    pub reserved: u16,
    pub seed: u32,
    /// v2: mounts `mount .. mount + mount_count` each fired `count` rounds this step (1 for a v1 payload).
    pub mount_count: u16,
    /// v2.
    pub reserved2: u16,
    /// v2: m/s, the rounds' speed over the ground (for drawing).
    pub speed: f32,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct VehicleEvent {
    pub vehicle: u32,
    pub kind: u32,
    pub step: u32,
    pub subject: u32,
    pub cell: u32,
    pub position: [f32; 3],
    pub value: f32,
    /// v2: per kind (BombRelease / Explosion: the station's weapon index).
    pub aux: u32,
    /// v2: per kind (BombRelease: the bomb's initial velocity, m/s).
    pub velocity: [f32; 3],
}

/// v3: Server 1 Hz compact radar sweep broadcast.
#[derive(Debug, Clone, PartialEq)]
pub struct VehicleRadarContacts {
    pub radar_guid: u32,
    pub parent_vehicle: u32,
    pub radar_x: f32,
    pub radar_y: f32,
    pub radar_z: f32,
    pub range_m: f32,
    pub ceiling_m: f32,
    pub contacts: Vec<RadarContactWire>,
}

/// v4: Authoritative state of deployed units (84 bytes payload).
#[derive(Debug, Clone, PartialEq)]
pub struct VehicleDeployableState {
    pub deployable_guid: u32,
    pub deployable_kind: u32,
    pub pallet_size: u8,
    pub online_flags: u8,
    pub ammo_remaining: u16,
    pub owner_guid: u32,
    pub parent_vehicle: u32,
    pub cell: u32,
    pub position: [f32; 3],
    pub heading: f32,
    pub power_watts: f32,
    pub energy_stored_joules: f32,
    pub energy_capacity_joules: f32,
    pub fuel_remaining: f32,
    pub pitch_rad: f32,
    pub yaw_rad: f32,
    pub roll_rad: f32,
    pub elevation_m: f32,
}

/// v4: Deployable weapon discharge event (68 bytes payload).
#[derive(Debug, Clone, PartialEq)]
pub struct VehicleDeployableFire {
    pub deployable_guid: u32,
    pub weapon_kind: u32,
    pub step: u32,
    pub target_guid: u32,
    pub cell: u32,
    pub muzzle: [f32; 3],
    pub target_pos: [f32; 3],
    pub velocity: [f32; 3],
    pub energy_joules: f32,
    pub burst_count: u16,
    pub reserved: u16,
}

/// v4: Ground radar 30 RPM surface sweep broadcast.
#[derive(Debug, Clone, PartialEq)]
pub struct VehicleGroundContacts {
    pub radar_guid: u32,
    pub parent_vehicle: u32,
    pub radar_x: f32,
    pub radar_y: f32,
    pub radar_z: f32,
    pub range_m: f32,
    pub sweep_angle_rad: f32,
    pub contacts: Vec<GroundContactWire>,
}

/// v5: Authoritative state of ISO shipping containers (telemetry, doors, loaded slots).
#[derive(Debug, Clone, PartialEq)]
pub struct VehicleContainerState {
    pub container_guid: u32,
    pub container_kind: u32,
    pub door_state: u8,
    pub livery_id: u8,
    pub max_full_slots: u8,
    pub flags: u8,
    pub owner_guid: u32,
    pub cell: u32,
    pub position: [f32; 3],
    pub heading: f32,
    pub door_progress: f32,
    pub serial_number: u32,
    pub slots: Vec<ContainerSlotWire>,
    pub bay_pallets: Vec<ContainerBayPalletWire>,
}

impl VehicleContainerState {
    fn read(r: &mut Rd<'_>, hdr: &VehicleHeader) -> Option<Self> {
        let container_guid = r.u32()?;
        let container_kind = r.u32()?;
        let door_state = r.u8()?;
        let livery_id = r.u8()?;
        let max_full_slots = r.u8()?;
        let flags = r.u8()?;
        let owner_guid = r.u32()?;
        let cell = r.u32()?;
        let position = r.vec3()?;
        let heading = r.f32()?;
        let door_progress = r.f32()?;
        let serial_number = r.u32()?;
        let n = r.count(ContainerSlotWire::WIRE)?;
        let mut slots = Vec::with_capacity(n);
        for _ in 0..n {
            slots.push(ContainerSlotWire::read(r)?);
        }
        let bay_pallets = if hdr.version >= V6 {
            let n = r.count(ContainerBayPalletWire::WIRE)?;
            let mut pallets = Vec::with_capacity(n);
            for _ in 0..n {
                pallets.push(ContainerBayPalletWire::read(r)?);
            }
            pallets
        } else {
            Vec::new()
        };
        Some(Self {
            container_guid,
            container_kind,
            door_state,
            livery_id,
            max_full_slots,
            flags,
            owner_guid,
            cell,
            position,
            heading,
            door_progress,
            serial_number,
            slots,
            bay_pallets,
        })
    }

    pub fn write(&self, buf: &mut Vec<u8>) {
        buf.write_u32::<LittleEndian>(self.container_guid).unwrap();
        buf.write_u32::<LittleEndian>(self.container_kind).unwrap();
        buf.push(self.door_state);
        buf.push(self.livery_id);
        buf.push(self.max_full_slots);
        buf.push(self.flags);
        buf.write_u32::<LittleEndian>(self.owner_guid).unwrap();
        buf.write_u32::<LittleEndian>(self.cell).unwrap();
        w_vec3(buf, self.position);
        buf.write_f32::<LittleEndian>(self.heading).unwrap();
        buf.write_f32::<LittleEndian>(self.door_progress).unwrap();
        buf.write_u32::<LittleEndian>(self.serial_number).unwrap();
        buf.write_u32::<LittleEndian>(self.slots.len() as u32).unwrap();
        for s in &self.slots {
            s.write(buf);
        }
        buf.write_u32::<LittleEndian>(self.bay_pallets.len() as u32).unwrap();
        for p in &self.bay_pallets {
            p.write(buf);
        }
    }
}

/// Server → client vehicle game events.
#[derive(Debug, Clone, PartialEq)]
pub enum VehicleS2C {
    CapabilitiesAck {
        granted: u32,
        sim_hz: u16,
        reserved: u16,
    },
    Profile(Box<VehicleProfile>),
    Seat(VehicleSeat),
    State(VehicleState),
    Fire(VehicleFire),
    Event(VehicleEvent),
    RadarContacts(VehicleRadarContacts),
    DeployableState(VehicleDeployableState),
    DeployableFire(VehicleDeployableFire),
    GroundContacts(VehicleGroundContacts),
    ContainerState(VehicleContainerState),
    PalletEvent(VehiclePalletEvent),
}

impl VehicleS2C {
    pub fn opcode(&self) -> u32 {
        match self {
            Self::CapabilitiesAck { .. } => s2c::CAPABILITIES_ACK,
            Self::Profile(_) => s2c::PROFILE,
            Self::Seat(_) => s2c::SEAT,
            Self::State(_) => s2c::STATE,
            Self::Fire(_) => s2c::FIRE,
            Self::Event(_) => s2c::EVENT,
            Self::RadarContacts(_) => s2c::RADAR_CONTACTS,
            Self::DeployableState(_) => s2c::DEPLOYABLE_STATE,
            Self::DeployableFire(_) => s2c::DEPLOYABLE_FIRE,
            Self::GroundContacts(_) => s2c::GROUND_CONTACTS,
            Self::ContainerState(_) => s2c::CONTAINER_STATE,
            Self::PalletEvent(_) => s2c::PALLET_EVENT,
        }
    }

    pub fn is_vehicle_opcode(opcode: u32) -> bool {
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
                | s2c::PALLET_EVENT
        )
    }

    /// Header + fields (no event opcode).
    pub fn pack_payload(&self, buf: &mut Vec<u8>) {
        VehicleHeader::write(buf);
        match self {
            Self::CapabilitiesAck {
                granted,
                sim_hz,
                reserved,
            } => {
                buf.write_u32::<LittleEndian>(*granted).unwrap();
                buf.write_u16::<LittleEndian>(*sim_hz).unwrap();
                buf.write_u16::<LittleEndian>(*reserved).unwrap();
            }
            Self::Profile(p) => {
                buf.write_u32::<LittleEndian>(p.vehicle).unwrap();
                write_string16(buf, &p.profile_key);
                write_string16(buf, &p.display_name);
                buf.write_u32::<LittleEndian>(p.locomotion).unwrap();
                buf.write_u32::<LittleEndian>(p.stand_in_setup).unwrap();
                buf.write_u16::<LittleEndian>(p.sim_hz).unwrap();
                buf.write_u16::<LittleEndian>(p.reserved).unwrap();
                for v in [
                    p.v_min,
                    p.v_cruise,
                    p.v_max,
                    p.speed_cap,
                    p.accel,
                    p.decel,
                    p.max_bank,
                    p.roll_rate,
                    p.max_pitch,
                    p.pitch_rate,
                    p.yaw_rate,
                    p.climb_max,
                    p.sink_max,
                    p.floor_agl,
                    p.ceiling_agl,
                    p.takeoff_climb,
                    p.landing_speed,
                    p.lead_seconds,
                ] {
                    buf.write_f32::<LittleEndian>(v).unwrap();
                }
                buf.write_u32::<LittleEndian>(p.object_radius).unwrap();
                buf.write_u32::<LittleEndian>(p.seats.len() as u32).unwrap();
                for s in &p.seats {
                    buf.write_u32::<LittleEndian>(s.role).unwrap();
                    buf.write_u32::<LittleEndian>(s.motion).unwrap();
                    w_vec3(buf, s.offset);
                }
                buf.write_u32::<LittleEndian>(p.weapons.len() as u32).unwrap();
                for w in &p.weapons {
                    buf.write_u32::<LittleEndian>(w.kind).unwrap();
                    buf.write_f32::<LittleEndian>(w.rounds_per_second).unwrap();
                    buf.write_f32::<LittleEndian>(w.spread).unwrap();
                    buf.write_f32::<LittleEndian>(w.range).unwrap();
                    buf.write_f32::<LittleEndian>(w.damage).unwrap();
                    buf.write_u32::<LittleEndian>(w.magazine).unwrap();
                    w_vec3(buf, w.muzzle);
                }
                buf.write_u32::<LittleEndian>(p.parts.len() as u32).unwrap();
                for part in &p.parts {
                    buf.write_u32::<LittleEndian>(part.did).unwrap();
                    w_vec3(buf, part.offset);
                    for c in part.rotation {
                        buf.write_f32::<LittleEndian>(c).unwrap();
                    }
                    buf.write_f32::<LittleEndian>(part.scale).unwrap();
                }
                // v2
                buf.write_u32::<LittleEndian>(p.part_roles.len() as u32).unwrap();
                for role in &p.part_roles {
                    buf.write_u32::<LittleEndian>(*role).unwrap();
                }
                buf.write_u32::<LittleEndian>(p.weapon_ext.len() as u32).unwrap();
                for x in &p.weapon_ext {
                    for v in [x.muzzle_velocity, x.convergence, x.mass_kg, x.drag_terminal] {
                        buf.write_f32::<LittleEndian>(v).unwrap();
                    }
                    buf.write_u32::<LittleEndian>(x.spell_id).unwrap();
                }
                // v3
                for v in [
                    p.wheelbase,
                    p.track_width,
                    p.wheel_radius,
                    p.max_steer_rad,
                    p.reverse_max,
                    p.climb_limit_cos,
                    p.ford_depth_max,
                ] {
                    buf.write_f32::<LittleEndian>(v).unwrap();
                }
                buf.write_u32::<LittleEndian>(p.cargo_wcid).unwrap();
            }
            Self::Seat(s) => {
                for v in [s.vehicle, s.seat, s.occupant, s.state, s.reason] {
                    buf.write_u32::<LittleEndian>(v).unwrap();
                }
            }
            Self::State(s) => {
                buf.write_u32::<LittleEndian>(s.vehicle).unwrap();
                buf.write_u32::<LittleEndian>(s.step).unwrap();
                buf.write_u32::<LittleEndian>(s.ack_input_seq).unwrap();
                buf.write_u32::<LittleEndian>(s.cell).unwrap();
                w_vec3(buf, s.position);
                for v in [s.heading, s.pitch, s.bank, s.speed, s.v_cap] {
                    buf.write_f32::<LittleEndian>(v).unwrap();
                }
                buf.write_u16::<LittleEndian>(s.ammo).unwrap();
                buf.push(s.mode);
                buf.push(s.flags);
                // v2
                buf.push(s.missile_mask);
                buf.push(s.bomb_mask);
                buf.write_u16::<LittleEndian>(s.reserved2).unwrap();
                // v3
                buf.write_f32::<LittleEndian>(s.steer_angle).unwrap();
                buf.push(s.ground_flags);
                buf.push(s.surface_family);
                buf.write_i16::<LittleEndian>(s.wheel_spin_q16).unwrap();
                // v4
                buf.push(s.cargo_mask);
                buf.push(s.pallet_size0);
                buf.push(s.pallet_size1);
                buf.push(s.reserved3);
                buf.write_u32::<LittleEndian>(s.cargo_slot0_wcid).unwrap();
                buf.write_u32::<LittleEndian>(s.cargo_slot1_wcid).unwrap();
                // v6
                buf.push(s.lift_norm_u8);
                buf.push(s.pump_phase_u8);
                buf.push(s.fork_stress_u8);
                buf.push(s.jack_flags);
                buf.write_u32::<LittleEndian>(s.carried_pallet_guid).unwrap();
                buf.write_f32::<LittleEndian>(s.fork_insert_m).unwrap();
                buf.write_f32::<LittleEndian>(s.carried_rel_yaw).unwrap();
            }
            Self::Fire(f) => {
                buf.write_u32::<LittleEndian>(f.vehicle).unwrap();
                buf.write_u32::<LittleEndian>(f.step).unwrap();
                buf.write_u16::<LittleEndian>(f.mount).unwrap();
                buf.write_u16::<LittleEndian>(f.count).unwrap();
                buf.write_u32::<LittleEndian>(f.cell).unwrap();
                w_vec3(buf, f.muzzle);
                for c in f.dir {
                    buf.write_i16::<LittleEndian>(c).unwrap();
                }
                buf.write_u16::<LittleEndian>(f.reserved).unwrap();
                buf.write_u32::<LittleEndian>(f.seed).unwrap();
                // v2
                buf.write_u16::<LittleEndian>(f.mount_count).unwrap();
                buf.write_u16::<LittleEndian>(f.reserved2).unwrap();
                buf.write_f32::<LittleEndian>(f.speed).unwrap();
            }
            Self::Event(e) => {
                for v in [e.vehicle, e.kind, e.step, e.subject, e.cell] {
                    buf.write_u32::<LittleEndian>(v).unwrap();
                }
                w_vec3(buf, e.position);
                buf.write_f32::<LittleEndian>(e.value).unwrap();
                // v2
                buf.write_u32::<LittleEndian>(e.aux).unwrap();
                w_vec3(buf, e.velocity);
            }
            Self::RadarContacts(rc) => {
                buf.write_u32::<LittleEndian>(rc.radar_guid).unwrap();
                buf.write_u32::<LittleEndian>(rc.parent_vehicle).unwrap();
                buf.write_f32::<LittleEndian>(rc.radar_x).unwrap();
                buf.write_f32::<LittleEndian>(rc.radar_y).unwrap();
                buf.write_f32::<LittleEndian>(rc.radar_z).unwrap();
                buf.write_f32::<LittleEndian>(rc.range_m).unwrap();
                buf.write_f32::<LittleEndian>(rc.ceiling_m).unwrap();
                buf.write_u32::<LittleEndian>(rc.contacts.len() as u32).unwrap();
                for c in &rc.contacts {
                    c.write(buf);
                }
            }
            Self::DeployableState(ds) => {
                buf.write_u32::<LittleEndian>(ds.deployable_guid).unwrap();
                buf.write_u32::<LittleEndian>(ds.deployable_kind).unwrap();
                buf.push(ds.pallet_size);
                buf.push(ds.online_flags);
                buf.write_u16::<LittleEndian>(ds.ammo_remaining).unwrap();
                buf.write_u32::<LittleEndian>(ds.owner_guid).unwrap();
                buf.write_u32::<LittleEndian>(ds.parent_vehicle).unwrap();
                buf.write_u32::<LittleEndian>(ds.cell).unwrap();
                w_vec3(buf, ds.position);
                for v in [
                    ds.heading,
                    ds.power_watts,
                    ds.energy_stored_joules,
                    ds.energy_capacity_joules,
                    ds.fuel_remaining,
                    ds.pitch_rad,
                    ds.yaw_rad,
                    ds.roll_rad,
                    ds.elevation_m,
                ] {
                    buf.write_f32::<LittleEndian>(v).unwrap();
                }
            }
            Self::DeployableFire(df) => {
                buf.write_u32::<LittleEndian>(df.deployable_guid).unwrap();
                buf.write_u32::<LittleEndian>(df.weapon_kind).unwrap();
                buf.write_u32::<LittleEndian>(df.step).unwrap();
                buf.write_u32::<LittleEndian>(df.target_guid).unwrap();
                buf.write_u32::<LittleEndian>(df.cell).unwrap();
                w_vec3(buf, df.muzzle);
                w_vec3(buf, df.target_pos);
                w_vec3(buf, df.velocity);
                buf.write_f32::<LittleEndian>(df.energy_joules).unwrap();
                buf.write_u16::<LittleEndian>(df.burst_count).unwrap();
                buf.write_u16::<LittleEndian>(df.reserved).unwrap();
            }
            Self::GroundContacts(gc) => {
                buf.write_u32::<LittleEndian>(gc.radar_guid).unwrap();
                buf.write_u32::<LittleEndian>(gc.parent_vehicle).unwrap();
                buf.write_f32::<LittleEndian>(gc.radar_x).unwrap();
                buf.write_f32::<LittleEndian>(gc.radar_y).unwrap();
                buf.write_f32::<LittleEndian>(gc.radar_z).unwrap();
                buf.write_f32::<LittleEndian>(gc.range_m).unwrap();
                buf.write_f32::<LittleEndian>(gc.sweep_angle_rad).unwrap();
                buf.write_u32::<LittleEndian>(gc.contacts.len() as u32).unwrap();
                for c in &gc.contacts {
                    c.write(buf);
                }
            }
            Self::ContainerState(cs) => {
                cs.write(buf);
            }
            Self::PalletEvent(pe) => {
                pe.write(buf);
            }
        }
    }

    /// `None` = not a vehicle opcode, a bad tag, or truncated (offset restored).
    pub fn unpack_payload(opcode: u32, data: &[u8], offset: &mut usize) -> Option<Self> {
        let start = *offset;
        let res = Self::unpack_inner(opcode, data, offset);
        if res.is_none() {
            *offset = start;
        }
        res
    }

    fn unpack_inner(opcode: u32, data: &[u8], offset: &mut usize) -> Option<Self> {
        let hdr;
        let msg = {
            let mut r = Rd { data, off: &mut *offset };
            hdr = VehicleHeader::read(&mut r)?;
            // v1 payloads end before the v2 fields: those keep their defaults
            let v2 = hdr.version >= V2;
            let v3 = hdr.version >= V3;
            let v4 = hdr.version >= V4;
            let _v5 = hdr.version >= V5;
            let v6 = hdr.version >= V6;
            match opcode {
                s2c::CAPABILITIES_ACK => Self::CapabilitiesAck {
                    granted: r.u32()?,
                    sim_hz: r.u16()?,
                    reserved: r.u16()?,
                },
                s2c::PROFILE => {
                    let vehicle = r.u32()?;
                    let profile_key = r.string()?;
                    let display_name = r.string()?;
                    let locomotion = r.u32()?;
                    let stand_in_setup = r.u32()?;
                    let sim_hz = r.u16()?;
                    let reserved = r.u16()?;
                    let mut f = [0f32; 18];
                    for slot in f.iter_mut() {
                        *slot = r.f32()?;
                    }
                    let object_radius = r.u32()?;
                    let n = r.count(20)?;
                    let mut seats = Vec::with_capacity(n);
                    for _ in 0..n {
                        seats.push(VehicleSeatDef {
                            role: r.u32()?,
                            motion: r.u32()?,
                            offset: r.vec3()?,
                        });
                    }
                    let n = r.count(36)?;
                    let mut weapons = Vec::with_capacity(n);
                    for _ in 0..n {
                        weapons.push(VehicleWeaponDef {
                            kind: r.u32()?,
                            rounds_per_second: r.f32()?,
                            spread: r.f32()?,
                            range: r.f32()?,
                            damage: r.f32()?,
                            magazine: r.u32()?,
                            muzzle: r.vec3()?,
                        });
                    }
                    let n = r.count(36)?;
                    let mut parts = Vec::with_capacity(n);
                    for _ in 0..n {
                        parts.push(VehiclePartDef {
                            did: r.u32()?,
                            offset: r.vec3()?,
                            rotation: [r.f32()?, r.f32()?, r.f32()?, r.f32()?],
                            scale: r.f32()?,
                        });
                    }
                    let mut part_roles = Vec::new();
                    let mut weapon_ext = Vec::new();
                    if v2 {
                        let n = r.count(4)?;
                        part_roles.reserve(n);
                        for _ in 0..n {
                            part_roles.push(r.u32()?);
                        }
                        let n = r.count(VehicleWeaponExt::WIRE)?;
                        weapon_ext.reserve(n);
                        for _ in 0..n {
                            weapon_ext.push(VehicleWeaponExt {
                                muzzle_velocity: r.f32()?,
                                convergence: r.f32()?,
                                mass_kg: r.f32()?,
                                drag_terminal: r.f32()?,
                                spell_id: r.u32()?,
                            });
                        }
                    }
                    let wheelbase = if v3 { r.f32()? } else { 0.0 };
                    let track_width = if v3 { r.f32()? } else { 0.0 };
                    let wheel_radius = if v3 { r.f32()? } else { 0.0 };
                    let max_steer_rad = if v3 { r.f32()? } else { 0.0 };
                    let reverse_max = if v3 { r.f32()? } else { 0.0 };
                    let climb_limit_cos = if v3 { r.f32()? } else { 0.0 };
                    let ford_depth_max = if v3 { r.f32()? } else { 0.0 };
                    let cargo_wcid = if v3 { r.u32()? } else { 0 };
                    Self::Profile(Box::new(VehicleProfile {
                        vehicle,
                        profile_key,
                        display_name,
                        locomotion,
                        stand_in_setup,
                        sim_hz,
                        reserved,
                        v_min: f[0],
                        v_cruise: f[1],
                        v_max: f[2],
                        speed_cap: f[3],
                        accel: f[4],
                        decel: f[5],
                        max_bank: f[6],
                        roll_rate: f[7],
                        max_pitch: f[8],
                        pitch_rate: f[9],
                        yaw_rate: f[10],
                        climb_max: f[11],
                        sink_max: f[12],
                        floor_agl: f[13],
                        ceiling_agl: f[14],
                        takeoff_climb: f[15],
                        landing_speed: f[16],
                        lead_seconds: f[17],
                        object_radius,
                        seats,
                        weapons,
                        parts,
                        part_roles,
                        weapon_ext,
                        wheelbase,
                        track_width,
                        wheel_radius,
                        max_steer_rad,
                        reverse_max,
                        climb_limit_cos,
                        ford_depth_max,
                        cargo_wcid,
                    }))
                }
                s2c::SEAT => Self::Seat(VehicleSeat {
                    vehicle: r.u32()?,
                    seat: r.u32()?,
                    occupant: r.u32()?,
                    state: r.u32()?,
                    reason: r.u32()?,
                }),
                s2c::STATE => Self::State(VehicleState {
                    vehicle: r.u32()?,
                    step: r.u32()?,
                    ack_input_seq: r.u32()?,
                    cell: r.u32()?,
                    position: r.vec3()?,
                    heading: r.f32()?,
                    pitch: r.f32()?,
                    bank: r.f32()?,
                    speed: r.f32()?,
                    v_cap: r.f32()?,
                    ammo: r.u16()?,
                    mode: r.u8()?,
                    flags: r.u8()?,
                    // struct-literal fields evaluate in source order: the v2 tail follows `flags`
                    missile_mask: if v2 { r.u8()? } else { 0 },
                    bomb_mask: if v2 { r.u8()? } else { 0 },
                    reserved2: if v2 { r.u16()? } else { 0 },
                    // v3 tail
                    steer_angle: if v3 { r.f32()? } else { 0.0 },
                    ground_flags: if v3 { r.u8()? } else { 0 },
                    surface_family: if v3 { r.u8()? } else { 0 },
                    wheel_spin_q16: if v3 { r.i16()? } else { 0 },
                    // v4 tail
                    cargo_mask: if v4 { r.u8()? } else { 0 },
                    pallet_size0: if v4 { r.u8()? } else { 0 },
                    pallet_size1: if v4 { r.u8()? } else { 0 },
                    reserved3: if v4 { r.u8()? } else { 0 },
                    cargo_slot0_wcid: if v4 { r.u32()? } else { 0 },
                    cargo_slot1_wcid: if v4 { r.u32()? } else { 0 },
                    lift_norm_u8: if v6 { r.u8()? } else { 0 },
                    pump_phase_u8: if v6 { r.u8()? } else { 0 },
                    fork_stress_u8: if v6 { r.u8()? } else { 0 },
                    jack_flags: if v6 { r.u8()? } else { 0 },
                    carried_pallet_guid: if v6 { r.u32()? } else { 0 },
                    fork_insert_m: if v6 { r.f32()? } else { 0.0 },
                    carried_rel_yaw: if v6 { r.f32()? } else { 0.0 },
                }),
                s2c::FIRE => Self::Fire(VehicleFire {
                    vehicle: r.u32()?,
                    step: r.u32()?,
                    mount: r.u16()?,
                    count: r.u16()?,
                    cell: r.u32()?,
                    muzzle: r.vec3()?,
                    dir: [r.i16()?, r.i16()?, r.i16()?],
                    reserved: r.u16()?,
                    seed: r.u32()?,
                    mount_count: if v2 { r.u16()? } else { 1 },
                    reserved2: if v2 { r.u16()? } else { 0 },
                    speed: if v2 { r.f32()? } else { 0.0 },
                }),
                s2c::EVENT => Self::Event(VehicleEvent {
                    vehicle: r.u32()?,
                    kind: r.u32()?,
                    step: r.u32()?,
                    subject: r.u32()?,
                    cell: r.u32()?,
                    position: r.vec3()?,
                    value: r.f32()?,
                    aux: if v2 { r.u32()? } else { 0 },
                    velocity: if v2 { r.vec3()? } else { [0.0; 3] },
                }),
                s2c::RADAR_CONTACTS => {
                    let radar_guid = r.u32()?;
                    let parent_vehicle = r.u32()?;
                    let radar_x = r.f32()?;
                    let radar_y = r.f32()?;
                    let radar_z = r.f32()?;
                    let range_m = r.f32()?;
                    let ceiling_m = r.f32()?;
                    let n = r.count(RadarContactWire::WIRE)?;
                    let mut contacts = Vec::with_capacity(n);
                    for _ in 0..n {
                        contacts.push(RadarContactWire::read(&mut r)?);
                    }
                    Self::RadarContacts(VehicleRadarContacts {
                        radar_guid,
                        parent_vehicle,
                        radar_x,
                        radar_y,
                        radar_z,
                        range_m,
                        ceiling_m,
                        contacts,
                    })
                }
                s2c::DEPLOYABLE_STATE => {
                    let deployable_guid = r.u32()?;
                    let deployable_kind = r.u32()?;
                    let pallet_size = r.u8()?;
                    let online_flags = r.u8()?;
                    let ammo_remaining = r.u16()?;
                    let owner_guid = r.u32()?;
                    let parent_vehicle = r.u32()?;
                    let cell = r.u32()?;
                    let position = r.vec3()?;
                    let heading = r.f32()?;
                    let power_watts = r.f32()?;
                    let energy_stored_joules = r.f32()?;
                    let energy_capacity_joules = r.f32()?;
                    let fuel_remaining = r.f32()?;
                    let pitch_rad = r.f32()?;
                    let yaw_rad = r.f32()?;
                    let roll_rad = r.f32()?;
                    let elevation_m = r.f32()?;
                    Self::DeployableState(VehicleDeployableState {
                        deployable_guid,
                        deployable_kind,
                        pallet_size,
                        online_flags,
                        ammo_remaining,
                        owner_guid,
                        parent_vehicle,
                        cell,
                        position,
                        heading,
                        power_watts,
                        energy_stored_joules,
                        energy_capacity_joules,
                        fuel_remaining,
                        pitch_rad,
                        yaw_rad,
                        roll_rad,
                        elevation_m,
                    })
                }
                s2c::DEPLOYABLE_FIRE => {
                    let deployable_guid = r.u32()?;
                    let weapon_kind = r.u32()?;
                    let step = r.u32()?;
                    let target_guid = r.u32()?;
                    let cell = r.u32()?;
                    let muzzle = r.vec3()?;
                    let target_pos = r.vec3()?;
                    let velocity = r.vec3()?;
                    let energy_joules = r.f32()?;
                    let burst_count = r.u16()?;
                    let reserved = r.u16()?;
                    Self::DeployableFire(VehicleDeployableFire {
                        deployable_guid,
                        weapon_kind,
                        step,
                        target_guid,
                        cell,
                        muzzle,
                        target_pos,
                        velocity,
                        energy_joules,
                        burst_count,
                        reserved,
                    })
                }
                s2c::GROUND_CONTACTS => {
                    let radar_guid = r.u32()?;
                    let parent_vehicle = r.u32()?;
                    let radar_x = r.f32()?;
                    let radar_y = r.f32()?;
                    let radar_z = r.f32()?;
                    let range_m = r.f32()?;
                    let sweep_angle_rad = r.f32()?;
                    let n = r.count(GroundContactWire::WIRE)?;
                    let mut contacts = Vec::with_capacity(n);
                    for _ in 0..n {
                        contacts.push(GroundContactWire::read(&mut r)?);
                    }
                    Self::GroundContacts(VehicleGroundContacts {
                        radar_guid,
                        parent_vehicle,
                        radar_x,
                        radar_y,
                        radar_z,
                        range_m,
                        sweep_angle_rad,
                        contacts,
                    })
                }
                s2c::CONTAINER_STATE => {
                    Self::ContainerState(VehicleContainerState::read(&mut r, &hdr)?)
                }
                s2c::PALLET_EVENT => {
                    Self::PalletEvent(VehiclePalletEvent::read(&mut r)?)
                }
                _ => return None,
            }
        };
        skip_future(&hdr, data, offset);
        Some(msg)
    }
}
