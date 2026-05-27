use crate::messages::utils::{
    read_hashtable_header, read_string16, write_hashtable_header, write_string16,
};
use crate::traits::{ProtocolPack, ProtocolUnpack};
use byteorder::{ByteOrder, LittleEndian, WriteBytesExt};
use holtburger_common::Guid;
use holtburger_common::position::WorldPosition;

// ACE writes officers as PackableHashTable with `headerNumBuckets = 256`
// (the count is sent as 256 in the wire header but ACE-side uses 23 for
// bucket math); we mirror the wire byte: emit 256 in the bucket header.
// Retail packets seen with empty officers map but the field is still
// present.
const ALLEGIANCE_OFFICER_BUCKETS: usize = 256;

/// Mirrors `ACE.Server.Network.Enum.AllegianceIndex` — bitfield flags on
/// each `AllegianceData` row. `HasPackedLevel` gates whether `level` is
/// written; `HasAllegianceAge` selects the `(timeOnline:u32,
/// allegianceAge:u32)` vs legacy `uTimeOnline:u64` shape (retail post-EoR
/// always sets HasAllegianceAge).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AllegianceIndexFlags(pub u32);

impl AllegianceIndexFlags {
    pub const UNDEFINED: u32 = 0x0;
    pub const LOGGED_IN: u32 = 0x1;
    pub const UPDATE: u32 = 0x2;
    pub const HAS_ALLEGIANCE_AGE: u32 = 0x4;
    pub const HAS_PACKED_LEVEL: u32 = 0x8;
    pub const MAY_PASSUP_EXPERIENCE: u32 = 0x10;

