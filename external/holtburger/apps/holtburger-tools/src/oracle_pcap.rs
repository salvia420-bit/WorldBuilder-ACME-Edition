//! `pcap2jsonl` — decode captured Asheron's Call UDP traffic into movement /
//! cast telemetry JSONL.
//!
//! This is the **retail side of the movement parity oracle**.  A retail
//! `acclient.exe` running against our vanilla ACE server is ground truth for
//! how movement is supposed to look; `tcpdump` on the relay's UDP leg records
//! it; this module turns that capture into the same JSONL shape the
//! holtburger `?moveTelemetry=1` surface emits, so `oracle-diff.mjs` can put
//! the two curves side by side.
//!
//! # Why a capture works at all
//!
//! AC's `ENCRYPTED_CHECKSUM` packet flag is a misnomer: ISAAC obfuscates only
//! the 32-bit header checksum field, never the payload.  Payload bytes are
//! plaintext on the wire, so a mid-session capture decodes with no seeds, no
//! handshake replay, and no key state.  We therefore skip checksum
//! validation outright — it is advisory, and validating the encrypted form
//! would require having seen `CONNECT_REQUEST` and replaying every packet in
//! order to keep the ISAAC stream synced, which a lossy capture cannot
//! guarantee anyway.
//!
//! # Pipeline
//!
//! ```text
//! pcap file
//!   -> PcapReader           (classic pcap, both endians, us/ns)
//!   -> link layer strip     (Ethernet / Linux SLL / null-loopback / raw)
//!   -> IPv4 + UDP           (ports 9000/9001)
//!   -> PacketHeader         (holtburger_protocol::messages::transport)
//!   -> optional headers     (holtburger_session::optional_header)
//!   -> fragment walk        (FragmentHeader)
//!   -> Reassembler          (reimplemented here — see note)
//!   -> GameMessage::unpack  (holtburger_protocol)
//!   -> JSONL record
//! ```
//!
//! NOTE on the reassembler: `holtburger-session` has one, but it is
//! `pub(crate)` and bound to a live `Session` that owns a `Transport`, so it
//! cannot be driven offline.  `Reassembler` below is a faithful
//! reimplementation of `Session::process_fragment`, including the
//! `fragments[index].is_none()` guard that makes duplicate/retransmitted
//! fragments idempotent — a capture sees every retransmission, so that guard
//! is load-bearing here in a way it rarely is live.

use std::collections::HashMap;
use std::fs::File;
use std::io::{BufReader, Read};
use std::net::Ipv4Addr;
use std::path::Path;

use holtburger_common::math::Quaternion;
use holtburger_protocol::messages::game_action::GameAction;
use holtburger_protocol::messages::game_message::GameMessage;
use holtburger_protocol::messages::movement::messages::motion::MovementTypeData;
use holtburger_protocol::messages::transport::{
    self, FragmentHeader, PacketHeader, packet_flags,
};
use holtburger_protocol::traits::ProtocolUnpack;
use holtburger_session::optional_header::OptionalHeaderCursor;
use serde_json::{Value, json};

// ---------------------------------------------------------------------------
// pcap reading
// ---------------------------------------------------------------------------

/// Classic-pcap magic numbers.  `tcpdump -w` writes this format by default.
/// We deliberately do not depend on a pcap crate: the classic format is a
/// 24-byte global header plus a 16-byte per-record header, and taking a new
/// third-party dependency for that on a memory-constrained build host is a
/// bad trade.
const PCAP_MAGIC_US_LE: u32 = 0xa1b2_c3d4;
const PCAP_MAGIC_NS_LE: u32 = 0xa1b2_3c4d;

/// Link-layer types we can strip.  Loopback capture (`-i lo`) on Linux is
/// `EN10MB` in practice, but `-i any` yields `LINUX_SLL`/`LINUX_SLL2`, and
/// both show up depending on how the rig is invoked — so handle all of them
/// rather than making the capture command load-bearing.
const DLT_NULL: u32 = 0;
const DLT_EN10MB: u32 = 1;
const DLT_RAW: u32 = 101;
const DLT_LINUX_SLL: u32 = 113;
const DLT_LINUX_SLL2: u32 = 276;

#[derive(Debug)]
pub struct PcapReader {
    inner: BufReader<File>,
    swapped: bool,
    nanos: bool,
    pub link_type: u32,
}

/// One captured frame: absolute capture time plus the link-layer bytes.
pub struct RawFrame {
    pub ts: f64,
    pub data: Vec<u8>,
}

