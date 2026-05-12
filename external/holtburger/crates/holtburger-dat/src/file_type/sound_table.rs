//! AC SoundTable (DatFileType 0x20) — `DB_TYPE_STABLE` in the client.
//! Maps a `Sound` enum value (u32) onto a weighted list of Wave DIDs.
//! Used by:
//!
//! - **Region SoundDesc → AmbientSTBDesc.stb_id** — each STB on a
//!   Region (e.g. Region `0x13000000` carries ~37 STBs) points at a
//!   SoundTable. The active terrain's SceneType picks one STB via
//!   `stb_index`, and the runtime resolves each `Sound.Ambient1..8`
//!   entry through that STB's SoundTable to find Wave DIDs to play.
//! - **Entity weenie `PropertyDataId::SoundTable` (=3)** — every
//!   sound-producing object (forge, fountain, NPC) references its own
//!   SoundTable. Animation hooks (hook type 1 = `Sound`, hook type 2 =
//!   `SoundTable`) fire `Sound` enum keys at specific keyframes; we
//!   look them up in the entity's SoundTable to find the Wave DID.
//! - **ACE `GameMessageSound`** — server-pushed sound events use the
//!   same lookup path.
//!
//! ID range: `0x20000000..=0x2000FFFF`. Retail Dereth's client_portal.dat
//! ships dozens of records here (forge, lifestone, switch, NPC voice
//! tables, etc.).
//!
//! ## Wire layout
//!
//! Mirrors `external/DatReaderWriter/DatReaderWriter/dats.xml:3918-3927`:
//!
//! ```text
//! [u32 id]                              // matches DAT directory entry
//! [i32 hash_key]
//! [i32 num_hashes]
//! Hash × num_hashes:                    // schema: <vector type="Dictionary">
//!   [u32 key]
//!   SoundHashData:
//!     [f32 priority]
//!     [f32 probability]
//!     [f32 volume]
//! [i32 num_sounds]
//! Sound × num_sounds:                   // schema: <vector type="Dictionary">
//!   [u32 sound_enum_key]                // Sound enum (0x46-0x4D = Ambient1..8)
//!   SoundData:
//!     [u32 num_entries]
//!     SoundEntry × num_entries:
//!       [u32 wave_did]                  // QualifiedDataId<Wave> — see GOTCHA
//!       [f32 priority]
//!       [f32 probability]
//!       [f32 volume]
//!     [i32 unknown]                     // schema: "Unknown" — purpose unclear
//! ```
//!
//! ## Schema-vs-wire gotcha (same family as ParticleEmitter)
//!
//! `dats.xml` annotates `SoundEntry.Id` as
//! `<vector type="QualifiedDataId" genericValue="Wave"/>` — the same
//! `<vector>`-but-actually-scalar pattern documented in
//! `particle_emitter.rs`. On the wire `SoundEntry.Id` is a single u32
//! DWORD (one Wave DID, typically `0x0AxxxxxX`), not a count-prefixed
//! list. Verified two ways:
//!
//! 1. ACE's `DatReaderWriter.Tests/DBObjs/SoundTableTests.cs:29`
//!    constructs `new SoundEntry() { Id = 1, ... }` (one scalar uint).
//! 2. The same test's EOR probe (line 84) reads
//!    `readObj.Sounds[Sound.ShieldUp].Entries.First().Id == 0x0A000262u`
//!    — exactly one DWORD per entry.
//!
//! Treat `SoundEntry.Id` as `u32`. Don't read a count prefix in front
//! of it.
//!
//! ## SoundHashData semantics
//!
//! The `Hashes` dictionary is separate from `Sounds`. Its purpose
//! isn't documented in PhatSDK or ACE runtime — possibly a string-key
//! lookup table for client UI sound references, or a fallback /
//! redirect map. The wire shape is unambiguous (3 floats per value)
//! so parsing it is trivial; we just don't yet know what to *do* with
//! it at the runtime layer. Not load-bearing for ambient playback;
//! the chain in the doc plan only needs `Sounds[Sound.AmbientN]`.

use binrw::{
    BinRead, BinResult,
    io::{Read, Seek},
};
use std::collections::HashMap;

/// One entry in the `Hashes` dictionary. Schema field name in
/// `dats.xml`: `SoundHashData`. Purpose at the runtime layer isn't
/// documented (see module docs); the wire shape is just three floats.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SoundHashData {
    pub priority: f32,
    pub probability: f32,
    pub volume: f32,
}

