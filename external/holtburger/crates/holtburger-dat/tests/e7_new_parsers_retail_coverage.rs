//! Real-DAT coverage for the 5 DAT parsers added in E7 that previously
//! had only synthetic-byte tests: `RenderTexture` (0x15), `QualityFilter`
//! (0x0E01xxxx), `TabooTable` (0x0E00001E), `NameFilterTable`
//! (0x0E000020) and `BadData` (0x0E00001A). (`Iteration` / 0xFFFF0001 was
//! already validated against retail bytes elsewhere.)
//!
//! For each type this test enumerates the *real* retail `client_portal.dat`
//! directory, locates the live record(s), parses them via the same
//! `unpack` entry points the `parse_dat_record` example dispatches to, and
//! asserts no parse error plus a few sanity bounds on the decoded fields.
//!
//! Some 0x0E table IDs are client-debug artifacts that may be absent from a
//! given retail DAT. Absence is reported (not failed): only a record that
//! *exists* but fails to parse (or decodes to garbage) is a test failure.
//!
//! SKIPs cleanly if `client_portal.dat` isn't reachable — mirrors the
//! gating used by `texture_format_coverage.rs`.

use holtburger_dat::DatDatabase;
use holtburger_dat::DatError;
use holtburger_dat::file_type::{
    BadData, NameFilterTable, QualityFilter, RenderTexture, TabooTable,
};
use std::path::PathBuf;

fn retail_portal_dat_path() -> Option<PathBuf> {
    if let Some(p) = holtburger_dat::utils::get_portal_dat_path() {
        return Some(p);
    }
    let c = PathBuf::from("/home/wbterminal/ac_base_dats/client_portal.dat");
    c.exists().then_some(c)
}

/// All file IDs in the DAT whose top byte equals `prefix`, sorted ascending.
fn ids_with_prefix(dat: &DatDatabase, prefix: u8) -> Vec<u32> {
    let mut v: Vec<u32> = dat
        .files
        .keys()
        .copied()
        .filter(|id| (id >> 24) as u8 == prefix)
        .collect();
    v.sort_unstable();
    v
}