impl PcapReader {
    pub fn open(path: &Path) -> anyhow::Result<Self> {
        let file = File::open(path)
            .map_err(|e| anyhow::anyhow!("cannot open pcap {}: {e}", path.display()))?;
        let mut inner = BufReader::new(file);
        let mut hdr = [0u8; 24];
        inner.read_exact(&mut hdr)?;
        let raw_magic = u32::from_le_bytes([hdr[0], hdr[1], hdr[2], hdr[3]]);
        let (swapped, nanos) = match raw_magic {
            PCAP_MAGIC_US_LE => (false, false),
            PCAP_MAGIC_NS_LE => (false, true),
            m if m.swap_bytes() == PCAP_MAGIC_US_LE => (true, false),
            m if m.swap_bytes() == PCAP_MAGIC_NS_LE => (true, true),
            m => {
                anyhow::bail!(
                    "not a classic pcap file (magic {m:#010x}). \
                     pcapng is not supported — capture with `tcpdump -w` \
                     (classic) rather than a pcapng writer."
                )
            }
        };
        let rd = |o: usize| -> u32 {
            let v = u32::from_le_bytes([hdr[o], hdr[o + 1], hdr[o + 2], hdr[o + 3]]);
            if swapped { v.swap_bytes() } else { v }
        };
        let link_type = rd(20);
        Ok(Self {
            inner,
            swapped,
            nanos,
            link_type,
        })
    }

    /// Read the next record, or `Ok(None)` at clean EOF.  A truncated final
    /// record (common when a capture is killed) is treated as EOF rather
    /// than an error — the rig routinely SIGINTs tcpdump.
    pub fn next_frame(&mut self) -> anyhow::Result<Option<RawFrame>> {
        let mut rec = [0u8; 16];
        match self.inner.read_exact(&mut rec) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
            Err(e) => return Err(e.into()),
        }
        let rd = |o: usize| -> u32 {
            let v = u32::from_le_bytes([rec[o], rec[o + 1], rec[o + 2], rec[o + 3]]);
            if self.swapped { v.swap_bytes() } else { v }
        };
        let sec = rd(0);
        let frac = rd(4);
        let incl_len = rd(8) as usize;
        // Guard against a corrupt length turning into a huge allocation.
        if incl_len > 1 << 20 {
            anyhow::bail!("pcap record length {incl_len} is implausible; file likely corrupt");
        }
        let mut data = vec![0u8; incl_len];
        match self.inner.read_exact(&mut data) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
            Err(e) => return Err(e.into()),
        }
        let ts = sec as f64
            + if self.nanos {
                frac as f64 / 1e9
            } else {
                frac as f64 / 1e6
            };
        Ok(Some(RawFrame { ts, data }))
    }
}

/// A decoded UDP datagram lifted out of a captured link-layer frame.
pub struct UdpDatagram<'a> {
    pub src: (Ipv4Addr, u16),
    pub dst: (Ipv4Addr, u16),
    pub payload: &'a [u8],
}

/// Strip the link layer, returning the offset of the IP header.
fn strip_link(link_type: u32, data: &[u8]) -> Option<usize> {
    match link_type {
        // 4-byte address family; loopback on BSD, and on some Linux setups.
        DLT_NULL => Some(4),
        DLT_EN10MB => {
            if data.len() < 14 {
                return None;
            }
            let mut off = 12;
            let mut ethertype = u16::from_be_bytes([data[off], data[off + 1]]);
            // Walk VLAN tags (802.1Q / QinQ) so a tagged capture still decodes.
            while ethertype == 0x8100 || ethertype == 0x88a8 {
                off += 4;
                if data.len() < off + 2 {
                    return None;
                }
                ethertype = u16::from_be_bytes([data[off], data[off + 1]]);
            }
            if ethertype != 0x0800 {
                return None; // not IPv4
            }
            Some(off + 2)
        }
        DLT_RAW => Some(0),
        DLT_LINUX_SLL => {
            if data.len() < 16 {
                return None;
            }
            if u16::from_be_bytes([data[14], data[15]]) != 0x0800 {
                return None;
            }
            Some(16)
        }
        DLT_LINUX_SLL2 => {
            if data.len() < 20 {
                return None;
            }
            if u16::from_be_bytes([data[0], data[1]]) != 0x0800 {
                return None;
            }
            Some(20)
        }
        _ => None,
    }
}