impl SoundHashData {
    pub fn read<R: Read + Seek>(reader: &mut R) -> BinResult<Self> {
        let priority = f32::read_le(reader)?;
        let probability = f32::read_le(reader)?;
        let volume = f32::read_le(reader)?;
        Ok(Self {
            priority,
            probability,
            volume,
        })
    }
}

/// One Wave reference within a `SoundData` entry list. Schema name:
/// `SoundEntry`. Note `wave_did` is a scalar u32 on the wire despite
/// the schema's misleading `<vector type="QualifiedDataId">` annotation
/// — see module docs.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SoundEntry {
    /// Wave DAT ID (`0x0Axxxxxx`). Schema name `Id`.
    pub wave_did: u32,
    pub priority: f32,
    pub probability: f32,
    pub volume: f32,
}

impl SoundEntry {
    pub fn read<R: Read + Seek>(reader: &mut R) -> BinResult<Self> {
        let wave_did = u32::read_le(reader)?;
        let priority = f32::read_le(reader)?;
        let probability = f32::read_le(reader)?;
        let volume = f32::read_le(reader)?;
        Ok(Self {
            wave_did,
            priority,
            probability,
            volume,
        })
    }
}

/// The value side of one `Sounds` dictionary entry — a flat list of
/// `SoundEntry` records plus a trailing `unknown` i32 the schema calls
/// out but doesn't document. Schema name: `SoundData`.
#[derive(Debug, Clone, Default)]
pub struct SoundData {
    pub entries: Vec<SoundEntry>,
    /// Schema-named `Unknown`. Always present at the tail of each
    /// SoundData record; purpose isn't documented in `dats.xml`,
    /// `PhatSDK`, or `ACE.Server.Physics.Sound.SoundData`.
    pub unknown: i32,
}

impl SoundData {
    pub fn read<R: Read + Seek>(reader: &mut R) -> BinResult<Self> {
        let num_entries = u32::read_le(reader)? as usize;
        let mut entries = Vec::with_capacity(num_entries);
        for _ in 0..num_entries {
            entries.push(SoundEntry::read(reader)?);
        }
        let unknown = i32::read_le(reader)?;
        Ok(Self { entries, unknown })
    }
}

/// AC SoundTable file (`0x20xxxxxx`). Parse via [`SoundTable::unpack`].
#[derive(Debug, Clone)]
pub struct SoundTable {
    /// File ID — must equal the DAT directory key.
    pub id: u32,
    /// Schema field `HashKey`. The `dats.xml` description calls this
    /// `DB_TYPE_STABLE`'s name-hash anchor; runtime doesn't read it
    /// in any known code path.
    pub hash_key: i32,
    /// Auxiliary hash dictionary. Semantics unclear (see module docs);
    /// always parses cleanly across retail records.
    pub hashes: HashMap<u32, SoundHashData>,
    /// Primary lookup dictionary — `Sound` enum value to weighted Wave list.
    pub sounds: HashMap<u32, SoundData>,
}

impl SoundTable {
    pub fn read<R: Read + Seek>(reader: &mut R) -> BinResult<Self> {
        let id = u32::read_le(reader)?;
        let hash_key = i32::read_le(reader)?;

        let num_hashes = i32::read_le(reader)?.max(0) as usize;
        let mut hashes = HashMap::with_capacity(num_hashes);
        for _ in 0..num_hashes {
            let key = u32::read_le(reader)?;
            let value = SoundHashData::read(reader)?;
            hashes.insert(key, value);
        }

        let num_sounds = i32::read_le(reader)?.max(0) as usize;
        let mut sounds = HashMap::with_capacity(num_sounds);
        for _ in 0..num_sounds {
            let key = u32::read_le(reader)?;
            let value = SoundData::read(reader)?;
            sounds.insert(key, value);
        }

        Ok(Self {
            id,
            hash_key,
            hashes,
            sounds,
        })
    }

    pub fn unpack(data: &[u8]) -> Result<Self, binrw::Error> {
        let mut cursor = std::io::Cursor::new(data);
        Self::read(&mut cursor)
    }