#[test]
fn e7_new_parsers_against_retail_portal_dat() {
    let Some(dat_path) = retail_portal_dat_path() else {
        eprintln!(
            "SKIP e7_new_parsers_against_retail_portal_dat: \
             client_portal.dat not found"
        );
        return;
    };
    let dat = DatDatabase::new(&dat_path).expect("open retail portal.dat");

    // type -> (present, sample_id, parsed_ok) — printed as a report.
    let mut report: Vec<(&str, bool, Option<u32>, bool)> = Vec::new();

    // ---- RenderTexture (0x15 prefix) ------------------------------------
    {
        let ids = ids_with_prefix(&dat, 0x15);
        if let Some(&id) = ids.first() {
            let bytes = dat.get_file(id).expect("get RenderTexture bytes");
            let rt = RenderTexture::unpack(&bytes)
                .unwrap_or_else(|e| panic!("RenderTexture 0x{id:08X} parse failed: {e:?}"));
            assert_eq!(rt.id, id, "RenderTexture self-id must match file id");
            // Each referenced texture is a 0x06 Surface entry; retail's two
            // console textures each reference exactly one.
            assert!(
                !rt.textures.is_empty() && rt.textures.len() < 1024,
                "RenderTexture 0x{id:08X} texture ref count out of range: {}",
                rt.textures.len()
            );
            for &tex in &rt.textures {
                let tp = (tex >> 24) as u8;
                assert!(
                    tp == 0x06 || tp == 0x07 || tp == 0x05,
                    "RenderTexture 0x{id:08X} references non-texture id 0x{tex:08X}"
                );
            }
            eprintln!(
                "RenderTexture: {} record(s); sample 0x{id:08X} -> {} texture ref(s), \
                 unknown={}, unknown_byte={}",
                ids.len(),
                rt.textures.len(),
                rt.unknown,
                rt.unknown_byte
            );
            report.push(("RenderTexture(0x15)", true, Some(id), true));
        } else {
            eprintln!("RenderTexture: ABSENT from this DAT");
            report.push(("RenderTexture(0x15)", false, None, false));
        }
    }

    // ---- QualityFilter (0x0E01xxxx) -------------------------------------
    {
        let mut ids: Vec<u32> = dat
            .files
            .keys()
            .copied()
            .filter(|id| (id & 0xFFFF_0000) == 0x0E01_0000)
            .collect();
        ids.sort_unstable();
        if let Some(&id) = ids.first() {
            let bytes = dat.get_file(id).expect("get QualityFilter bytes");
            let qf = QualityFilter::unpack(&bytes)
                .unwrap_or_else(|e| panic!("QualityFilter 0x{id:08X} parse failed: {e:?}"));
            assert_eq!(qf.id, id, "QualityFilter self-id must match file id");
            // A non-trivial allow-list: retail's appraisal filters carry
            // dozens of int/float stat enum values.
            let total = qf.int_stat_filter.len()
                + qf.int64_stat_filter.len()
                + qf.bool_stat_filter.len()
                + qf.float_stat_filter.len()
                + qf.did_stat_filter.len()
                + qf.iid_stat_filter.len()
                + qf.string_stat_filter.len()
                + qf.position_stat_filter.len()
                + qf.attribute_stat_filter.len()
                + qf.attribute_2nd_stat_filter.len()
                + qf.skill_stat_filter.len();
            assert!(
                total > 0 && total < 100_000,
                "QualityFilter 0x{id:08X} total filter entries out of range: {total}"
            );
            eprintln!(
                "QualityFilter: {} record(s); sample 0x{id:08X} -> int={}, bool={}, \
                 float={}, did={}, total={}",
                ids.len(),
                qf.int_stat_filter.len(),
                qf.bool_stat_filter.len(),
                qf.float_stat_filter.len(),
                qf.did_stat_filter.len(),
                total
            );
            report.push(("QualityFilter(0x0E01xxxx)", true, Some(id), true));
        } else {
            eprintln!("QualityFilter: ABSENT from this DAT");
            report.push(("QualityFilter(0x0E01xxxx)", false, None, false));
        }
    }

    // ---- TabooTable (0x0E00001E) ----------------------------------------
    {
        const ID: u32 = 0x0E00_001E;
        match dat.get_file(ID) {
            Ok(bytes) => {
                let tt = TabooTable::unpack(&bytes)
                    .unwrap_or_else(|e| panic!("TabooTable 0x{ID:08X} parse failed: {e:?}"));
                assert_eq!(tt.id, ID, "TabooTable self-id must match file id");
                assert!(
                    !tt.entries.is_empty(),
                    "TabooTable 0x{ID:08X} has no entries"
                );
                // Every entry should carry at least one banned pattern, and
                // the patterns should be non-empty lower-case globs.
                let sample = tt
                    .entries
                    .values()
                    .find(|e| !e.banned_patterns.is_empty())
                    .expect("TabooTable has at least one entry with patterns");
                assert!(
                    sample.banned_patterns.iter().all(|p| !p.is_empty()),
                    "TabooTable 0x{ID:08X} contains an empty banned pattern"
                );
                eprintln!(
                    "TabooTable: present; 0x{ID:08X} -> {} entries, sample first pattern = {:?}",
                    tt.entries.len(),
                    sample.banned_patterns.first()
                );
                report.push(("TabooTable(0x0E00001E)", true, Some(ID), true));
            }
            Err(DatError::NotFound(_)) => {
                eprintln!("TabooTable: ABSENT (0x{ID:08X} not in DAT)");
                report.push(("TabooTable(0x0E00001E)", false, None, false));
            }
            Err(e) => panic!("TabooTable 0x{ID:08X} read error (not absence): {e:?}"),
        }
    }

    // ---- NameFilterTable (0x0E000020) -----------------------------------
    //
    // Ground-truth note: ACE.DatLoader/Entity/NameFilterLanguageData.cs reads
    // the per-language record as
    //     MaximumSameCharactersInARow (u32)
    //     MaximumVowelsInARow         (u32)
    //     FirstNCharactersMustHaveAVowel (u32)
    //     VowelContainingSubstringLength (u32)
    //     ExtraAllowedCharacters      (ReadUnicodeString, variable length)
    //     numLetterGroup              (u32)
    //     CompoundLetterGroups[numLetterGroup] (each ReadUnicodeString)
    // The holtburger parser now matches the authoritative ACE/acclient layout
    // (acclient.h:48091-48096; ace-server NameFilterLanguageData.cs::Unpack):
    // a LEADING MaximumSameCharactersInARow u32 and ExtraAllowedCharacters as a
    // ReadUnicodeString. (Fixed in this change; the prior melt-derived parser
    // dropped the leading field, mis-typed ExtraAllowedCharacters as a u32, and
    // had a spurious `unknown` u8 — which only "passed" because this record's
    // ExtraAllowedCharacters is empty, so the stray byte coincidentally aligned
    // while every field name was silently shifted by one.)
    //
    // The decoded retail bytes for 0x0E000020: id=0x0E000020, total_objects=1,
    //   table_size=1, key(lang)=1, MaximumSameCharactersInARow=2,
    //   MaximumVowelsInARow=3, FirstNCharactersMustHaveAVowel=4,
    //   VowelContainingSubstringLength=5, ExtraAllowedCharacters="" (empty),
    //   numLetterGroup=3, CompoundLetterGroups=["th","ch","ph"].
    // (Confirmed against the live record with the fixed parser.)
    //
    // We assert those concrete known retail values (not a loose bound) so a
    // layout regression is detected rather than silently passing.
    {
        const ID: u32 = 0x0E00_0020;
        match dat.get_file(ID) {
            Ok(bytes) => {
                let nft = NameFilterTable::unpack(&bytes)
                    .unwrap_or_else(|e| panic!("NameFilterTable 0x{ID:08X} parse failed: {e:?}"));
                assert_eq!(nft.id, ID, "NameFilterTable self-id must match file id");
                // Retail has exactly one language (english, key == 1).
                assert_eq!(
                    nft.language_data.len(),
                    1,
                    "NameFilterTable 0x{ID:08X} expected exactly 1 language, got {}",
                    nft.language_data.len()
                );
                let ld = nft
                    .language_data
                    .get(&1)
                    .expect("NameFilterTable: english language key (1) must be present");
                // Pin the decoded record to its known retail byte layout so a
                // misaligned parse (the failure mode E7 must catch) is
                // detected rather than silently passing on a value that
                // happens to land inside a loose sanity window. These four
                // u32s are the four consecutive small ints in the record; the
                // holtburger field names are shifted by one vs ACE (see note).
                assert_eq!(
                    ld.maximum_same_characters_in_a_row, 2,
                    "NameFilterTable 0x{ID:08X}: MaximumSameCharactersInARow = {}, expected 2",
                    ld.maximum_same_characters_in_a_row
                );
                assert_eq!(
                    ld.maximum_vowels_in_a_row, 3,
                    "NameFilterTable 0x{ID:08X}: MaximumVowelsInARow = {}, expected 3",
                    ld.maximum_vowels_in_a_row
                );
                assert_eq!(
                    ld.first_n_characters_must_have_a_vowel, 4,
                    "NameFilterTable 0x{ID:08X}: FirstNCharactersMustHaveAVowel = {}, expected 4",
                    ld.first_n_characters_must_have_a_vowel
                );
                assert_eq!(
                    ld.vowel_containing_substring_length, 5,
                    "NameFilterTable 0x{ID:08X}: VowelContainingSubstringLength = {}, expected 5",
                    ld.vowel_containing_substring_length
                );
                assert_eq!(
                    ld.extra_allowed_characters, "",
                    "NameFilterTable 0x{ID:08X}: ExtraAllowedCharacters = {:?}, expected empty",
                    ld.extra_allowed_characters
                );
                // The compound-letter groups are the real payload and the most
                // robust layout check: a misaligned parse would not recover
                // these exact strings.
                assert_eq!(
                    ld.compound_letter_groups,
                    vec!["th".to_string(), "ch".to_string(), "ph".to_string()],
                    "NameFilterTable 0x{ID:08X}: compound_letter_groups diverge from known retail",
                );
                eprintln!(
                    "NameFilterTable: present; 0x{ID:08X} -> {} language(s) (english key=1), \
                     compound_groups={:?}",
                    nft.language_data.len(),
                    ld.compound_letter_groups,
                );
                report.push(("NameFilterTable(0x0E000020)", true, Some(ID), true));
            }
            Err(DatError::NotFound(_)) => {
                eprintln!("NameFilterTable: ABSENT (0x{ID:08X} not in DAT)");
                report.push(("NameFilterTable(0x0E000020)", false, None, false));
            }
            Err(e) => panic!("NameFilterTable 0x{ID:08X} read error (not absence): {e:?}"),
        }
    }

    // ---- BadData (0x0E00001A) -------------------------------------------
    {
        const ID: u32 = 0x0E00_001A;
        match dat.get_file(ID) {
            Ok(bytes) => {
                let bd = BadData::unpack(&bytes)
                    .unwrap_or_else(|e| panic!("BadData 0x{ID:08X} parse failed: {e:?}"));
                assert_eq!(bd.id, ID, "BadData self-id must match file id");
                assert!(!bd.bad.is_empty(), "BadData 0x{ID:08X} has no entries");
                // Per ACE.DatLoader the value column is always 1 (a "bad"
                // flag). A divergence here means the packed-hash-table walk
                // mis-paired keys/values.
                assert!(
                    bd.bad.values().all(|&v| v == 1),
                    "BadData 0x{ID:08X} has a value != 1 (expected bool flag)"
                );
                eprintln!(
                    "BadData: present; 0x{ID:08X} -> {} bad-WCID entries (all value=1)",
                    bd.bad.len()
                );
                report.push(("BadData(0x0E00001A)", true, Some(ID), true));
            }
            Err(DatError::NotFound(_)) => {
                eprintln!("BadData: ABSENT (0x{ID:08X} not in DAT)");
                report.push(("BadData(0x0E00001A)", false, None, false));
            }
            Err(e) => panic!("BadData 0x{ID:08X} read error (not absence): {e:?}"),
        }
    }

    // ---- summary table --------------------------------------------------
    eprintln!("\n=== E7 new-parser retail coverage (client_portal.dat) ===");
    eprintln!("  {:<28} {:<8} {:<12} {}", "type", "present", "sample_id", "parsed_ok");
    for (name, present, sample, ok) in &report {
        let sid = sample.map(|s| format!("0x{s:08X}")).unwrap_or_else(|| "-".into());
        eprintln!("  {name:<28} {present:<8} {sid:<12} {ok}");
    }

    // Every one of these five types is present in a non-truncated retail
    // client_portal.dat (verified live), so on a healthy DAT all five must
    // have been seen *and* parsed. Requiring each by name — rather than the
    // old weak `parsed >= 1` floor that any single table satisfied — means a
    // silent regression that drops one table to ABSENT (a wrong well-known
    // ID, an enumeration change, or a missed prefix) now fails the test.
    const REQUIRED: [&str; 5] = [
        "RenderTexture(0x15)",
        "QualityFilter(0x0E01xxxx)",
        "TabooTable(0x0E00001E)",
        "NameFilterTable(0x0E000020)",
        "BadData(0x0E00001A)",
    ];
    for name in REQUIRED {
        let entry = report
            .iter()
            .find(|(n, _, _, _)| *n == name)
            .unwrap_or_else(|| panic!("internal: report missing entry for {name}"));
        let (_, present, _, ok) = entry;
        assert!(
            *present && *ok,
            "{name} expected present+parsed in retail client_portal.dat \
             (present={present}, parsed_ok={ok}) — DAT may be truncated or the \
             well-known ID/enumeration regressed"
        );
    }
}
