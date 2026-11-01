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
//! `GameEvent::Unknown`, i.e. dropped). A higher version is parsed for its v1 fields and its trailing
//! bytes are skipped (versions only append).

use crate::messages::utils::{read_string16, write_string16};
use byteorder::{ByteOrder, LittleEndian, WriteBytesExt};

#[cfg(test)]
mod tests;

/// `"HBV1"` as a little-endian u32 (bytes `48 42 56 31`).
pub const HBV1_TAG: u32 = 0x3156_4248;
/// The protocol version this module writes.
pub const HBV1_VERSION: u16 = 1;

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
}

/// S2C game-event opcodes.
pub mod s2c {
    pub const CAPABILITIES_ACK: u32 = 0x0900;
    pub const PROFILE: u32 = 0x0901;
    pub const SEAT: u32 = 0x0904;
    pub const STATE: u32 = 0x0906;
    pub const FIRE: u32 = 0x0907;
    pub const EVENT: u32 = 0x0908;
}

/// `VehicleState.mode`.
pub mod mode {
    pub const PARKED: u8 = 0;
    pub const TAKEOFF: u8 = 1;
    pub const FLIGHT: u8 = 2;
    pub const LANDING: u8 = 3;
    pub const CRASHED: u8 = 4;
    pub const DERELICT: u8 = 5;
}

/// `VehicleInputFrame.buttons`.
pub mod buttons {
    pub const BOOST: u8 = 0x01;
    pub const FIRE: u8 = 0x02;
    pub const LAND: u8 = 0x04;
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

/// Skip the bytes a newer version appended after the v1 fields.
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

// ---------------------------------------------------------------- C2S

/// Client → server vehicle game actions.
#[derive(Debug, Clone, PartialEq)]
pub enum VehicleC2S {
    ClientCapabilities { flags: u32 },
    Board { vehicle: u32, seat: u32 },
    Exit { vehicle: u32, mode: u32 },
    /// Newest frame first, then up to two older ones (redundancy).
    Input { vehicle: u32, frames: Vec<VehicleInputFrame> },
}

impl VehicleC2S {
    pub fn opcode(&self) -> u32 {
        match self {
            Self::ClientCapabilities { .. } => c2s::CLIENT_CAPABILITIES,
            Self::Board { .. } => c2s::BOARD,
            Self::Exit { .. } => c2s::EXIT,
            Self::Input { .. } => c2s::INPUT,
        }
    }

    pub fn is_vehicle_opcode(opcode: u32) -> bool {
        matches!(
            opcode,
            c2s::CLIENT_CAPABILITIES | c2s::BOARD | c2s::EXIT | c2s::INPUT
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
    pub ammo: u16,
    pub mode: u8,
    pub flags: u8,
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
        }
    }

    pub fn is_vehicle_opcode(opcode: u32) -> bool {
        matches!(
            opcode,
            s2c::CAPABILITIES_ACK | s2c::PROFILE | s2c::SEAT | s2c::STATE | s2c::FIRE | s2c::EVENT
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
            }
            Self::Event(e) => {
                for v in [e.vehicle, e.kind, e.step, e.subject, e.cell] {
                    buf.write_u32::<LittleEndian>(v).unwrap();
                }
                w_vec3(buf, e.position);
                buf.write_f32::<LittleEndian>(e.value).unwrap();
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
                }),
                s2c::EVENT => Self::Event(VehicleEvent {
                    vehicle: r.u32()?,
                    kind: r.u32()?,
                    step: r.u32()?,
                    subject: r.u32()?,
                    cell: r.u32()?,
                    position: r.vec3()?,
                    value: r.f32()?,
                }),
                _ => return None,
            }
        };
        skip_future(&hdr, data, offset);
        Some(msg)
    }
}