    /// Convenience: look up the entries for a `Sound` enum value
    /// (e.g. `0x46` for `Sound.Ambient1`). Returns `None` if no
    /// mapping for this sound key exists.
    pub fn entries_for(&self, sound_enum: u32) -> Option<&[SoundEntry]> {
        self.sounds.get(&sound_enum).map(|sd| sd.entries.as_slice())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn open_retail_dat() -> Option<crate::DatDatabase> {
        let path = if let Some(p) = crate::utils::get_portal_dat_path() {
            p
        } else {
            let retail =
                std::path::PathBuf::from("/home/wbterminal/projects/RetailSmoke/dats/base/client_portal.dat");
            if retail.exists() {
                retail
            } else {
                let alt = std::path::PathBuf::from("/home/wbterminal/ac_base_dats/client_portal.dat");
                if alt.exists() {
                    alt
                } else {
                    eprintln!("SKIP — no retail client_portal.dat available");
                    return None;
                }
            }
        };
        Some(crate::DatDatabase::new(&path).expect("open dat"))
    }

    /// Synthetic round-trip: pack a minimal SoundTable and read it back.
    /// Mirrors `DatReaderWriter.Tests/DBObjs/SoundTableTests.cs::CanInsertAndRead`.
    #[test]
    fn synthetic_sound_table_roundtrips() {
        let mut buf = Vec::new();
        // id
        buf.extend_from_slice(&0x20000001u32.to_le_bytes());
        // hash_key
        buf.extend_from_slice(&123i32.to_le_bytes());
        // num_hashes = 1
        buf.extend_from_slice(&1i32.to_le_bytes());
        // hash entry: key=1, (0.0, 1.0, 1.0)
        buf.extend_from_slice(&1u32.to_le_bytes());
        buf.extend_from_slice(&0.0f32.to_le_bytes());
        buf.extend_from_slice(&1.0f32.to_le_bytes());
        buf.extend_from_slice(&1.0f32.to_le_bytes());
        // num_sounds = 1
        buf.extend_from_slice(&1i32.to_le_bytes());
        // sound entry: key=Sound.ArrowLand (use a sentinel u32 value)
        buf.extend_from_slice(&0x12u32.to_le_bytes());
        // SoundData: num_entries=1, entry(id=1, 0.0, 1.0, 1.0), unknown=0
        buf.extend_from_slice(&1u32.to_le_bytes());
        buf.extend_from_slice(&1u32.to_le_bytes());
        buf.extend_from_slice(&0.0f32.to_le_bytes());
        buf.extend_from_slice(&1.0f32.to_le_bytes());
        buf.extend_from_slice(&1.0f32.to_le_bytes());
        buf.extend_from_slice(&0i32.to_le_bytes());

        let st = SoundTable::unpack(&buf).expect("unpack synthetic");
        assert_eq!(st.id, 0x20000001);
        assert_eq!(st.hash_key, 123);
        assert_eq!(st.hashes.len(), 1);
        let h = st.hashes.get(&1u32).expect("hash key 1");
        assert_eq!(h.priority, 0.0);
        assert_eq!(h.probability, 1.0);
        assert_eq!(h.volume, 1.0);
        assert_eq!(st.sounds.len(), 1);
        let sd = st.sounds.get(&0x12u32).expect("sound key 0x12");
        assert_eq!(sd.entries.len(), 1);
        assert_eq!(sd.entries[0].wave_did, 1);
        assert_eq!(sd.entries[0].priority, 0.0);
        assert_eq!(sd.entries[0].probability, 1.0);
        assert_eq!(sd.entries[0].volume, 1.0);
        assert_eq!(sd.unknown, 0);
    }

    /// Cross-check against the EOR probe in DatReaderWriter's
    /// SoundTableTests.cs::CanReadEOR: 0x20000001 has 1 hash (key 0,
    /// values 0/1/1), 52 sounds, ShieldUp → 0x0A000262 (priority 0.7,
    /// volume 1.0).
    #[test]
    fn probe_retail_sound_table_0x20000001() {
        let Some(dat) = open_retail_dat() else { return };
        let bytes = dat
            .get_file(0x20000001)
            .expect("0x20000001 must exist in retail");
        let st = SoundTable::unpack(&bytes).expect("parse 0x20000001");
        assert_eq!(st.id, 0x20000001);
        assert_eq!(st.hash_key, 0);
        assert_eq!(st.hashes.len(), 1);
        let h0 = st.hashes.get(&0u32).expect("hash key 0");
        assert_eq!(h0.priority, 0.0);
        assert_eq!(h0.probability, 1.0);
        assert_eq!(h0.volume, 1.0);
        assert_eq!(st.sounds.len(), 52);

        // Sound.ShieldUp = 0x58 per ACE.Entity/Enum/Sound.cs.
        // (NOT 0x9B — TriggerActivated4 is at 0x9B; ShieldUp is 0x58.)
        // Cross-referenced via DatReaderWriter's SoundTableTests.cs:84
        // which expects ShieldUp → 0x0A000262 in retail 0x20000001.
        let shield_up_key = 0x58u32;
        let entries = st
            .entries_for(shield_up_key)
            .expect("Sound.ShieldUp (0x58) must be present in 0x20000001");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].wave_did, 0x0A000262);
        assert_eq!(entries[0].priority, 0.7);
        assert_eq!(entries[0].probability, 1.0);
        assert_eq!(entries[0].volume, 1.0);

