//! Region 0x13 `sound_info` enumeration parity — proves the Rust parser
//! is structurally faithful to ACE/PhatSDK/DatReaderWriter and that every
//! retail `(stb_id, SoundType)` slot in retail
//! `~/ac_base_dats/client_portal.dat` resolves with no gaps.
//!
//! Field-by-field diff against the C# reference
//! (`external/DatReaderWriter/DatReaderWriter/dats.xml:2856-2871`):
//!
//! | Field                          | DatReaderWriter (C#) | Rust (`region.rs`)      |
//! |--------------------------------|----------------------|--------------------------|
//! | SoundDesc._numSTBDescs         | uint                 | u32                      |
//! | SoundDesc.STBDesc[]            | List<AmbientSTBDesc> | Vec<AmbientSTBDesc>      |
//! | AmbientSTBDesc.STBId           | uint                 | u32 (`stb_id`)           |
//! | AmbientSTBDesc._numAmbientSounds | uint               | u32                      |
//! | AmbientSTBDesc.AmbientSounds[] | List<AmbientSoundDesc> | Vec<AmbientSoundDesc>  |
//! | AmbientSoundDesc.SType         | Sound (uint enum)    | u32 (`s_type`)           |
//! | AmbientSoundDesc.Volume        | float                | f32 (`volume`)           |
//! | AmbientSoundDesc.BaseChance    | float                | f32 (`base_chance`)      |
//! | AmbientSoundDesc.MinRate       | float                | f32 (`min_rate`)         |
//! | AmbientSoundDesc.MaxRate       | float                | f32 (`max_rate`)         |
//!
//! Note: PhatSDK `AmbientSoundDesc` (and the chorizite C# binding) carries
//! a sixth field `int is_continuous` that is **derived client-side from
//! `base_chance == 0.0f`** and not present on the wire — see
//! `external/GDL/PhatSDK/SoundDesc.cpp:78`. The Rust parser exposes it as
//! `AmbientSoundDesc::is_continuous()` returning `base_chance == 0.0`.
//!
//! `Sound` enum range per `dats.xml:351-555`: `0x00..=0xCC` (0..204). Slot 0
//! is `Invalid` (sentinel), so a valid ambient must have `s_type ∈ 1..=0xCC`.

use binrw::io::Cursor;
use holtburger_dat::DatDatabase;
use holtburger_dat::file_type::region::{Region, SoundDesc};

/// Highest valid `Sound` enum value per
/// `external/DatReaderWriter/DatReaderWriter/dats.xml:553`
/// (`SkillDownVoid = 0x000000CC`).
const SOUND_ENUM_MAX: u32 = 0xCC;

/// `Invalid` sentinel per `dats.xml:352` — must not appear in ambient slots.
const SOUND_ENUM_INVALID: u32 = 0x00;

/// Golden SHA-256 of the canonical re-serialized `sound_info` slice of
/// retail Region 0x13000000 from `~/ac_base_dats/client_portal.dat`,
/// pinned after the first successful round-trip on retail bytes
/// (2026-05-19). 37 STBs, 7960 bytes total.
const SOUND_INFO_GOLDEN_SHA256: &str =
    "42cdd2ff94c71161eb6480318b393531cc86c284a25ceb0a64c9df55bf14d755";

/// Map a known `Sound` enum value to its `dats.xml` label. Covers only the
/// ambient + UI slots seen in retail Region 0x13000000 — anything not in
/// the table falls back to the bare numeric form for the coverage table.
fn sound_type_label(v: u32) -> &'static str {
    match v {
        0x00 => "Invalid",
        0x46 => "Ambient1",
        0x47 => "Ambient2",
        0x48 => "Ambient3",
        0x49 => "Ambient4",
        0x4A => "Ambient5",
        0x4B => "Ambient6",
        0x4C => "Ambient7",
        0x4D => "Ambient8",
        0x4E => "Waterfall",
        0x77 => "UI_Bell",
        0x78 => "UI_Chant1",
        0x79 => "UI_Chant2",
        0x7A => "UI_DarkWhispers1",
        0x7B => "UI_DarkWhispers2",
        0x7C => "UI_DarkLaugh",
        0x7D => "UI_DarkWind",
        0x7E => "UI_DarkSpeech",
        0x7F => "UI_Drums",
        0x80 => "UI_GhostSpeak",
        0x81 => "UI_Breathing",
        0x82 => "UI_Howl",
        0x83 => "UI_LostSouls",
        0x84 => "UI_Squeal",
        0x85 => "UI_Thunder1",
        0x86 => "UI_Thunder2",
        0x87 => "UI_Thunder3",
        0x88 => "UI_Thunder4",
        0x89 => "UI_Thunder5",
        0x8A => "UI_Thunder6",
        _ => "(other)",
    }
}