    pub fn has_allegiance_age(self) -> bool {
        self.0 & Self::HAS_ALLEGIANCE_AGE != 0
    }
    pub fn has_packed_level(self) -> bool {
        self.0 & Self::HAS_PACKED_LEVEL != 0
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AllegianceDataEntry {
    pub character_id: Guid,
    pub cp_cached: u32,
    pub cp_tithed: u32,
    pub bitfield: AllegianceIndexFlags,
    pub gender: u8,
    pub heritage_group: u8,
    pub rank: u16,
    pub level: u32,
    pub loyalty: u16,
    pub leadership: u16,
    /// When `bitfield.has_allegiance_age()` (retail default) this carries
    /// `(time_online, allegiance_age)`. When the flag is clear this is
    /// `(low32_of_uTimeOnline, high32_of_uTimeOnline)` — legacy shape.
    pub time_online: u32,
    pub allegiance_age: u32,
    pub name: String,
}

impl ProtocolUnpack for AllegianceDataEntry {
    fn unpack(data: &[u8], offset: &mut usize) -> Option<Self> {
        if *offset + 18 > data.len() {
            return None;
        }
        let character_id = Guid(LittleEndian::read_u32(&data[*offset..*offset + 4]));
        let cp_cached = LittleEndian::read_u32(&data[*offset + 4..*offset + 8]);
        let cp_tithed = LittleEndian::read_u32(&data[*offset + 8..*offset + 12]);
        let bitfield_raw = LittleEndian::read_u32(&data[*offset + 12..*offset + 16]);
        let gender = data[*offset + 16];
        let heritage_group = data[*offset + 17];
        *offset += 18;
        if *offset + 2 > data.len() {
            return None;
        }
        let rank = LittleEndian::read_u16(&data[*offset..*offset + 2]);
        *offset += 2;
        let bitfield = AllegianceIndexFlags(bitfield_raw);

        let level = if bitfield.has_packed_level() {
            if *offset + 4 > data.len() {
                return None;
            }
            let v = LittleEndian::read_u32(&data[*offset..*offset + 4]);
            *offset += 4;
            v
        } else {
            0
        };

        if *offset + 4 > data.len() {
            return None;
        }
        let loyalty = LittleEndian::read_u16(&data[*offset..*offset + 2]);
        let leadership = LittleEndian::read_u16(&data[*offset + 2..*offset + 4]);
        *offset += 4;

        let (time_online, allegiance_age) = if bitfield.has_allegiance_age() {
            if *offset + 8 > data.len() {
                return None;
            }
            let t = LittleEndian::read_u32(&data[*offset..*offset + 4]);
            let a = LittleEndian::read_u32(&data[*offset + 4..*offset + 8]);
            *offset += 8;
            (t, a)
        } else {
            // Legacy ulong uTimeOnline: split into two u32 windows.
            if *offset + 8 > data.len() {
                return None;
            }
            let lo = LittleEndian::read_u32(&data[*offset..*offset + 4]);
            let hi = LittleEndian::read_u32(&data[*offset + 4..*offset + 8]);
            *offset += 8;
            (lo, hi)
        };

        let name = read_string16(data, offset)?;

        Some(Self {
            character_id,
            cp_cached,
            cp_tithed,
            bitfield,
            gender,
            heritage_group,
            rank,
            level,
            loyalty,
            leadership,
            time_online,
            allegiance_age,
            name,
        })
    }
}

impl ProtocolPack for AllegianceDataEntry {
    fn pack(&self, buf: &mut Vec<u8>) {
        buf.write_u32::<LittleEndian>(self.character_id.0).unwrap();
        buf.write_u32::<LittleEndian>(self.cp_cached).unwrap();
        buf.write_u32::<LittleEndian>(self.cp_tithed).unwrap();
        buf.write_u32::<LittleEndian>(self.bitfield.0).unwrap();
        buf.push(self.gender);
        buf.push(self.heritage_group);
        buf.write_u16::<LittleEndian>(self.rank).unwrap();
        if self.bitfield.has_packed_level() {
            buf.write_u32::<LittleEndian>(self.level).unwrap();
        }
        buf.write_u16::<LittleEndian>(self.loyalty).unwrap();
        buf.write_u16::<LittleEndian>(self.leadership).unwrap();
        if self.bitfield.has_allegiance_age() {
            buf.write_u32::<LittleEndian>(self.time_online).unwrap();
            buf.write_u32::<LittleEndian>(self.allegiance_age).unwrap();
        } else {
            buf.write_u32::<LittleEndian>(self.time_online).unwrap();
            buf.write_u32::<LittleEndian>(self.allegiance_age).unwrap();
        }
        write_string16(buf, &self.name);
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AllegianceOfficerEntry {
    pub character_id: Guid,
    pub officer_level: u32,
}

#[derive(Debug, Clone, PartialEq)]
pub struct AllegianceUpdateEventData {
    /// Local player's rank within the allegiance (`AllegianceNode.Rank`).
    pub rank: u32,
    /// `AllegianceProfile`: total members across the tree (including
    /// monarch) and the local player's personal vassal count.
    pub total_members: u32,
    pub total_vassals: u32,
    // `AllegianceHierarchy` block follows.
    pub officers: Vec<AllegianceOfficerEntry>,
    pub officer_titles: Vec<String>,
    pub monarch_broadcast_time: u32,
    pub monarch_broadcasts_today: u32,
    pub spokes_broadcast_time: u32,
    pub spokes_broadcasts_today: u32,
    pub motd: String,
    pub motd_set_by: String,
    pub chat_room_id: u32,
    pub bind_point: WorldPosition,
    pub allegiance_name: String,
    pub name_last_set_time: u32,
    pub is_locked: bool,
    pub approved_vassal: i32,
    /// Always-present monarch row (no parent guid); ACE writes it as a
    /// raw `AllegianceData` without the `treeParent` prefix.
    pub monarch: Option<AllegianceDataEntry>,
    /// Remaining hierarchy entries: `(tree_parent_guid, allegiance_data)`.
    /// `tree_parent_guid` is the parent character's ObjectGuid the client
    /// uses to build the tree display. Order: patron, self, vassals.
    pub records: Vec<(Guid, AllegianceDataEntry)>,
}

impl ProtocolUnpack for AllegianceUpdateEventData {
    fn unpack(data: &[u8], offset: &mut usize) -> Option<Self> {
        if *offset + 12 > data.len() {
            return None;
        }
        let rank = LittleEndian::read_u32(&data[*offset..*offset + 4]);
        let total_members = LittleEndian::read_u32(&data[*offset + 4..*offset + 8]);
        let total_vassals = LittleEndian::read_u32(&data[*offset + 8..*offset + 12]);
        *offset += 12;

        // Wave-F3 (2026-05-27): body shared with `AllegianceInfoResponse`
        // (0x027C). See `unpack_allegiance_hierarchy_body` for the
        // Chorizite `AllegianceHierarchy.Read` ordering.
        let body = unpack_allegiance_hierarchy_body(data, offset)?;
        Some(Self {
            rank,
            total_members,
            total_vassals,
            officers: body.officers,
            officer_titles: body.officer_titles,
            monarch_broadcast_time: body.monarch_broadcast_time,
            monarch_broadcasts_today: body.monarch_broadcasts_today,
            spokes_broadcast_time: body.spokes_broadcast_time,
            spokes_broadcasts_today: body.spokes_broadcasts_today,
            motd: body.motd,
            motd_set_by: body.motd_set_by,
            chat_room_id: body.chat_room_id,
            bind_point: body.bind_point,
            allegiance_name: body.allegiance_name,
            name_last_set_time: body.name_last_set_time,
            is_locked: body.is_locked,
            approved_vassal: body.approved_vassal,
            monarch: body.monarch,
            records: body.records,
        })
    }
}

impl ProtocolPack for AllegianceUpdateEventData {
    fn pack(&self, buf: &mut Vec<u8>) {
        buf.write_u32::<LittleEndian>(self.rank).unwrap();
        buf.write_u32::<LittleEndian>(self.total_members).unwrap();
        buf.write_u32::<LittleEndian>(self.total_vassals).unwrap();
        let body = AllegianceHierarchyBody {
            officers: self.officers.clone(),
            officer_titles: self.officer_titles.clone(),
            monarch_broadcast_time: self.monarch_broadcast_time,
            monarch_broadcasts_today: self.monarch_broadcasts_today,
            spokes_broadcast_time: self.spokes_broadcast_time,
            spokes_broadcasts_today: self.spokes_broadcasts_today,
            motd: self.motd.clone(),
            motd_set_by: self.motd_set_by.clone(),
            chat_room_id: self.chat_room_id,
            bind_point: self.bind_point.clone(),
            allegiance_name: self.allegiance_name.clone(),
            name_last_set_time: self.name_last_set_time,
            is_locked: self.is_locked,
            approved_vassal: self.approved_vassal,
            monarch: self.monarch.clone(),
            records: self.records.clone(),
        };
        pack_allegiance_hierarchy_body(buf, &body);
    }
}

/// Wave-F3 (2026-05-27): `Allegiance_AllegianceLoginNotificationEvent`
/// (S2C event opcode 0x027A) — sent by ACE when a fellow allegiance
/// member logs in or out. Source-of-truth: port of
/// `external/chorizite/Chorizite.ACProtocol/Chorizite.ACProtocol/Messages/
/// S2C/Events/Allegiance_AllegianceLoginNotificationEvent.generated.cs`.
///
/// IMPORTANT: Chorizite's `ReadBool` reads a 4-byte u32 (returns
/// `val == 1`), NOT a single byte. We mirror that on the wire.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AllegianceLoginNotificationEventData {
    /// The object ID of the player logging in or out.
    pub character_id: Guid,
    /// `false` = logout, `true` = login.
    pub is_logged_in: bool,
}

impl ProtocolUnpack for AllegianceLoginNotificationEventData {
    fn unpack(data: &[u8], offset: &mut usize) -> Option<Self> {
        if *offset + 8 > data.len() {
            return None;
        }
        let character_id = Guid(LittleEndian::read_u32(&data[*offset..*offset + 4]));
        let is_logged_in_raw = LittleEndian::read_u32(&data[*offset + 4..*offset + 8]);
        *offset += 8;
        Some(Self {
            character_id,
            is_logged_in: is_logged_in_raw == 1,
        })
    }
}

impl ProtocolPack for AllegianceLoginNotificationEventData {
    fn pack(&self, buf: &mut Vec<u8>) {
        buf.write_u32::<LittleEndian>(self.character_id.0).unwrap();
        buf.write_u32::<LittleEndian>(u32::from(self.is_logged_in))
            .unwrap();
    }
}

/// Wave-F3 (2026-05-27): `Allegiance_AllegianceInfoResponseEvent`
/// (S2C event opcode 0x027C) — server's reply to a client's
/// `Allegiance_AllegianceInfoRequest` query. Carries the same
/// `AllegianceProfile` body as `AllegianceUpdate` (0x0020), but for a
/// queried player rather than the requesting player.
///
/// Source-of-truth: port of
/// `external/chorizite/Chorizite.ACProtocol/Chorizite.ACProtocol/Messages/
/// S2C/Events/Allegiance_AllegianceInfoResponseEvent.generated.cs`.
///
/// The wire shape (per Chorizite + ACE):
///   1. `target_id: u32` — the player whose allegiance info this is.
///   2. `AllegianceProfile`:
///      - `total_members: u32`, `total_vassals: u32`
///      - `AllegianceHierarchy` body (identical to the one inside
///        `AllegianceUpdate`).
///
/// `AllegianceUpdate` prefixes with `rank: u32` (not in the profile).
/// `InfoResponse` prefixes with `target_id: u32` and then writes the
/// AllegianceProfile WITHOUT the rank. The remaining body is identical
/// to `AllegianceUpdate`'s, so we share the body parser by exposing it
/// as `unpack_allegiance_profile_body` / `pack_allegiance_profile_body`.
#[derive(Debug, Clone, PartialEq)]
pub struct AllegianceInfoResponseEventData {
    pub target_id: Guid,
    pub total_members: u32,
    pub total_vassals: u32,
    pub officers: Vec<AllegianceOfficerEntry>,
    pub officer_titles: Vec<String>,
    pub monarch_broadcast_time: u32,
    pub monarch_broadcasts_today: u32,
    pub spokes_broadcast_time: u32,
    pub spokes_broadcasts_today: u32,
    pub motd: String,
    pub motd_set_by: String,
    pub chat_room_id: u32,
    pub bind_point: WorldPosition,
    pub allegiance_name: String,
    pub name_last_set_time: u32,
    pub is_locked: bool,
    pub approved_vassal: i32,
    pub monarch: Option<AllegianceDataEntry>,
    pub records: Vec<(Guid, AllegianceDataEntry)>,
}

impl ProtocolUnpack for AllegianceInfoResponseEventData {
    fn unpack(data: &[u8], offset: &mut usize) -> Option<Self> {
        if *offset + 4 > data.len() {
            return None;
        }
        let target_id = Guid(LittleEndian::read_u32(&data[*offset..*offset + 4]));
        *offset += 4;

        if *offset + 8 > data.len() {
            return None;
        }
        let total_members = LittleEndian::read_u32(&data[*offset..*offset + 4]);
        let total_vassals = LittleEndian::read_u32(&data[*offset + 4..*offset + 8]);
        *offset += 8;

        let body = unpack_allegiance_hierarchy_body(data, offset)?;
        Some(Self {
            target_id,
            total_members,
            total_vassals,
            officers: body.officers,
            officer_titles: body.officer_titles,
            monarch_broadcast_time: body.monarch_broadcast_time,
            monarch_broadcasts_today: body.monarch_broadcasts_today,
            spokes_broadcast_time: body.spokes_broadcast_time,
            spokes_broadcasts_today: body.spokes_broadcasts_today,
            motd: body.motd,
            motd_set_by: body.motd_set_by,
            chat_room_id: body.chat_room_id,
            bind_point: body.bind_point,
            allegiance_name: body.allegiance_name,
            name_last_set_time: body.name_last_set_time,
            is_locked: body.is_locked,
            approved_vassal: body.approved_vassal,
            monarch: body.monarch,
            records: body.records,
        })
    }
}

impl ProtocolPack for AllegianceInfoResponseEventData {
    fn pack(&self, buf: &mut Vec<u8>) {
        buf.write_u32::<LittleEndian>(self.target_id.0).unwrap();
        buf.write_u32::<LittleEndian>(self.total_members).unwrap();
        buf.write_u32::<LittleEndian>(self.total_vassals).unwrap();
        let body = AllegianceHierarchyBody {
            officers: self.officers.clone(),
            officer_titles: self.officer_titles.clone(),
            monarch_broadcast_time: self.monarch_broadcast_time,
            monarch_broadcasts_today: self.monarch_broadcasts_today,
            spokes_broadcast_time: self.spokes_broadcast_time,
            spokes_broadcasts_today: self.spokes_broadcasts_today,
            motd: self.motd.clone(),
            motd_set_by: self.motd_set_by.clone(),
            chat_room_id: self.chat_room_id,
            bind_point: self.bind_point.clone(),
            allegiance_name: self.allegiance_name.clone(),
            name_last_set_time: self.name_last_set_time,
            is_locked: self.is_locked,
            approved_vassal: self.approved_vassal,
            monarch: self.monarch.clone(),
            records: self.records.clone(),
        };
        pack_allegiance_hierarchy_body(buf, &body);
    }
}

/// Internal helper struct mirroring `AllegianceHierarchy` from
/// `external/chorizite/Chorizite.ACProtocol/Chorizite.ACProtocol/Types/
/// AllegianceHierarchy.generated.cs`. Used to share the body parser
/// between `AllegianceUpdate` (0x0020) and `AllegianceInfoResponse` (0x027C).
///
/// Not part of the public API — `AllegianceUpdateEventData` and
/// `AllegianceInfoResponseEventData` still expose their fields flat for
/// downstream consumers' convenience.
#[doc(hidden)]
pub struct AllegianceHierarchyBody {
    pub officers: Vec<AllegianceOfficerEntry>,
    pub officer_titles: Vec<String>,
    pub monarch_broadcast_time: u32,
    pub monarch_broadcasts_today: u32,
    pub spokes_broadcast_time: u32,
    pub spokes_broadcasts_today: u32,
    pub motd: String,
    pub motd_set_by: String,
    pub chat_room_id: u32,
    pub bind_point: WorldPosition,
    pub allegiance_name: String,
    pub name_last_set_time: u32,
    pub is_locked: bool,
    pub approved_vassal: i32,
    pub monarch: Option<AllegianceDataEntry>,
    pub records: Vec<(Guid, AllegianceDataEntry)>,
}

/// Shared body parser: reads everything in `AllegianceHierarchy.Read`
/// after the 8-byte `TotalMembers + TotalVassals` prefix (which both
/// `AllegianceUpdate` and `AllegianceInfoResponse` consume themselves).
pub fn unpack_allegiance_hierarchy_body(
    data: &[u8],
    offset: &mut usize,
) -> Option<AllegianceHierarchyBody> {
    if *offset + 4 > data.len() {
        return None;
    }
    let record_count = LittleEndian::read_u16(&data[*offset..*offset + 2]) as usize;
    let _old_version = LittleEndian::read_u16(&data[*offset + 2..*offset + 4]);
    *offset += 4;

    let (officer_count, _) = read_hashtable_header(data, offset)?;
    let mut officers = Vec::with_capacity(officer_count);
    for _ in 0..officer_count {
        if *offset + 8 > data.len() {
            return None;
        }
        let character_id = Guid(LittleEndian::read_u32(&data[*offset..*offset + 4]));
        let officer_level = LittleEndian::read_u32(&data[*offset + 4..*offset + 8]);
        *offset += 8;
        officers.push(AllegianceOfficerEntry {
            character_id,
            officer_level,
        });
    }

    if *offset + 4 > data.len() {
        return None;
    }
    let title_count = LittleEndian::read_u32(&data[*offset..*offset + 4]) as usize;
    *offset += 4;
    let mut officer_titles = Vec::with_capacity(title_count);
    for _ in 0..title_count {
        officer_titles.push(read_string16(data, offset)?);
    }

    if *offset + 16 > data.len() {
        return None;
    }
    let monarch_broadcast_time = LittleEndian::read_u32(&data[*offset..*offset + 4]);
    let monarch_broadcasts_today = LittleEndian::read_u32(&data[*offset + 4..*offset + 8]);
    let spokes_broadcast_time = LittleEndian::read_u32(&data[*offset + 8..*offset + 12]);
    let spokes_broadcasts_today = LittleEndian::read_u32(&data[*offset + 12..*offset + 16]);
    *offset += 16;

    let motd = read_string16(data, offset)?;
    let motd_set_by = read_string16(data, offset)?;

    if *offset + 4 > data.len() {
        return None;
    }
    let chat_room_id = LittleEndian::read_u32(&data[*offset..*offset + 4]);
    *offset += 4;

    let bind_point = WorldPosition::unpack(data, offset)?;
    let allegiance_name = read_string16(data, offset)?;

    if *offset + 12 > data.len() {
        return None;
    }
    let name_last_set_time = LittleEndian::read_u32(&data[*offset..*offset + 4]);
    let is_locked_raw = LittleEndian::read_u32(&data[*offset + 4..*offset + 8]);
    let approved_vassal = LittleEndian::read_i32(&data[*offset + 8..*offset + 12]);
    *offset += 12;
    let is_locked = is_locked_raw != 0;

    let monarch = if record_count > 0 {
        Some(AllegianceDataEntry::unpack(data, offset)?)
    } else {
        None
    };

    let mut records = Vec::with_capacity(record_count.saturating_sub(1));
    for _ in 1..record_count {
        if *offset + 4 > data.len() {
            return None;
        }
        let tree_parent = Guid(LittleEndian::read_u32(&data[*offset..*offset + 4]));
        *offset += 4;
        let entry = AllegianceDataEntry::unpack(data, offset)?;
        records.push((tree_parent, entry));
    }

    Some(AllegianceHierarchyBody {
        officers,
        officer_titles,
        monarch_broadcast_time,
        monarch_broadcasts_today,
        spokes_broadcast_time,
        spokes_broadcasts_today,
        motd,
        motd_set_by,
        chat_room_id,
        bind_point,
        allegiance_name,
        name_last_set_time,
        is_locked,
        approved_vassal,
        monarch,
        records,
    })
}

/// Shared body packer (inverse of `unpack_allegiance_hierarchy_body`).
pub fn pack_allegiance_hierarchy_body(buf: &mut Vec<u8>, body: &AllegianceHierarchyBody) {
    let monarch_present = body.monarch.is_some();
    let record_count = body.records.len() + if monarch_present { 1 } else { 0 };
    buf.write_u16::<LittleEndian>(record_count as u16).unwrap();
    // oldVersion — ACE always writes 0x000B (latest schema).
    buf.write_u16::<LittleEndian>(0x000B).unwrap();

    write_hashtable_header(buf, body.officers.len(), ALLEGIANCE_OFFICER_BUCKETS);
    for officer in &body.officers {
        buf.write_u32::<LittleEndian>(officer.character_id.0).unwrap();
        buf.write_u32::<LittleEndian>(officer.officer_level).unwrap();
    }

    buf.write_u32::<LittleEndian>(body.officer_titles.len() as u32)
        .unwrap();
    for title in &body.officer_titles {
        write_string16(buf, title);
    }

    buf.write_u32::<LittleEndian>(body.monarch_broadcast_time)
        .unwrap();
    buf.write_u32::<LittleEndian>(body.monarch_broadcasts_today)
        .unwrap();
    buf.write_u32::<LittleEndian>(body.spokes_broadcast_time)
        .unwrap();
    buf.write_u32::<LittleEndian>(body.spokes_broadcasts_today)
        .unwrap();

    write_string16(buf, &body.motd);
    write_string16(buf, &body.motd_set_by);
    buf.write_u32::<LittleEndian>(body.chat_room_id).unwrap();
    body.bind_point.pack(buf);
    write_string16(buf, &body.allegiance_name);
    buf.write_u32::<LittleEndian>(body.name_last_set_time)
        .unwrap();
    buf.write_u32::<LittleEndian>(u32::from(body.is_locked))
        .unwrap();
    buf.write_i32::<LittleEndian>(body.approved_vassal).unwrap();

    if let Some(monarch) = &body.monarch {
        monarch.pack(buf);
    }
    for (tree_parent, entry) in &body.records {
        buf.write_u32::<LittleEndian>(tree_parent.0).unwrap();
        entry.pack(buf);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::messages::{GameEvent, GameEventMessage, GameMessage};
    use holtburger_common::math::{Quaternion, Vector3};

    fn round_trip(msg: &GameEventMessage) {
        let mut packed = Vec::new();
        msg.pack(&mut packed);
        let mut offset = 0;
        let unpacked = GameEventMessage::unpack(&packed, &mut offset).expect("unpack failed");
        assert_eq!(offset, packed.len(), "extra bytes left after unpack");
        assert_eq!(&unpacked, msg, "round-trip mismatch");
    }

    /// Wave J5.B follow-on (2026-05-27): also dump the FULL wire shape
    /// (outer `GameMessage::GameEvent` wrapper — opcode 0xF7B0 + target +
    /// sequence + event_type + payload) as hex when the
    /// `DUMP_FIXTURE_HEX` env var is set. Used to extract bytes the
    /// `validate_wire_conformance.cjs` `unpackOnly` fixtures consume.
    /// Bypasses the upstream Chorizite `Write(bool)=1byte` /
    /// `ReadBool()=4byte` asymmetry — Rust's bool→u32 pack matches
    /// what Chorizite's reader expects (handoff §2 row 10).
    fn dump_fixture_hex_if_requested(name: &str, msg: &GameEventMessage) {
        if std::env::var("DUMP_FIXTURE_HEX").ok().as_deref() == Some("1") {
            let game_msg = GameMessage::GameEvent(Box::new(msg.clone()));
            let mut packed = Vec::new();
            game_msg.pack(&mut packed);
            eprintln!("FIXTURE_HEX[{}]: {}", name, hex::encode(&packed));
        }
    }

    fn sample_data_entry(name: &str, rank: u16, level: u32, guid: u32) -> AllegianceDataEntry {
        AllegianceDataEntry {
            character_id: Guid(guid),
            cp_cached: 1234,
            cp_tithed: 5678,
            bitfield: AllegianceIndexFlags(
                AllegianceIndexFlags::HAS_ALLEGIANCE_AGE
                    | AllegianceIndexFlags::HAS_PACKED_LEVEL
                    | AllegianceIndexFlags::LOGGED_IN,
            ),
            gender: 1,
            heritage_group: 1,
            rank,
            level,
            loyalty: 200,
            leadership: 150,
            time_online: 7200,
            allegiance_age: 3600,
            name: name.to_string(),
        }
    }

    #[test]
    fn allegiance_update_round_trip_full_tree() {
        let monarch = sample_data_entry("MonarchMartine", 5, 60, 0x5000_1111);
        let patron = sample_data_entry("PatronPaulina", 3, 40, 0x5000_2222);
        let myself = sample_data_entry("SelfStorm", 1, 25, 0x5000_3333);
        let vassal = sample_data_entry("VassalVal", 1, 12, 0x5000_4444);

        let event = AllegianceUpdateEventData {
            rank: 1,
            total_members: 4,
            total_vassals: 1,
            officers: vec![AllegianceOfficerEntry {
                character_id: Guid(0x5000_1111),
                officer_level: 1,
            }],
            officer_titles: vec!["Speaker".to_string()],
            monarch_broadcast_time: 0,
            monarch_broadcasts_today: 0,
            spokes_broadcast_time: 0,
            spokes_broadcasts_today: 0,
            motd: "Welcome adventurers".to_string(),
            motd_set_by: "MonarchMartine".to_string(),
            chat_room_id: 0xCAFE,
            bind_point: WorldPosition {
                landblock_id: Guid(0xA9B40119),
                coords: Vector3 {
                    x: 96.0,
                    y: 96.0,
                    z: 0.5,
                },
                rotation: Quaternion {
                    w: 1.0,
                    x: 0.0,
                    y: 0.0,
                    z: 0.0,
                },
            },
            allegiance_name: "Sons of the Crater".to_string(),
            name_last_set_time: 1_712_345_000,
            is_locked: true,
            approved_vassal: 0,
            monarch: Some(monarch),
            records: vec![
                (Guid(0x5000_1111), patron),
                (Guid(0x5000_2222), myself),
                (Guid(0x5000_3333), vassal),
            ],
        };

        let msg = GameEventMessage {
            target: Guid(0x5000_3333),
            sequence: 0x42,
            event: GameEvent::AllegianceUpdate(Box::new(event)),
        };
        round_trip(&msg);
    }

    #[test]
    fn allegiance_update_round_trip_empty() {
        let event = AllegianceUpdateEventData {
            rank: 0,
            total_members: 0,
            total_vassals: 0,
            officers: vec![],
            officer_titles: vec![],
            monarch_broadcast_time: 0,
            monarch_broadcasts_today: 0,
            spokes_broadcast_time: 0,
            spokes_broadcasts_today: 0,
            motd: String::new(),
            motd_set_by: String::new(),
            chat_room_id: 0,
            bind_point: WorldPosition::default(),
            allegiance_name: String::new(),
            name_last_set_time: 0,
            is_locked: false,
            approved_vassal: 0,
            monarch: None,
            records: vec![],
        };
        let msg = GameEventMessage {
            target: Guid(0x5000_0001),
            sequence: 1,
            event: GameEvent::AllegianceUpdate(Box::new(event)),
        };
        round_trip(&msg);
    }

    // Wave-F3 (2026-05-27): AllegianceLoginNotification (0x027A) — small
    // (8-byte) payload, no shared body. Verifies ReadBool=u32 invariant.
    #[test]
    fn allegiance_login_notification_round_trip_login() {
        let event = AllegianceLoginNotificationEventData {
            character_id: Guid(0x5000_1234),
            is_logged_in: true,
        };
        let msg = GameEventMessage {
            target: Guid(0x5000_3333),
            sequence: 0x10,
            event: GameEvent::AllegianceLoginNotification(Box::new(event)),
        };
        round_trip(&msg);
        dump_fixture_hex_if_requested("allegiance_login_notification_login", &msg);
    }

    #[test]
    fn allegiance_login_notification_round_trip_logout() {
        let event = AllegianceLoginNotificationEventData {
            character_id: Guid(0x5000_ABCD),
            is_logged_in: false,
        };
        let msg = GameEventMessage {
            target: Guid(0x5000_3333),
            sequence: 0x11,
            event: GameEvent::AllegianceLoginNotification(Box::new(event)),
        };
        round_trip(&msg);
        dump_fixture_hex_if_requested("allegiance_login_notification_logout", &msg);
    }

    // Wave-F3 (2026-05-27): AllegianceInfoResponse (0x027C) — shares the
    // body with AllegianceUpdate (0x0020). Verifies the shared-body
    // refactor's round-trip parity using a non-trivial hierarchy.
    #[test]
    fn allegiance_info_response_round_trip() {
        let monarch = sample_data_entry("MonarchQuerymark", 5, 70, 0x6000_1111);
        let patron = sample_data_entry("PatronQ", 3, 50, 0x6000_2222);

        let event = AllegianceInfoResponseEventData {
            target_id: Guid(0x6000_3333),
            total_members: 2,
            total_vassals: 1,
            officers: vec![AllegianceOfficerEntry {
                character_id: Guid(0x6000_1111),
                officer_level: 2,
            }],
            officer_titles: vec!["Speaker".to_string(), "Seneschal".to_string()],
            monarch_broadcast_time: 12345,
            monarch_broadcasts_today: 3,
            spokes_broadcast_time: 0,
            spokes_broadcasts_today: 0,
            motd: "Reply MOTD".to_string(),
            motd_set_by: "MonarchQuerymark".to_string(),
            chat_room_id: 0xDEAD,
            bind_point: WorldPosition {
                landblock_id: Guid(0xA9B40119),
                coords: Vector3 {
                    x: 100.0,
                    y: 80.0,
                    z: 0.0,
                },
                rotation: Quaternion {
                    w: 1.0,
                    x: 0.0,
                    y: 0.0,
                    z: 0.0,
                },
            },
            allegiance_name: "Sample Allegiance".to_string(),
            name_last_set_time: 1_700_000_000,
            is_locked: false,
            approved_vassal: 0,
            monarch: Some(monarch),
            records: vec![(Guid(0x6000_1111), patron)],
        };
        let msg = GameEventMessage {
            target: Guid(0x6000_3333),
            sequence: 0x20,
            event: GameEvent::AllegianceInfoResponse(Box::new(event)),
        };
        round_trip(&msg);
        dump_fixture_hex_if_requested("allegiance_info_response", &msg);
    }

    #[test]
    fn allegiance_info_response_round_trip_empty() {
        let event = AllegianceInfoResponseEventData {
            target_id: Guid(0x6000_AAAA),
            total_members: 0,
            total_vassals: 0,
            officers: vec![],
            officer_titles: vec![],
            monarch_broadcast_time: 0,
            monarch_broadcasts_today: 0,
            spokes_broadcast_time: 0,
            spokes_broadcasts_today: 0,
            motd: String::new(),
            motd_set_by: String::new(),
            chat_room_id: 0,
            bind_point: WorldPosition::default(),
            allegiance_name: String::new(),
            name_last_set_time: 0,
            is_locked: false,
            approved_vassal: 0,
            monarch: None,
            records: vec![],
        };
        let msg = GameEventMessage {
            target: Guid(0x6000_AAAA),
            sequence: 0x21,
            event: GameEvent::AllegianceInfoResponse(Box::new(event)),
        };
        round_trip(&msg);
    }
}