        // Cross-check Sound.EnchantDown (0x5B) → 0x0A000274, volume 0.8
        let enchant_down = st
            .entries_for(0x5B)
            .expect("Sound.EnchantDown (0x5B) must be present");
        assert_eq!(enchant_down.len(), 1);
        assert_eq!(enchant_down[0].wave_did, 0x0A000274);
        assert_eq!(enchant_down[0].priority, 0.7);
        assert_eq!(enchant_down[0].probability, 1.0);
        assert_eq!(enchant_down[0].volume, 0.8);
    }

    /// Targeted probe: 0x20000014 is the Alchemy Forge's SoundTable
    /// (per the user-confirmed weenie attribute dump from memory
    /// `project_holtburg_h2_h3_done_2026-05-12` and the doc plan at
    /// lines 291-300).
    ///
    /// **FINDING vs doc plan:** the plan's claim that
    /// `Sounds[Sound.Ambient1]` is present in the forge SoundTable
    /// is contradicted by the wire data — the forge carries 21 sound
    /// keys (0x2E ArrowLand, 0x51 LifestoneOn, 0x58 ShieldUp, etc.)
    /// but NOT 0x46 (Ambient1). This makes sense in retrospect: the
    /// forge's ambient crackle isn't on the per-tick ambient roller
    /// (which is Region-keyed); it's animation-hook-driven from the
    /// forge's idle clip via Sound (1) / SoundTable (2) hooks. The
    /// Ambient1 lookup path lives on the Region-attached STBs
    /// (0x20000080, 0x20000081, 0x200000B3, etc. — see
    /// `region.rs::sound_probe::probe_region_1_ambient_sounds`
    /// output: STB[33-36] all carry s_type=0x46/Ambient1 ambient
    /// descriptors).
    ///
    /// What we DO assert: the forge SoundTable parses cleanly, has
    /// 21 sound keys, and every entry's `wave_did` is a `0x0A`
    /// prefix (Wave DID). Plus targeted assertions for the actual
    /// keys present (ArrowLand → 0x0A00008C, etc.).
    #[test]
    fn probe_retail_forge_sound_table() {
        let Some(dat) = open_retail_dat() else { return };
        let bytes = dat
            .get_file(0x20000014)
            .expect("0x20000014 (forge SoundTable) must exist");
        let st = SoundTable::unpack(&bytes).expect("parse 0x20000014");
        assert_eq!(st.id, 0x20000014);
        assert_eq!(st.hashes.len(), 1);
        assert_eq!(
            st.sounds.len(),
            21,
            "forge SoundTable has 21 sound keys (verified against retail wire)"
        );
        eprintln!(
            "[forge SoundTable] id=0x{:08X} hash_key={} hashes={} sounds={}",
            st.id,
            st.hash_key,
            st.hashes.len(),
            st.sounds.len()
        );
        let mut keys: Vec<u32> = st.sounds.keys().copied().collect();
        keys.sort();
        for k in &keys {
            let sd = st.sounds.get(k).unwrap();
            let first = sd.entries.first().map(|e| e.wave_did).unwrap_or(0);
            eprintln!(
                "  sound 0x{:02X} → {} entries, first wave_did=0x{:08X}",
                k,
                sd.entries.len(),
                first
            );
        }
        // Every entry's wave_did must be a Wave DID (0x0A prefix).
        // This is the core invariant the chain depends on.
        let mut total_entries = 0usize;
        for sd in st.sounds.values() {
            for e in &sd.entries {
                total_entries += 1;
                assert_eq!(
                    e.wave_did >> 24,
                    0x0A,
                    "wave_did 0x{:08X} must be a Wave DID (0x0A prefix)",
                    e.wave_did
                );
            }
        }
        assert!(total_entries > 0, "forge SoundTable must have entries");

        // Sound.ArrowLand (0x2E) is the forge's first key per the
        // dump — verify the actual mapping.
        let arrow_land = st
            .entries_for(0x2E)
            .expect("Sound.ArrowLand (0x2E) present in forge");
        assert!(!arrow_land.is_empty());
        assert_eq!(arrow_land[0].wave_did, 0x0A00008C);

        // FINDING ASSERTION: doc-claimed Ambient1 (0x46) is NOT here.
        // Documenting this with an explicit check so a future agent
        // doesn't re-introduce the plan's incorrect claim.
        assert!(
            st.entries_for(0x46).is_none(),
            "Sound.Ambient1 (0x46) is NOT in forge SoundTable 0x20000014 — \
             the doc plan's claim is incorrect against retail wire data. \
             Forge ambient crackle is animation-hook-driven, not ambient-roller-driven."
        );
    }

    /// Region-attached ambient STB probe: 0x20000081 is one of the
    /// STBs referenced by Region 0x13000000's SoundDesc. Verified via
    /// `region.rs::sound_probe::probe_region_1_ambient_sounds` that
    /// STB[34] is 0x20000081 and its AmbientSoundDesc list includes
    /// `s_type=0x46 (Ambient1) base_chance=0.0` entries (i.e.
    /// continuous-loop ambient). This SoundTable must therefore have
    /// a `Sounds[0x46]` mapping pointing at a Wave DID, which is what
    /// the runtime ambient roller will look up.
    ///
    /// This is the equivalent of the doc plan's "Sound.Ambient1 →
    /// Wave DID" assertion — just on the correct SoundTable (a
    /// Region-attached ambient STB) instead of the forge.
    #[test]
    fn probe_retail_ambient_stb_sound_table() {
        let Some(dat) = open_retail_dat() else { return };
        let bytes = dat
            .get_file(0x20000081)
            .expect("0x20000081 (Region ambient STB) must exist");
        let st = SoundTable::unpack(&bytes).expect("parse 0x20000081");
        assert_eq!(st.id, 0x20000081);
        eprintln!(
            "[ambient STB 0x20000081] hash_key={} hashes={} sounds={}",
            st.hash_key,
            st.hashes.len(),
            st.sounds.len()
        );

        // Sound.Ambient1 = 0x46 — verified present per Region SoundDesc
        // analysis (STB[34] carries 0x46 ambient entries).
        let entries = st
            .entries_for(0x46)
            .expect("Sound.Ambient1 (0x46) MUST be present in Region ambient STB");
        assert!(
            !entries.is_empty(),
            "Sound.Ambient1 entries must not be empty"
        );
        for e in entries {
            assert_eq!(
                e.wave_did >> 24,
                0x0A,
                "Ambient1 wave_did 0x{:08X} must be a Wave DID (0x0A prefix)",
                e.wave_did
            );
            eprintln!(
                "  Ambient1 entry: wave=0x{:08X} priority={} probability={} volume={}",
                e.wave_did, e.priority, e.probability, e.volume
            );
        }
    }

    /// Sweep every 0x20000000..=0x2000FFFF record in the retail DAT
    /// and assert 100% parse success. Mirrors
    /// `particle_emitter.rs::probe_retail_particle_emitter_chain`.
    #[test]
    fn probe_all_retail_sound_tables() {
        let Some(dat) = open_retail_dat() else { return };
        let mut total = 0usize;
        let mut total_hashes = 0usize;
        let mut total_sounds = 0usize;
        let mut total_entries = 0usize;
        let mut max_sounds = 0usize;
        let mut max_id = 0u32;
        for id in 0x2000_0000u32..=0x2000_FFFFu32 {
            let bytes = match dat.get_file(id) {
                Ok(b) => b,
                Err(_) => continue,
            };
            let st = SoundTable::unpack(&bytes)
                .unwrap_or_else(|e| panic!("parse 0x{id:08X} ({} bytes): {e:?}", bytes.len()));
            assert_eq!(
                st.id, id,
                "id field must match directory key for 0x{id:08X}"
            );
            total += 1;
            total_hashes += st.hashes.len();
            total_sounds += st.sounds.len();
            for sd in st.sounds.values() {
                total_entries += sd.entries.len();
            }
            if st.sounds.len() > max_sounds {
                max_sounds = st.sounds.len();
                max_id = st.id;
            }
        }
        eprintln!(
            "[probe_all_retail_sound_tables] {total} tables, {total_hashes} total hashes, \
             {total_sounds} total sound keys, {total_entries} total entries; \
             widest table = 0x{max_id:08X} with {max_sounds} sound keys"
        );
        assert!(
            total > 50,
            "expected many retail SoundTables; got {total}"
        );
    }
}