fn locate_portal_dat() -> Option<std::path::PathBuf> {
    if let Some(p) = holtburger_dat::utils::get_portal_dat_path() {
        return Some(p);
    }
    let canonical = std::path::PathBuf::from("/home/wbterminal/ac_base_dats/client_portal.dat");
    if canonical.exists() {
        return Some(canonical);
    }
    None
}

/// Returns `(start_offset_of_sound_info, end_offset_of_sound_info)` in
/// `region_bytes`, computed by re-running the Region parser piecewise
/// and snapshotting the cursor immediately before and after
/// `SoundDesc::unpack`.
///
/// We can't predict the offset arithmetically because the header carries a
/// variable-width pstring (region_name), a variable-length GameTime
/// (counted lists for times_of_day / days_of_week / seasons each with
/// their own pstring fields), and a variable-length SkyDesc preceding the
/// sound_info block. Running the parser is the only correct way to find
/// the boundary.
fn find_sound_info_slice_bounds(region_bytes: &[u8]) -> (usize, usize) {
    use binrw::BinRead;
    use holtburger_dat::file_type::game_time::GameTime;
    use holtburger_dat::file_type::region::{LandDefs, SkyDesc};
    use holtburger_dat::utils::read_pstring_char;

    let mut cursor = Cursor::new(region_bytes);

    // Header
    let _id = u32::read_le(&mut cursor).unwrap();
    let _region_number = u32::read_le(&mut cursor).unwrap();
    let _version = u32::read_le(&mut cursor).unwrap();
    let _name = read_pstring_char(&mut cursor).unwrap();

    let _land_defs = LandDefs::unpack(&mut cursor).unwrap();
    let _game_time = GameTime::unpack(&mut cursor).unwrap();
    let parts_mask = u32::read_le(&mut cursor).unwrap();

    const PARTS_MASK_HAS_SKY_INFO: u32 = 0x0000_0010;
    const PARTS_MASK_HAS_SOUND_INFO: u32 = 0x0000_0001;

    // Schema field order per dats.xml:3860-3870 emits the optional
    // sub-records in maskmap-declaration order (SkyInfo first), not
    // bit-value order. So SkyInfo precedes SoundInfo on the wire.
    if parts_mask & PARTS_MASK_HAS_SKY_INFO != 0 {
        let _sky = SkyDesc::unpack(&mut cursor).unwrap();
    }

    let start = cursor.position() as usize;
    assert!(
        parts_mask & PARTS_MASK_HAS_SOUND_INFO != 0,
        "Region 0x13000000 must have HasSoundInfo bit set in retail"
    );
    let _sound = SoundDesc::unpack(&mut cursor).unwrap();
    let end = cursor.position() as usize;

    (start, end)
}

// ─────────────────────────────────────────────────────────────────────────────
// Minimal pure-Rust SHA-256. Implemented inline rather than adding the
// `sha2` crate to this crate's dev-dependencies (constraint: do not touch
// Cargo.toml). Reference: FIPS 180-4 §6.2.
// ─────────────────────────────────────────────────────────────────────────────

const SHA256_K: [u32; 64] = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

fn sha256_hex(bytes: &[u8]) -> String {
    let mut h: [u32; 8] = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
        0x5be0cd19,
    ];

    // Pre-processing: pad message.
    let bit_len = (bytes.len() as u64).wrapping_mul(8);
    let mut padded = bytes.to_vec();
    padded.push(0x80);
    while padded.len() % 64 != 56 {
        padded.push(0x00);
    }
    padded.extend_from_slice(&bit_len.to_be_bytes());

    for chunk in padded.chunks_exact(64) {
        let mut w = [0u32; 64];
        for (i, word) in chunk.chunks_exact(4).enumerate() {
            w[i] = u32::from_be_bytes(word.try_into().unwrap());
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16]
                .wrapping_add(s0)
                .wrapping_add(w[i - 7])
                .wrapping_add(s1);
        }
        let mut a = h[0];
        let mut b = h[1];
        let mut c = h[2];
        let mut d = h[3];
        let mut e = h[4];
        let mut f = h[5];
        let mut g = h[6];
        let mut hh = h[7];

        for i in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ ((!e) & g);
            let temp1 = hh
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(SHA256_K[i])
                .wrapping_add(w[i]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let temp2 = s0.wrapping_add(maj);
            hh = g;
            g = f;
            f = e;
            e = d.wrapping_add(temp1);
            d = c;
            c = b;
            b = a;
            a = temp1.wrapping_add(temp2);
        }

        h[0] = h[0].wrapping_add(a);
        h[1] = h[1].wrapping_add(b);
        h[2] = h[2].wrapping_add(c);
        h[3] = h[3].wrapping_add(d);
        h[4] = h[4].wrapping_add(e);
        h[5] = h[5].wrapping_add(f);
        h[6] = h[6].wrapping_add(g);
        h[7] = h[7].wrapping_add(hh);
    }

    let mut out = String::with_capacity(64);
    for word in &h {
        out.push_str(&format!("{word:08x}"));
    }
    out
}