/// Extract a UDP datagram from a captured frame, or `None` if the frame is
/// not IPv4/UDP (ARP, IPv6, TCP, a fragment, …).
pub fn parse_udp(link_type: u32, data: &[u8]) -> Option<UdpDatagram<'_>> {
    let ip_off = strip_link(link_type, data)?;
    let ip = data.get(ip_off..)?;
    if ip.len() < 20 || (ip[0] >> 4) != 4 {
        return None;
    }
    let ihl = ((ip[0] & 0x0f) as usize) * 4;
    if ihl < 20 || ip.len() < ihl {
        return None;
    }
    if ip[9] != 17 {
        return None; // not UDP
    }
    // IP-level fragmentation: only the first fragment carries the UDP header.
    // AC datagrams are far below the MTU, so a fragmented one means something
    // is wrong; skip rather than misparse.
    let frag = u16::from_be_bytes([ip[6], ip[7]]);
    if frag & 0x1fff != 0 {
        return None;
    }
    let src_ip = Ipv4Addr::new(ip[12], ip[13], ip[14], ip[15]);
    let dst_ip = Ipv4Addr::new(ip[16], ip[17], ip[18], ip[19]);
    let udp = ip.get(ihl..)?;
    if udp.len() < 8 {
        return None;
    }
    let src_port = u16::from_be_bytes([udp[0], udp[1]]);
    let dst_port = u16::from_be_bytes([udp[2], udp[3]]);
    let udp_len = u16::from_be_bytes([udp[4], udp[5]]) as usize;
    // Trust the UDP length when it is sane, else take the rest of the frame
    // (a snaplen-truncated capture yields a short buffer).
    let end = if udp_len >= 8 && udp_len <= udp.len() {
        udp_len
    } else {
        udp.len()
    };
    Some(UdpDatagram {
        src: (src_ip, src_port),
        dst: (dst_ip, dst_port),
        payload: &udp[8..end],
    })
}

// ---------------------------------------------------------------------------
// fragment reassembly
// ---------------------------------------------------------------------------

/// Mirrors `Session::MAX_FRAGMENTS_PER_MESSAGE` / `MAX_PENDING_FRAGMENT_GROUPS`.
const MAX_FRAGMENTS_PER_MESSAGE: u16 = 16384;
const MAX_PENDING_GROUPS: usize = 256;

struct Pending {
    count: u16,
    fragments: Vec<Option<Vec<u8>>>,
    received: u16,
}

/// Offline reassembler, one per direction.  See the module note on why this
/// is a reimplementation rather than a reuse.
#[derive(Default)]
pub struct Reassembler {
    groups: HashMap<u32, Pending>,
    pub dropped_groups: u64,
    pub duplicate_fragments: u64,
}

impl Reassembler {
    pub fn push(&mut self, header: &FragmentHeader, data: &[u8]) -> Option<Vec<u8>> {
        // Single-fragment message: the common case, no bookkeeping.
        if header.count <= 1 {
            return Some(data.to_vec());
        }
        if header.count > MAX_FRAGMENTS_PER_MESSAGE || header.index >= header.count {
            return None;
        }
        if self.groups.len() >= MAX_PENDING_GROUPS && !self.groups.contains_key(&header.sequence) {
            // Bound memory on a capture full of half-seen groups (a capture
            // that starts mid-message, or drops packets, leaves these behind
            // forever otherwise).
            self.groups.clear();
            self.dropped_groups += 1;
        }
        let entry = self.groups.entry(header.sequence).or_insert_with(|| Pending {
            count: header.count,
            fragments: vec![None; header.count as usize],
            received: 0,
        });
        if entry.count != header.count {
            return None; // sequence reuse with a different shape; ignore
        }
        let slot = &mut entry.fragments[header.index as usize];
        if slot.is_some() {
            // Retransmission or duplicate — idempotent, as live code does.
            self.duplicate_fragments += 1;
            return None;
        }
        *slot = Some(data.to_vec());
        entry.received += 1;
        if entry.received == entry.count {
            let done = self.groups.remove(&header.sequence)?;
            let mut out = Vec::new();
            for frag in done.fragments.into_iter() {
                out.extend_from_slice(&frag?);
            }
            return Some(out);
        }
        None
    }
}

// ---------------------------------------------------------------------------
// packet -> messages
// ---------------------------------------------------------------------------

/// Everything a decoded datagram yielded.
pub struct DecodedPacket {
    pub header: PacketHeader,
    pub messages: Vec<Vec<u8>>,
}

