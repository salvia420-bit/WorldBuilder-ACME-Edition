//! Spell Components Table — `client_portal.dat` file `0x0E00000F`.
//!
//! This is the per-component metadata table the magic-cast pipeline
//! consumes to look up the windup / cast `MotionCommand` for every
//! scarab + talisman in a spell formula. ACE.Server's
//! `SpellFormula.cs:245-287` proves the algorithm:
//!
//! ```text
//! for each scarab in formula:                            (1+ per spell)
//!     play SpellComponentTable[scarab].Gesture (Magic stance)
//! play SpellComponentTable[talisman].Gesture (Magic stance)
//! ```
//!
//! Edge case: `SpellFlags.FastCast (0x4000)` skips all windups; the
//! ACE handler at `Player_Magic.cs:607-608` bails out before
//! `DoWindupGestures` in that case. `HasWindupGestures` at
//! `SpellFormula.cs:265` also returns false when the formula's only
//! scarab is `Lead` — Lead spells play just the cast gesture.
//!
//! Wire layout (per ACE.DatLoader `SpellComponentsTable.cs:27-35` +
//! DRW `dats.xml:3003-3014 / 4118-4124` + `PackableHashTable.cs`):
//!
//! ```text
//!   u32  id                       (DBObjHeaderFlags.HasId = 0x0E00000F)
//!   u16  num_components            (= 163 / 0xA3 in retail)
//!   u16  bucket_size               (ACE reads this as align-pad; DRW
//!                                   reads as a bucket count — either
//!                                   way it's 2 bytes ignored by us)
//!   [Component; N] entries
//!     u32  key                       (component id 1..198, sparse)
//!     SpellComponentBase value
//! ```
//!
//! `SpellComponentBase` layout — matches `acclient.exe`'s
//! `SpellComponentBase::UnPack` (cross-referenced via
//! `external/chorizite/ACBindings/Generated/Net/Types/SpellComponentBase.cs`
//! and the PhatSDK `SpellComponentTable.h:8-24` mirror):
//!
//! ```text
//!   obfuscated_string  name          (PStringBase, swap-nibble encoded)
//!   pad to 4-byte boundary
//!   u32                category      (SpellComponentCategory enum)
//!   u32                icon_did      (RenderSurface 0x06xxxxxx)
//!   u32                ty            (SpellComponentType: 1=Scarab,
//!                                     2=Herb, 3=Powder, 4=Potion,
//!                                     5=Talisman, 6=Taper)
//!   u32                gesture       (MotionCommand — see below)
//!   f32                time          (gesture duration in seconds)
//!   obfuscated_string  text          (spell-words chant fragment)
//!   pad to 4-byte boundary
//!   f32                cdm           ("Unsure what this is" per ACE)
//! ```
//!
//! DRW dats.xml note: the schema labels `Icon` as
//! `<vector type="QualifiedDataId">`, which would suggest a
//! (namespace, id) pair. **This is a docs bug** — the actual retail
//! bytes are a single `u32`. Confirmed by:
//!   1. `ACE.DatLoader/Entity/SpellComponentBase.cs:9 Icon { get; }` —
//!      typed `uint`, read as `reader.ReadUInt32()` at line 22.
//!   2. `external/chorizite/ACBindings/Generated/Net/Types/SpellComponentBase.cs:28`
//!      `_iconID` typed `IDClass____tagDataID` (= raw DWORD).
//!   3. DRW's own `SpellComponentTableTests.cs:66` asserts
//!      `Components[1].Icon == 0x060013E7u` (single u32 literal).
//!
//! Gesture cross-reference for scarabs / talismans:
//!   * Scarabs (1..6, 110, 112, 192, 193) → one of
//!     `MagicPowerUp01..10` (0x1000006F..0x10000078).
//!   * Talismans (49..62) → one of `MagicBlast/MagicHeal/MagicHarm/
//!     MagicEnchantItem/MagicPortal/MagicPray/MagicSelfHead/
//!     MagicSelfHeart/MagicBonus/MagicClap/MagicThrowMissile/
//!     MagicTransfer/MagicVision` (0x4000002B..0x40000039) or
//!     `CastSpell` (0x400000D3) for generic.
//!   * Non-scarab / non-talisman components also carry a Gesture
//!     field but it's not consumed by the cast-gesture pipeline.

use crate::utils::{align_boundary, read_obfuscated_string};
use crate::{EOR_PORTAL_NAMESPACE, ResourceKey, StaticResourceKey};
use binrw::{BinRead, BinResult};
use std::collections::HashMap;
use std::io::{Read, Seek};

