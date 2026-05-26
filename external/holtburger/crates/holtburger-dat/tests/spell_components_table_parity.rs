//! Parse the retail `SpellComponentsTable` (DAT `0x0E00000F`) from
//! `client_portal.dat` and assert ACE's shape invariants:
//!   * Record self-id matches `0x0E00000F`.
//!   * At least 60 components present (retail has 163 per
//!     `SpellComponentsTable.cs:31` and the DRW test fixture).
//!   * Every component has a non-empty Name (StringId obfuscated string).
//!   * The Lead Scarab (component id 1) carries the canonical
//!     fixtures: name="Lead Scarab", type=Scarab(1), icon_did=0x060013E7
//!     (DRW EOR test). **Lead's Gesture is `MotionCommand.Invalid`
//!     (0x80000000)** — this is the load-bearing retail fact behind
//!     `SpellFormula.cs:265 HasWindupGestures => Scarabs.Any(i => i != Lead)`.
//!     The exemption isn't a code special-case; it's directly encoded
//!     in the DAT as an Invalid gesture, which the cast pipeline skips.
//!   * Higher-tier scarabs (Iron=2, Copper=3, ... Mana=193) carry a
//!     `MagicPowerUp0N` gesture (0x1000006F..0x10000078).
//!   * The known talisman set (49..62) carries Type=Talisman(5) and
//!     a Gesture in the `Magic*` cast-motion range
//!     (0x4000002B..0x40000039) or `CastSpell` (0x400000D3).
//!
//! Skipped when `HOLTBURGER_PORTAL_DAT` is unset (mirrors
//! `combat_maneuver_table_parity.rs`).

use binrw::BinRead;
use binrw::io::Cursor;
use holtburger_dat::DatDatabase;
use holtburger_dat::file_type::SpellComponentsTable;

mod common;
use common::get_portal_dat_path;

/// ACE `SpellComponentsTable.cs:10-21` Type enum.
const TYPE_SCARAB: u32 = 1;
const TYPE_TALISMAN: u32 = 5;

/// `MotionCommand.Invalid` — the magic value Lead Scarab carries
/// because Lead spells skip the windup chain.
const MOTION_INVALID: u32 = 0x8000_0000;

/// `MagicPowerUp01..10` — `ACE.Entity/Enum/MotionCommand.cs:118-127`.
const MAGIC_POWERUP_01: u32 = 0x1000_006F;
const MAGIC_POWERUP_10: u32 = 0x1000_0078;
/// `MagicPowerUp01Purple..10Purple` — late-era scarab windups
/// (Platinum/Dark/Mana). 0x1000012B..0x10000134.
const MAGIC_POWERUP_01_PURPLE: u32 = 0x1000_012B;
const MAGIC_POWERUP_10_PURPLE: u32 = 0x1000_0134;

/// Cast-gesture range (`MagicBlast..MagicPray`) +
/// `CastSpell` (0x400000D3). `ACE.Entity/Enum/MotionCommand.cs:50-63 +
/// :118`.
const MAGIC_CAST_FIRST: u32 = 0x4000_002B; // MagicBlast
const MAGIC_CAST_LAST: u32 = 0x4000_0039; // MagicPray
const CAST_SPELL: u32 = 0x4000_00D3;

fn is_cast_gesture(g: u32) -> bool {
    (g >= MAGIC_CAST_FIRST && g <= MAGIC_CAST_LAST) || g == CAST_SPELL
}

fn is_windup_gesture(g: u32) -> bool {
    (g >= MAGIC_POWERUP_01 && g <= MAGIC_POWERUP_10)
        || (g >= MAGIC_POWERUP_01_PURPLE && g <= MAGIC_POWERUP_10_PURPLE)
}