/// Parse one AC datagram into zero or more complete message payloads.
pub fn decode_packet(data: &[u8], reasm: &mut Reassembler) -> Option<DecodedPacket> {
    if data.len() < transport::HEADER_SIZE {
        return None;
    }
    let mut off = 0usize;
    let header = PacketHeader::unpack(data, &mut off)?;
    let body = &data[transport::HEADER_SIZE..];
    // Control-only packets (ack, time sync, echo, connect) carry no fragments.
    if header.flags & packet_flags::BLOB_FRAGMENTS == 0 {
        return Some(DecodedPacket {
            header,
            messages: Vec::new(),
        });
    }
    let cursor = OptionalHeaderCursor::new(body, header.flags);
    let mut offset = cursor.payload_offset();
    let mut messages = Vec::new();
    while offset + transport::FRAGMENT_HEADER_SIZE <= body.len() {
        let mut fo = offset;
        let Some(fh) = FragmentHeader::unpack(body, &mut fo) else {
            break;
        };
        let data_size = (fh.size as usize).saturating_sub(transport::FRAGMENT_HEADER_SIZE);
        let Some(frag) = body.get(fo..fo + data_size) else {
            break;
        };
        if let Some(full) = reasm.push(&fh, frag) {
            messages.push(full);
        }
        offset = fo + data_size;
        if data_size == 0 {
            break; // defensive: a zero-size fragment would loop forever
        }
    }
    Some(DecodedPacket { header, messages })
}

// ---------------------------------------------------------------------------
// message -> telemetry JSON
// ---------------------------------------------------------------------------

fn quat_heading_deg(q: &Quaternion) -> f32 {
    q.to_heading().to_degrees().rem_euclid(360.0)
}

fn pos_json(pack: &holtburger_protocol::messages::movement::messages::position::PositionPack) -> Value {
    let mut v = json!({
        "lb": format!("{:#010X}", pack.pos.landblock_id.0),
        "x": pack.pos.coords.x,
        "y": pack.pos.coords.y,
        "z": pack.pos.coords.z,
        "heading_deg": quat_heading_deg(&pack.pos.rotation),
        "seq": {
            "instance": pack.instance_sequence,
            "position": pack.position_sequence,
            "teleport": pack.teleport_sequence,
            "force_position": pack.force_position_sequence,
        },
    });
    if let Some(vel) = pack.velocity.as_ref() {
        v["vel"] = json!({ "x": vel.x, "y": vel.y, "z": vel.z });
        v["speed"] = json!((vel.x * vel.x + vel.y * vel.y + vel.z * vel.z).sqrt());
    }
    if let Some(pid) = pack.placement_id {
        v["placement_id"] = json!(pid);
    }
    v["grounded"] = json!(pack.flags.bits() & 0x04 != 0);
    v
}

/// The opcodes this oracle cares about.  Everything else is summarised by
/// opcode only (see `--all`) so a capture stays readable.
pub const MOVEMENT_OPCODES: &[u32] = &[
    0xF619, // PositionAndMovementEvent
    0xF748, // UpdatePosition
    0xF74C, // UpdateMotion
    0xF74E, // VectorUpdate
    0xF753, // AutonomousPosition
    0xF754, // PlayScriptId  (not in GameMessage — decoded manually below)
    0xF755, // PlayEffect / PlayScriptType
    0xF7B1, // Ordered GameAction
];

/// `0xF754` is deliberately absent from `GameOpcode` (retail-only; ACE never
/// emits it), so it arrives as `GameMessage::Unknown`.  A retail capture is
/// exactly the case where it *does* appear, so decode it here: the payload is
/// `[u32 target_guid][u32 data_id]` with no speed float.
fn decode_play_script_id(bytes: &[u8]) -> Option<Value> {
    if bytes.len() < 8 {
        return None;
    }
    Some(json!({
        "target": format!("{:#010X}", u32::from_le_bytes(bytes[0..4].try_into().ok()?)),
        "script_id": format!("{:#010X}", u32::from_le_bytes(bytes[4..8].try_into().ok()?)),
    }))
}