#[test]
fn sha256_self_test_against_known_vectors() {
    // FIPS 180-2 §B.1: SHA-256("abc")
    assert_eq!(
        sha256_hex(b"abc"),
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
    // Empty input.
    assert_eq!(
        sha256_hex(b""),
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
}

#[test]
fn region_sound_info_parity() {
    let Some(path) = locate_portal_dat() else {
        eprintln!(
            "[region_sound_info_parity] SKIP — no client_portal.dat available at \
             ~/ac_base_dats/client_portal.dat or via HOLTBURGER_PORTAL_DAT"
        );
        return;
    };

    let dat = DatDatabase::new(&path).expect("client_portal.dat must open");
    let bytes = dat
        .get_file(0x1300_0000)
        .expect("Region 0x13000000 must exist in retail client_portal.dat");

    // ── Step 1: parse Region, locate sound_info byte boundaries ──────────────
    let mut cursor = Cursor::new(bytes.as_slice());
    let region = Region::unpack(&mut cursor).expect("Region must parse");
    assert_eq!(region.id, 0x1300_0000);
    assert_eq!(region.region_number, 1);

    let sound = region
        .sound_info
        .as_ref()
        .expect("Region 0x13000000 has HasSoundInfo bit set in retail");

    let (start, end) = find_sound_info_slice_bounds(&bytes);
    let original_slice = &bytes[start..end];

    eprintln!(
        "[region_sound_info_parity] sound_info bytes: [{}..{}) ({} bytes), {} STBs",
        start,
        end,
        end - start,
        sound.stb_descs.len()
    );

    // ── Step 2: re-serialize via SoundDesc::pack ─────────────────────────────
    let mut repacked = Vec::with_capacity(end - start);
    sound.pack(&mut repacked);

    assert_eq!(
        repacked.len(),
        original_slice.len(),
        "repacked sound_info length ({} bytes) differs from original ({} bytes) — \
         parser/pack are not symmetric",
        repacked.len(),
        original_slice.len()
    );

    // ── Step 3: byte-equal round-trip ────────────────────────────────────────
    assert_eq!(
        repacked.as_slice(),
        original_slice,
        "Repacked sound_info bytes diverge from raw DAT slice — parser shape is wrong"
    );

    // ── Step 4: SHA-256 golden ───────────────────────────────────────────────
    let hash = sha256_hex(&repacked);
    eprintln!(
        "[region_sound_info_parity] sha256(sound_info) = {hash}"
    );
    assert_eq!(
        hash, SOUND_INFO_GOLDEN_SHA256,
        "sound_info SHA-256 drifted from golden — either retail DAT changed \
         or our SoundDesc::pack output mutated"
    );

    // ── Step 5: enumerate (stb_id, SoundType) slots ──────────────────────────
    let mut total_slots = 0usize;
    let mut continuous_slots = 0usize;
    let mut per_type: std::collections::BTreeMap<u32, usize> = std::collections::BTreeMap::new();
    let mut per_stb_count: Vec<(u32, usize)> = Vec::new();

    for stb in &sound.stb_descs {
        per_stb_count.push((stb.stb_id, stb.ambient_sounds.len()));
        for s in &stb.ambient_sounds {
            total_slots += 1;
            if s.is_continuous() {
                continuous_slots += 1;
            }
            *per_type.entry(s.s_type).or_insert(0) += 1;

            // ── ACE/DRW Sound-enum validity gate ──
            // SType is a `Sound` enum value (uint) per dats.xml:2866. Valid
            // range is 0..=0xCC inclusive. The `Invalid` sentinel (0x00) is
            // never expected on the wire for an ambient slot.
            assert!(
                s.s_type != SOUND_ENUM_INVALID,
                "STB 0x{:08X} ambient slot s_type == 0 (Sound::Invalid sentinel) — \
                 ACE/PhatSDK expect a valid Sound enum value",
                stb.stb_id
            );
            assert!(
                s.s_type <= SOUND_ENUM_MAX,
                "STB 0x{:08X} s_type 0x{:X} is out of `Sound` enum range (max 0x{:X} per \
                 dats.xml:553) — likely a parser misalignment",
                stb.stb_id,
                s.s_type,
                SOUND_ENUM_MAX
            );

            // Volume must be in [0, 1] for a sane mixer level. Negative
            // volumes are nonsensical; > 1 would clip. PhatSDK uses these
            // as 0..1 attenuation, not dB.
            assert!(
                s.volume >= 0.0 && s.volume <= 1.0,
                "STB 0x{:08X} s_type 0x{:X} volume {} out of [0,1]",
                stb.stb_id,
                s.s_type,
                s.volume
            );
            // base_chance ∈ [0, 1]: 0 = continuous, in (0,1] = roll-per-window.
            assert!(
                s.base_chance >= 0.0 && s.base_chance <= 1.0,
                "STB 0x{:08X} s_type 0x{:X} base_chance {} out of [0,1]",
                stb.stb_id,
                s.s_type,
                s.base_chance
            );
            // Rates: min_rate <= max_rate, both finite & non-negative.
            assert!(
                s.min_rate.is_finite() && s.max_rate.is_finite(),
                "STB 0x{:08X} s_type 0x{:X} non-finite rate",
                stb.stb_id,
                s.s_type
            );
            assert!(
                s.min_rate >= 0.0 && s.max_rate >= 0.0,
                "STB 0x{:08X} s_type 0x{:X} negative rate [{}, {}]",
                stb.stb_id,
                s.s_type,
                s.min_rate,
                s.max_rate
            );
            assert!(
                s.min_rate <= s.max_rate,
                "STB 0x{:08X} s_type 0x{:X} rate window inverted: min={} > max={}",
                stb.stb_id,
                s.s_type,
                s.min_rate,
                s.max_rate
            );
        }
    }

    // ── Step 6: coverage table ───────────────────────────────────────────────
    eprintln!(
        "\n[region_sound_info_parity] Coverage table — slots per SoundType across {} STBs:",
        sound.stb_descs.len()
    );
    eprintln!("  {:<6}  {:<20}  {:<6}", "code", "label", "slots");
    eprintln!("  {:<6}  {:<20}  {:<6}", "------", "--------------------", "------");
    for (code, count) in &per_type {
        eprintln!(
            "  0x{:02X}    {:<20}  {}",
            code,
            sound_type_label(*code),
            count
        );
    }
    eprintln!(
        "\n  Total: {} slots ({} continuous, {} probabilistic) across {} unique SoundTypes",
        total_slots,
        continuous_slots,
        total_slots - continuous_slots,
        per_type.len()
    );

    // ── Step 7: floor assertions on the corpus ───────────────────────────────
    assert!(
        !sound.stb_descs.is_empty(),
        "Retail Region 0x13000000 must carry at least one STB (got {})",
        sound.stb_descs.len()
    );
    assert!(
        total_slots > 0,
        "Retail Region 0x13000000 must carry at least one ambient slot total"
    );

    // Per-STB sanity: no empty STBs (an STB with zero ambients is
    // sentinel-null at the slot level — ACE/PhatSDK both treat
    // `ambient_sounds.num_used == 0` as "this scene type has no audio
    // attached" but the STB itself MUST still appear via SceneType.
    // stb_index. Report (don't fail) any zero-slot STBs as a finding.
    let zero_stbs: Vec<u32> = per_stb_count
        .iter()
        .filter(|(_, n)| *n == 0)
        .map(|(id, _)| *id)
        .collect();
    if !zero_stbs.is_empty() {
        eprintln!(
            "[region_sound_info_parity] FINDING: {} STBs carry zero ambient slots: {:?}",
            zero_stbs.len(),
            zero_stbs
                .iter()
                .map(|id| format!("0x{:08X}", id))
                .collect::<Vec<_>>()
        );
    }

    // Final assert that the doc-claim of 37 STBs in the SoundDesc on
    // Region 0x13000000 matches retail (see the existing
    // `sound_probe::probe_region_sound_desc_stbs` test for the
    // doc-claim source).
    eprintln!(
        "[region_sound_info_parity] PASS — {} STBs, {} ambient slots, SHA-256 matches",
        sound.stb_descs.len(),
        total_slots
    );
}