#[test]
fn retail_spell_components_table_parses() {
    let Some(dat_path) = get_portal_dat_path() else {
        println!("Skipping SpellComponentsTable parity: portal.dat not found");
        return;
    };

    let dat = DatDatabase::new(&dat_path).expect("open portal.dat");
    let bytes = dat
        .get_file(SpellComponentsTable::FILE_ID)
        .expect("SpellComponentsTable 0x0E00000F not present in DAT");

    let mut cursor = Cursor::new(&bytes);
    let table = SpellComponentsTable::read_le(&mut cursor).unwrap_or_else(|e| {
        panic!(
            "parse SpellComponentsTable 0x{:08X} ({} bytes): {e}",
            SpellComponentsTable::FILE_ID,
            bytes.len()
        );
    });

    assert_eq!(
        table.id,
        SpellComponentsTable::FILE_ID,
        "SpellComponentsTable self-id mismatch"
    );
    assert!(
        table.components.len() >= 60,
        "expected >= 60 components, got {} (retail has 163)",
        table.components.len()
    );

    // Name must be populated for every entry.
    for (id, comp) in &table.components {
        assert!(
            !comp.name.is_empty(),
            "component {} has empty name",
            id
        );
    }

    // Lead Scarab (id=1) — canonical fixture matching DRW's EOR test
    // (`SpellComponentTableTests.cs:64-66`).
    let lead = table
        .components
        .get(&1)
        .expect("Lead Scarab (id=1) missing from table");
    assert_eq!(
        lead.name, "Lead Scarab",
        "Lead Scarab name mismatch: got {:?}",
        lead.name
    );
    assert_eq!(
        lead.ty, TYPE_SCARAB,
        "Lead Scarab Type expected Scarab(1), got {}",
        lead.ty
    );
    // Lead's gesture is MotionCommand.Invalid — this is the retail
    // implementation of the `HasWindupGestures` Lead exemption.
    assert_eq!(
        lead.gesture, MOTION_INVALID,
        "Lead Scarab Gesture expected MotionCommand.Invalid (0x{:08X}), got 0x{:08X}",
        MOTION_INVALID, lead.gesture
    );
    // DRW test asserts icon 0x060013E7.
    assert_eq!(
        lead.icon_did, 0x0600_13E7,
        "Lead Scarab Icon DID mismatch: expected 0x060013E7, got 0x{:08X}",
        lead.icon_did
    );

    // Every higher-tier scarab (Iron..Pyreal = 2..6, Diamond=110,
    // Platinum=112, Dark=192, Mana=193) must carry a MagicPowerUp
    // gesture (these are the non-Lead scarabs that DO trigger windups).
    let higher_scarabs: &[u32] = &[2, 3, 4, 5, 6, 110, 112, 192, 193];
    let mut higher_scarabs_seen = 0usize;
    for id in higher_scarabs {
        let Some(comp) = table.components.get(id) else {
            // Some Pea/late scarabs may be absent in pre-EOR DATs; skip.
            continue;
        };
        assert_eq!(
            comp.ty, TYPE_SCARAB,
            "scarab id {} expected Type=Scarab(1), got {}",
            id, comp.ty
        );
        assert!(
            is_windup_gesture(comp.gesture),
            "scarab id {} ('{}') Gesture 0x{:08X} not in MagicPowerUp01..10 or Purple variant",
            id, comp.name, comp.gesture
        );
        higher_scarabs_seen += 1;
    }
    assert!(
        higher_scarabs_seen >= 5,
        "expected >= 5 non-Lead scarabs, got {}",
        higher_scarabs_seen
    );

    // Every talisman (id 49..62) must carry a cast-motion gesture.
    let mut talismans_seen = 0usize;
    for id in 49u32..=62 {
        let Some(comp) = table.components.get(&id) else {
            continue;
        };
        assert_eq!(
            comp.ty, TYPE_TALISMAN,
            "talisman id {} ('{}') expected Type=Talisman(5), got {}",
            id, comp.name, comp.ty
        );
        assert!(
            is_cast_gesture(comp.gesture),
            "talisman id {} ('{}') Gesture 0x{:08X} not in MagicBlast..MagicPray or CastSpell",
            id, comp.name, comp.gesture
        );
        talismans_seen += 1;
    }
    assert!(
        talismans_seen >= 10,
        "expected >= 10 talismans (49..62), got {}",
        talismans_seen
    );

    println!(
        "Parsed SpellComponentsTable 0x{:08X}: {} components ({} talismans cross-checked)",
        table.id,
        table.components.len(),
        talismans_seen
    );
}