/// Turn a reassembled message into a telemetry record body, or `None` if the
/// opcode is not movement/cast relevant.
pub fn message_json(payload: &[u8], keep_all: bool) -> Option<Value> {
    if payload.len() < 4 {
        return None;
    }
    let opcode = u32::from_le_bytes(payload[0..4].try_into().ok()?);
    let mut off = 0usize;
    let msg = GameMessage::unpack(payload, &mut off);

    let mut body = match &msg {
        Some(GameMessage::UpdatePosition(d)) => json!({
            "kind": "UpdatePosition",
            "guid": format!("{:#010X}", d.guid.0),
            "pos": pos_json(&d.pos),
        }),
        Some(GameMessage::PositionAndMovementEvent(d)) => json!({
            "kind": "PositionAndMovementEvent",
            "guid": format!("{:#010X}", d.guid.0),
            "pos": pos_json(&d.pos),
            "movement": movement_json(&d.movement),
        }),
        Some(GameMessage::UpdateMotion(d)) => json!({
            "kind": "UpdateMotion",
            "guid": format!("{:#010X}", d.guid.0),
            "movement": movement_json(d),
        }),
        Some(GameMessage::VectorUpdate(d)) => json!({
            "kind": "VectorUpdate",
            "guid": format!("{:#010X}", d.guid.0),
            "vel": { "x": d.velocity.x, "y": d.velocity.y, "z": d.velocity.z },
            "speed": (d.velocity.x * d.velocity.x
                + d.velocity.y * d.velocity.y
                + d.velocity.z * d.velocity.z).sqrt(),
            "omega": { "x": d.omega.x, "y": d.omega.y, "z": d.omega.z },
            "seq": { "instance": d.instance_sequence, "vector": d.vector_sequence },
        }),
        Some(GameMessage::AutonomousPosition(d)) => json!({
            "kind": "AutonomousPosition",
            "guid": format!("{:#010X}", d.guid.0),
            "x": d.coords.x, "y": d.coords.y, "z": d.coords.z,
            "heading_deg": quat_heading_deg(&d.rotation),
            "contact_flags": d.contact_flags,
        }),
        Some(GameMessage::PlayEffect(d)) => json!({
            "kind": "PlayEffect",
            "target": format!("{:#010X}", d.target.0),
            "script_id": format!("{:#010X}", d.script_id),
            "speed": d.speed,
        }),
        Some(GameMessage::GameAction(m)) => {
            let action = match &m.action {
                GameAction::MoveToState(d) => json!({
                    "action": "MoveToState",
                    "raw_motion": serde_json::to_value(&d.raw_motion_state).ok(),
                    "lb": format!("{:#010X}", d.position.landblock_id.0),
                    "x": d.position.coords.x,
                    "y": d.position.coords.y,
                    "z": d.position.coords.z,
                    "heading_deg": quat_heading_deg(&d.position.rotation),
                    "contact_long_jump": d.contact_long_jump,
                }),
                GameAction::Jump(d) => json!({
                    "action": "Jump",
                    "extent": d.extent,
                    "vel": { "x": d.velocity.x, "y": d.velocity.y, "z": d.velocity.z },
                }),
                GameAction::AutonomousPosition(d) => json!({
                    "action": "AutonomousPosition",
                    "lb": format!("{:#010X}", d.position.landblock_id.0),
                    "x": d.position.coords.x,
                    "y": d.position.coords.y,
                    "z": d.position.coords.z,
                    "heading_deg": quat_heading_deg(&d.position.rotation),
                }),
                GameAction::AutonomyLevel(d) => json!({
                    "action": "AutonomyLevel", "level": d.level
                }),
                other => {
                    if !keep_all {
                        return None;
                    }
                    json!({ "action": format!("{other:?}").split('(').next().unwrap_or("?") })
                }
            };
            json!({ "kind": "GameAction", "seq": m.sequence, "data": action })
        }
        Some(GameMessage::Unknown(op, bytes)) if *op == 0xF754 => {
            let mut v = decode_play_script_id(bytes).unwrap_or_else(|| json!({}));
            v["kind"] = json!("PlayScriptId");
            v
        }
        _ => {
            if !keep_all {
                return None;
            }
            json!({ "kind": "Other", "parsed": msg.is_some() })
        }
    };
    body["opcode"] = json!(format!("{opcode:#06X}"));
    Some(body)
}

fn movement_json(
    d: &holtburger_protocol::messages::movement::messages::motion::MovementEventData,
) -> Value {
    let mut v = json!({
        "type": format!("{:?}", d.movement_type),
        "motion_flags": d.motion_flags,
        "current_style": d.current_style,
        "autonomous": d.is_autonomous,
        "seq": {
            "instance": d.object_instance_sequence,
            "movement": d.movement_sequence,
            "server_control": d.server_control_sequence,
        },
    });
    match &d.data {
        MovementTypeData::Invalid(inv) => {
            v["interpreted"] = serde_json::to_value(&inv.state).unwrap_or(Value::Null);
            if let Some(s) = inv.sticky_object.as_ref() {
                v["sticky_object"] = json!(format!("{:#010X}", s.0));
            }
        }
        MovementTypeData::MoveToObject(m) => {
            v["run_rate"] = json!(m.run_rate);
            v["target"] = json!(format!("{:#010X}", m.target.0));
            v["speed"] = json!(m.params.speed);
            v["desired_heading"] = json!(m.params.desired_heading);
        }
        MovementTypeData::MoveToPosition(m) => {
            v["run_rate"] = json!(m.run_rate);
            v["speed"] = json!(m.params.speed);
            v["desired_heading"] = json!(m.params.desired_heading);
        }
        MovementTypeData::TurnToObject(t) => {
            v["desired_heading"] = json!(t.desired_heading);
            v["turn_speed"] = json!(t.params.speed);
        }
        MovementTypeData::TurnToHeading(t) => {
            v["desired_heading"] = json!(t.params.desired_heading);
            v["turn_speed"] = json!(t.params.speed);
        }
    }
    v
}