/// One row in a [`SpellComponentsTable`].
#[derive(BinRead, Debug, Clone, serde::Serialize)]
#[br(little)]
pub struct SpellComponent {
    /// Display name (e.g. "Lead Scarab"), obfuscated PStringBase.
    #[br(parse_with = parse_obfuscated)]
    pub name: String,
    #[br(parse_with = parse_align)]
    pub _align1: (),
    /// SpellComponentCategory enum (server uses for spell-words lookup).
    pub category: u32,
    /// RenderSurface DID (`0x06xxxxxx`). Single u32 despite the DRW
    /// dats.xml `QualifiedDataId` label — see module docs.
    pub icon_did: u32,
    /// SpellComponentType (1=Scarab, 2=Herb, 3=Powder, 4=Potion,
    /// 5=Talisman, 6=Taper).
    pub ty: u32,
    /// MotionCommand u32 — `MagicPowerUp0N` for scarabs,
    /// `Magic{Blast,Heal,...}` for talismans.
    pub gesture: u32,
    /// Gesture duration in seconds (mostly 0.0 for non-scarab/talisman).
    pub time: f32,
    /// Spell-words chant fragment, obfuscated PStringBase.
    #[br(parse_with = parse_obfuscated)]
    pub text: String,
    #[br(parse_with = parse_align)]
    pub _align2: (),
    /// "Component Damage Multiplier"? — ACE labels it "Unsure what this
    /// is" (`SpellComponentBase.cs:14`). Kept for round-trip fidelity.
    pub cdm: f32,
}

/// Spell Components Table from `client_portal.dat` (file `0x0E00000F`).
/// Retail has 163 (`0xA3`) entries spanning component IDs 1..198 with
/// gaps for unused slots.
#[derive(BinRead, Debug, Clone, serde::Serialize)]
#[br(little)]
pub struct SpellComponentsTable {
    pub id: u32,
    #[br(parse_with = parse_component_hash_table)]
    pub components: HashMap<u32, SpellComponent>,
}

impl SpellComponentsTable {
    pub const FILE_ID: u32 = 0x0E00000F;

    /// Parse a `SpellComponentsTable` from raw `client_portal.dat`
    /// bytes. Mirrors the `Font::unpack` / `LanguageString::unpack`
    /// pattern so wasm-side callers don't take a direct `binrw`
    /// dependency.
    pub fn unpack(data: &[u8]) -> binrw::BinResult<Self> {
        let mut cursor = binrw::io::Cursor::new(data);
        <Self as binrw::BinRead>::read_options(&mut cursor, binrw::Endian::Little, ())
    }
}

impl StaticResourceKey for SpellComponentsTable {
    const RESOURCE_KEY: ResourceKey<'static> =
        ResourceKey::new(EOR_PORTAL_NAMESPACE, Self::FILE_ID);
}

fn parse_obfuscated<R: Read + Seek>(
    reader: &mut R,
    _endian: binrw::Endian,
    _args: (),
) -> BinResult<String> {
    read_obfuscated_string(reader)
}

fn parse_align<R: Read + Seek>(reader: &mut R, _endian: binrw::Endian, _args: ()) -> BinResult<()> {
    align_boundary(reader, 4)?;
    Ok(())
}

fn parse_component_hash_table<R: Read + Seek>(
    reader: &mut R,
    _endian: binrw::Endian,
    _args: (),
) -> BinResult<HashMap<u32, SpellComponent>> {
    let count = u16::read_le(reader)?;
    let _bucket_size = u16::read_le(reader)?;

    let mut map = HashMap::with_capacity(count as usize);

    for _ in 0..count {
        let key = u32::read_le(reader)?;
        let value = SpellComponent::read(reader)?;
        map.insert(key, value);
    }

    Ok(map)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn test_parse_minimal_table() {
        let mut data = Vec::new();
        // id
        data.extend_from_slice(&SpellComponentsTable::FILE_ID.to_le_bytes());
        // count=0, bucket_size=0
        data.extend_from_slice(&0u16.to_le_bytes());
        data.extend_from_slice(&0u16.to_le_bytes());

        let mut cursor = Cursor::new(data);
        let table = SpellComponentsTable::read(&mut cursor).unwrap();
        assert_eq!(table.id, SpellComponentsTable::FILE_ID);
        assert!(table.components.is_empty());
    }
}