// ---------------------------------------------------------------------------
// driver
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct Options {
    /// Emit a record for every decodable message, not just movement/cast.
    pub keep_all: bool,
    /// Server-side UDP ports; a datagram whose *source* port is one of these
    /// is server->client.
    pub server_ports: Vec<u16>,
    /// Re-base timestamps so the first record is t=0.
    pub relative_time: bool,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            keep_all: false,
            server_ports: vec![9000, 9001],
            relative_time: true,
        }
    }
}

#[derive(Debug, Default, Clone, serde::Serialize)]
pub struct Summary {
    pub frames: u64,
    pub udp_datagrams: u64,
    pub packets_decoded: u64,
    pub messages: u64,
    pub records_emitted: u64,
    pub duplicate_fragments: u64,
    pub dropped_groups: u64,
    pub opcode_histogram: std::collections::BTreeMap<String, u64>,
}

/// Decode a pcap into JSONL lines.  Returns the lines plus a summary; the
/// caller decides where they go (stdout, a file, a test assertion).
pub fn decode_pcap(path: &Path, opts: &Options) -> anyhow::Result<(Vec<String>, Summary)> {
    let mut reader = PcapReader::open(path)?;
    if strip_link(reader.link_type, &[0u8; 64]).is_none() && reader.link_type != DLT_EN10MB {
        anyhow::bail!(
            "unsupported pcap link type {} — capture on an Ethernet, \
             loopback, raw, or Linux-cooked interface",
            reader.link_type
        );
    }
    let mut summary = Summary::default();
    let mut lines = Vec::new();
    // One reassembler per direction: the two streams have independent
    // fragment sequence spaces and would collide in a shared map.
    let mut reasm_c2s = Reassembler::default();
    let mut reasm_s2c = Reassembler::default();
    let mut t0: Option<f64> = None;

    while let Some(frame) = reader.next_frame()? {
        summary.frames += 1;
        let Some(dgram) = parse_udp(reader.link_type, &frame.data) else {
            continue;
        };
        let is_s2c = opts.server_ports.contains(&dgram.src.1);
        let is_c2s = opts.server_ports.contains(&dgram.dst.1);
        if !is_s2c && !is_c2s {
            continue;
        }
        summary.udp_datagrams += 1;
        let reasm = if is_s2c {
            &mut reasm_s2c
        } else {
            &mut reasm_c2s
        };
        let Some(decoded) = decode_packet(dgram.payload, reasm) else {
            continue;
        };
        summary.packets_decoded += 1;
        if t0.is_none() {
            t0 = Some(frame.ts);
        }
        let t = if opts.relative_time {
            frame.ts - t0.unwrap_or(frame.ts)
        } else {
            frame.ts
        };
        for payload in &decoded.messages {
            summary.messages += 1;
            if payload.len() >= 4 {
                let op = u32::from_le_bytes(payload[0..4].try_into().unwrap());
                *summary
                    .opcode_histogram
                    .entry(format!("{op:#06X}"))
                    .or_default() += 1;
            }
            let Some(mut body) = message_json(payload, opts.keep_all) else {
                continue;
            };
            body["t"] = json!(t);
            body["dir"] = json!(if is_s2c { "s2c" } else { "c2s" });
            body["src"] = json!(format!("{}:{}", dgram.src.0, dgram.src.1));
            body["dst"] = json!(format!("{}:{}", dgram.dst.0, dgram.dst.1));
            body["pkt_seq"] = json!(decoded.header.sequence);
            body["source"] = json!("retail-pcap");
            lines.push(serde_json::to_string(&body)?);
            summary.records_emitted += 1;
        }
    }
    summary.duplicate_fragments = reasm_c2s.duplicate_fragments + reasm_s2c.duplicate_fragments;
    summary.dropped_groups = reasm_c2s.dropped_groups + reasm_s2c.dropped_groups;
    Ok((lines, summary))
}

#[cfg(test)]
mod tests {
    use super::*;
    use holtburger_protocol::traits::ProtocolPack;

    /// Build a classic-pcap byte stream around a set of UDP payloads so the
    /// reader/link-strip/UDP path can be tested without a real capture.
    fn synth_pcap(link_type: u32, dgrams: &[(u16, u16, Vec<u8>)]) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(&PCAP_MAGIC_US_LE.to_le_bytes());
        out.extend_from_slice(&2u16.to_le_bytes()); // version major
        out.extend_from_slice(&4u16.to_le_bytes()); // version minor
        out.extend_from_slice(&0u32.to_le_bytes()); // thiszone
        out.extend_from_slice(&0u32.to_le_bytes()); // sigfigs
        out.extend_from_slice(&65535u32.to_le_bytes()); // snaplen
        out.extend_from_slice(&link_type.to_le_bytes());
        for (i, (sp, dp, payload)) in dgrams.iter().enumerate() {
            let mut frame = Vec::new();
            match link_type {
                DLT_EN10MB => {
                    frame.extend_from_slice(&[0u8; 12]);
                    frame.extend_from_slice(&0x0800u16.to_be_bytes());
                }
                DLT_NULL => frame.extend_from_slice(&2u32.to_le_bytes()),
                _ => {}
            }
            let udp_len = 8 + payload.len();
            let total_len = 20 + udp_len;
            let mut ip = vec![0u8; 20];
            ip[0] = 0x45;
            ip[2..4].copy_from_slice(&(total_len as u16).to_be_bytes());
            ip[9] = 17;
            ip[12..16].copy_from_slice(&[127, 0, 0, 1]);
            ip[16..20].copy_from_slice(&[127, 0, 0, 1]);
            frame.extend_from_slice(&ip);
            frame.extend_from_slice(&sp.to_be_bytes());
            frame.extend_from_slice(&dp.to_be_bytes());
            frame.extend_from_slice(&(udp_len as u16).to_be_bytes());
            frame.extend_from_slice(&0u16.to_be_bytes());
            frame.extend_from_slice(payload);

            out.extend_from_slice(&(1_700_000_000u32 + i as u32).to_le_bytes());
            out.extend_from_slice(&((i as u32) * 1000).to_le_bytes());
            out.extend_from_slice(&(frame.len() as u32).to_le_bytes());
            out.extend_from_slice(&(frame.len() as u32).to_le_bytes());
            out.extend_from_slice(&frame);
        }
        out
    }

    /// Wrap a message payload in a fragment + packet header, as the wire does.
    fn wrap_packet(seq: u32, msgs: &[Vec<u8>]) -> Vec<u8> {
        let mut body = Vec::new();
        for (i, m) in msgs.iter().enumerate() {
            let fh = FragmentHeader {
                sequence: 100 + i as u32,
                id: 0x1234,
                count: 1,
                size: (transport::FRAGMENT_HEADER_SIZE + m.len()) as u16,
                index: 0,
                queue: 1,
            };
            fh.pack(&mut body);
            body.extend_from_slice(m);
        }
        let header = PacketHeader {
            sequence: seq,
            flags: packet_flags::BLOB_FRAGMENTS,
            checksum: 0,
            id: 1,
            time: 0,
            size: body.len() as u16,
            iteration: 1,
        };
        let mut out = Vec::new();
        header.pack(&mut out);
        out.extend_from_slice(&body);
        out
    }

    fn update_position_msg() -> Vec<u8> {
        use holtburger_protocol::messages::movement::messages::position::UpdatePositionData;
        let mut pack =
            holtburger_protocol::messages::movement::messages::position::PositionPack::default();
        pack.pos.landblock_id = holtburger_common::Guid(0x00A9_0106);
        pack.pos.coords = holtburger_common::math::Vector3::new(10.0, 20.0, 30.0);
        pack.pos.rotation = Quaternion::identity();
        pack.instance_sequence = 3;
        pack.position_sequence = 7;
        let d = UpdatePositionData {
            guid: holtburger_common::Guid(0x5000_0001),
            pos: pack,
        };
        let mut buf = 0xF748u32.to_le_bytes().to_vec();
        d.pack(&mut buf);
        buf
    }

    #[test]
    fn decodes_update_position_from_synthetic_pcap() {
        let pkt = wrap_packet(1, &[update_position_msg()]);
        let bytes = synth_pcap(DLT_EN10MB, &[(9000, 40000, pkt)]);
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.pcap");
        std::fs::write(&path, &bytes).unwrap();

        let (lines, summary) = decode_pcap(&path, &Options::default()).unwrap();
        assert_eq!(summary.udp_datagrams, 1, "one AC datagram expected");
        assert_eq!(summary.messages, 1);
        assert_eq!(lines.len(), 1, "one movement record expected");
        let v: Value = serde_json::from_str(&lines[0]).unwrap();
        assert_eq!(v["kind"], "UpdatePosition");
        assert_eq!(v["dir"], "s2c", "source port 9000 means server->client");
        assert_eq!(v["guid"], "0x50000001");
        assert_eq!(v["pos"]["lb"], "0x00A90106");
        assert_eq!(v["pos"]["x"], 10.0);
        assert_eq!(v["pos"]["seq"]["position"], 7);
        assert_eq!(v["source"], "retail-pcap");
    }

    #[test]
    fn loopback_link_type_and_direction_detection() {
        let pkt = wrap_packet(2, &[update_position_msg()]);
        // Client -> server: destination port is the server port.
        let bytes = synth_pcap(DLT_NULL, &[(40000, 9000, pkt)]);
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.pcap");
        std::fs::write(&path, &bytes).unwrap();
        let (lines, _) = decode_pcap(&path, &Options::default()).unwrap();
        assert_eq!(lines.len(), 1);
        let v: Value = serde_json::from_str(&lines[0]).unwrap();
        assert_eq!(v["dir"], "c2s");
    }

    #[test]
    fn non_ac_ports_are_ignored() {
        let pkt = wrap_packet(3, &[update_position_msg()]);
        let bytes = synth_pcap(DLT_EN10MB, &[(1234, 5678, pkt)]);
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.pcap");
        std::fs::write(&path, &bytes).unwrap();
        let (lines, summary) = decode_pcap(&path, &Options::default()).unwrap();
        assert_eq!(summary.udp_datagrams, 0);
        assert!(lines.is_empty());
    }

    #[test]
    fn multi_fragment_message_reassembles() {
        let msg = update_position_msg();
        let (a, b) = msg.split_at(8);
        let mut body = Vec::new();
        for (i, part) in [a, b].iter().enumerate() {
            let fh = FragmentHeader {
                sequence: 55,
                id: 0x1234,
                count: 2,
                size: (transport::FRAGMENT_HEADER_SIZE + part.len()) as u16,
                index: i as u16,
                queue: 1,
            };
            fh.pack(&mut body);
            body.extend_from_slice(part);
        }
        let header = PacketHeader {
            sequence: 9,
            flags: packet_flags::BLOB_FRAGMENTS,
            checksum: 0,
            id: 1,
            time: 0,
            size: body.len() as u16,
            iteration: 1,
        };
        let mut pkt = Vec::new();
        header.pack(&mut pkt);
        pkt.extend_from_slice(&body);

        let bytes = synth_pcap(DLT_EN10MB, &[(9000, 40000, pkt)]);
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.pcap");
        std::fs::write(&path, &bytes).unwrap();
        let (lines, summary) = decode_pcap(&path, &Options::default()).unwrap();
        assert_eq!(summary.messages, 1, "two fragments -> one message");
        let v: Value = serde_json::from_str(&lines[0]).unwrap();
        assert_eq!(v["kind"], "UpdatePosition");
    }

    #[test]
    fn duplicate_fragments_are_idempotent() {
        // A retransmitted fragment must not double-count or corrupt the group.
        let mut r = Reassembler::default();
        let fh = FragmentHeader {
            sequence: 7,
            id: 1,
            count: 2,
            size: (transport::FRAGMENT_HEADER_SIZE + 4) as u16,
            index: 0,
            queue: 1,
        };
        assert!(r.push(&fh, b"aaaa").is_none());
        assert!(r.push(&fh, b"aaaa").is_none(), "duplicate ignored");
        assert_eq!(r.duplicate_fragments, 1);
        let fh2 = FragmentHeader { index: 1, ..fh.clone() };
        let out = r.push(&fh2, b"bbbb").expect("group completes");
        assert_eq!(out, b"aaaabbbb");
    }

    #[test]
    fn play_script_id_decodes_despite_absent_opcode() {
        // 0xF754 is intentionally not in GameOpcode; a retail capture has it.
        let mut payload = 0xF754u32.to_le_bytes().to_vec();
        payload.extend_from_slice(&0x5000_00ABu32.to_le_bytes());
        payload.extend_from_slice(&0x0000_0021u32.to_le_bytes());
        let v = message_json(&payload, false).expect("decoded");
        assert_eq!(v["kind"], "PlayScriptId");
        assert_eq!(v["target"], "0x500000AB");
        assert_eq!(v["script_id"], "0x00000021");
    }

    #[test]
    fn rejects_pcapng() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.pcapng");
        // pcapng Section Header Block magic, padded past the 24-byte global
        // header read so the magic check (not a short read) is what rejects it.
        let mut buf = vec![0x0a, 0x0d, 0x0d, 0x0a, 0, 0, 0, 0, 0x4d, 0x3c, 0x2b, 0x1a];
        buf.resize(64, 0);
        std::fs::write(&path, &buf).unwrap();
        let err = PcapReader::open(&path).unwrap_err().to_string();
        assert!(err.contains("classic pcap"), "helpful error, got: {err}");
    }
}
