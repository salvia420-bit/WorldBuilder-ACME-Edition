//! maps-chargen-barber-3 (2026-10-13) — the colour rows of the chargen
//! Appearance page (retail gmCGAppearancePage).
//!
//! Retail's page has nine parts: hair, eyes, nose, mouth, skin, headgear,
//! shirt, trousers and footwear. Each has a colour wheel of spots, and
//! every part but the eyes has a shade scroll.
//! `gmCGAppearancePage::SetSelection` (acclient.c:186939) fills the spots;
//! `SetColor` (:186680) and `SetShade` (:185502) store the pick in
//! `CharGenState`.
//!
//! Clothing colours are per gear. `CharGenState::Set*Style`
//! (:496750-496960) runs `StoreColorInformation` (:495905) on the chosen
//! gear's ClothingTable. That keeps the CloPaletteTemplates that have
//! sub-palettes and whose key is in the Sex_CG ClothingColorsList, in
//! PackableHashTable walk order. The colour index indexes that list, and
//! `GetCharGenResult` (:495612) sends `list[index]` (0 when out of range)
//! as the wire's *Color field. ACE stores the key as the item's
//! PaletteTemplate (PlayerFactory `GetClothingObject`).
//!
//! This module is that logic, pure. The wasm crate feeds it ClothingTables
//! and PalSet / Palette records (apps/holtburger-web/src/chargen_colors.rs),
//! and plugins/character-creation.js draws the rows.

use crate::barber::{BarberDat, EYE_SPOT_SAMPLE, HAIR_SPOT_SAMPLE, SKIN_SPOT_SAMPLE};
use holtburger_content::character_gen::{
    CharacterGenAppearanceOptions, CharacterGenGear, CharacterGenGenderDefinition,
};
use holtburger_dat::file_type::ClothingTable;
use std::collections::HashMap;

/// `SetSelection`'s `iSampleColor` for the four clothing parts (0x520).
pub const CLOTHING_SPOT_SAMPLE: usize = 1312;

/// `gmCGAppearancePage::EParts`, numbered as the decomp's switches.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChargenPart {
    Hair = 1,
    Eyes = 2,
    Nose = 3,
    Mouth = 4,
    Skin = 5,
    Headgear = 6,
    Shirt = 7,
    Trousers = 8,
    Footwear = 9,
}

impl ChargenPart {
    pub const ALL: [Self; 9] = [
        Self::Hair,
        Self::Eyes,
        Self::Nose,
        Self::Mouth,
        Self::Skin,
        Self::Headgear,
        Self::Shirt,
        Self::Trousers,
        Self::Footwear,
    ];

    /// The part for its JS name (`"pants"` is accepted for the trousers).
    pub fn from_name(name: &str) -> Option<Self> {
        Some(match name {
            "hair" => Self::Hair,
            "eyes" => Self::Eyes,
            "nose" => Self::Nose,
            "mouth" => Self::Mouth,
            "skin" => Self::Skin,
            "headgear" => Self::Headgear,
            "shirt" => Self::Shirt,
            "trousers" | "pants" => Self::Trousers,
            "footwear" => Self::Footwear,
            _ => return None,
        })
    }

    pub fn name(self) -> &'static str {
        match self {
            Self::Hair => "hair",
            Self::Eyes => "eyes",
            Self::Nose => "nose",
            Self::Mouth => "mouth",
            Self::Skin => "skin",
            Self::Headgear => "headgear",
            Self::Shirt => "shirt",
            Self::Trousers => "trousers",
            Self::Footwear => "footwear",
        }
    }

    /// Every part but the eyes has the shade scroll (`SetSelection` shows
    /// the gradient plug and hides the scroll for part 2).
    pub fn has_shade(self) -> bool {
        self != Self::Eyes
    }

    pub fn gear_slot(self) -> Option<ChargenGearSlot> {
        match self {
            Self::Headgear => Some(ChargenGearSlot::Headgear),
            Self::Shirt => Some(ChargenGearSlot::Shirt),
            Self::Trousers => Some(ChargenGearSlot::Trousers),
            Self::Footwear => Some(ChargenGearSlot::Footwear),
            _ => None,
        }
    }
}

/// The four clothing slots, each with its own per-gear colour list.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChargenGearSlot {
    Headgear,
    Shirt,
    Trousers,
    Footwear,
}

impl ChargenGearSlot {
    pub const ALL: [Self; 4] = [Self::Headgear, Self::Shirt, Self::Trousers, Self::Footwear];

    pub fn name(self) -> &'static str {
        match self {
            Self::Headgear => "headgear",
            Self::Shirt => "shirt",
            Self::Trousers => "trousers",
            Self::Footwear => "footwear",
        }
    }

    /// The Sex_CG gear list of the slot (`mHeadgearList`, `mShirtList`,
    /// `mPantsList`, `mFootwearList`).
    pub fn gear_list(self, appearance: &CharacterGenAppearanceOptions) -> &[CharacterGenGear] {
        match self {
            Self::Headgear => &appearance.headgear,
            Self::Shirt => &appearance.shirts,
            Self::Trousers => &appearance.pants,
            Self::Footwear => &appearance.footwear,
        }
    }
}

/// One CloPaletteTemplate as `StoreColorInformation` reads it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CloPaletteTemplateRef {
    /// The template key — what the wire's colour field carries.
    pub key: u32,
    /// `CloPaletteTemplate::numSubpalEffects`.
    pub num_sub_palettes: usize,
    /// `cpt.subpalEffects->palSet`, the first sub-palette's PalSet (0 when
    /// there is none).
    pub first_pal_set: u32,
}

/// A ClothingTable's CloPaletteTemplates in the order retail walks them.
pub fn clothing_palette_templates(table: &ClothingTable) -> Vec<CloPaletteTemplateRef> {
    table
        .sub_pal_effect_keys_in_retail_order()
        .into_iter()
        .filter_map(|key| {
            let effect = table.clothing_sub_pal_effects.get(&key)?;
            Some(CloPaletteTemplateRef {
                key,
                num_sub_palettes: effect.clo_sub_palettes.len(),
                first_pal_set: effect
                    .clo_sub_palettes
                    .first()
                    .map_or(0, |sub| sub.palette_set),
            })
        })
        .collect()
}

/// `StoreColorInformation`'s output for one gear: `xPaletteTemplateIDs`
/// and `xPalSetIDs`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct GearColorChoices {
    pub template_ids: Vec<u32>,
    pub pal_set_ids: Vec<u32>,
}

impl GearColorChoices {
    /// `numXColors`.
    pub fn len(&self) -> usize {
        self.template_ids.len()
    }

    pub fn is_empty(&self) -> bool {
        self.template_ids.is_empty()
    }

    /// `GetCharGenResult`'s key for colour index `color`:
    /// `0 <= color < num ? ids[color] : 0`.
    pub fn template_for(&self, color: u32) -> u32 {
        self.template_ids
            .get(color as usize)
            .copied()
            .unwrap_or(0)
    }
}

/// `CharGenState::StoreColorInformation` (acclient.c:495905): walk the
/// gear's templates and keep each one with `numSubpalEffects > 0` whose key
/// is in the Sex_CG `mClothingColorsList`, with its first PalSet.
pub fn store_color_information(
    templates: &[CloPaletteTemplateRef],
    clothing_colors: &[u32],
) -> GearColorChoices {
    let mut out = GearColorChoices::default();
    for template in templates {
        if template.num_sub_palettes > 0 && clothing_colors.contains(&template.key) {
            out.template_ids.push(template.key);
            out.pal_set_ids.push(template.first_pal_set);
        }
    }
    out
}

/// The ClothingTables the colour rows have read, keyed by DataID and kept
/// as their templates in walk order. The caller fills it; a table that is
/// not here is "not loaded" (callers fall back as they choose).
#[derive(Debug, Clone, Default)]
pub struct ChargenClothingTables {
    tables: HashMap<u32, Vec<CloPaletteTemplateRef>>,
}

impl ChargenClothingTables {
    /// Add ClothingTable `id`.
    pub fn insert(&mut self, id: u32, table: &ClothingTable) {
        self.tables.insert(id, clothing_palette_templates(table));
    }

    /// Add ClothingTable `id` as its templates (walk order).
    pub fn insert_templates(&mut self, id: u32, templates: Vec<CloPaletteTemplateRef>) {
        self.tables.insert(id, templates);
    }

    pub fn contains(&self, id: u32) -> bool {
        self.tables.contains_key(&id)
    }

    pub fn len(&self) -> usize {
        self.tables.len()
    }

    pub fn is_empty(&self) -> bool {
        self.tables.is_empty()
    }

    pub fn templates(&self, id: u32) -> Option<&[CloPaletteTemplateRef]> {
        self.tables.get(&id).map(Vec::as_slice)
    }

    /// `StoreColorInformation` for style `style` of `slot`. `None` when the
    /// style is out of range (or "none", `u32::MAX`) or its ClothingTable
    /// is not loaded.
    pub fn gear_choices(
        &self,
        appearance: &CharacterGenAppearanceOptions,
        slot: ChargenGearSlot,
        style: u32,
    ) -> Option<GearColorChoices> {
        let gear = slot.gear_list(appearance).get(style as usize)?;
        let templates = self.templates(gear.clothing_table)?;
        Some(store_color_information(
            templates,
            &appearance.clothing_color_ids,
        ))
    }
}

fn push_unique(out: &mut Vec<u32>, id: u32) {
    if id != 0 && !out.contains(&id) {
        out.push(id);
    }
}

/// Every ClothingTable the Sex_CG's gear lists name (non-zero,
/// deduplicated, in list order).
pub fn chargen_clothing_table_ids(appearance: &CharacterGenAppearanceOptions) -> Vec<u32> {
    let mut out = Vec::new();
    for slot in ChargenGearSlot::ALL {
        for gear in slot.gear_list(appearance) {
            push_unique(&mut out, gear.clothing_table);
        }
    }
    out
}

// ── The colour wheel ────────────────────────────────────────────────────────

/// `Palette::get_color32` (acclient.c:365029) on a palette as
/// `Palette::InitLoad` (:365035) leaves it at run time: a 256-entry
/// palette is widened to 2048 entries (each repeated 8×), so entry `index`
/// is raw entry `index >> 3`. 0 past the end.
pub fn palette_color32(colors: &[u32], index: usize) -> u32 {
    let i = if colors.len() == 256 { index >> 3 } else { index };
    colors.get(i).copied().unwrap_or(0)
}

/// `ClientCharGenState::GetColorFromPal` (acclient.c:400963): 0 when the
/// palette does not load.
pub fn color_from_pal(palette: u32, sample: usize, dat: &impl BarberDat) -> u32 {
    dat.palette_colors(palette)
        .map_or(0, |colors| palette_color32(colors, sample))
}

fn rgb(c: u32) -> [u8; 3] {
    [(c >> 16) as u8, (c >> 8) as u8, c as u8]
}

/// One PalSet spot of `SetSelection`: the per-channel integer mean of
/// `GetColorFromPal(PalSet::GetPaletteID_Integral(i), sample)` over the
/// set's palettes. A palette that does not load counts as 0, as in retail.
/// `None` when the PalSet is not loaded or empty, or none of its palettes
/// is (retail then leaves the spot as it was).
pub fn pal_set_spot_color(set: u32, sample: usize, dat: &impl BarberDat) -> Option<[u8; 3]> {
    let pals = dat.palette_set(set)?;
    if pals.is_empty() || !pals.iter().any(|p| dat.palette_colors(*p).is_some()) {
        return None;
    }
    let mut sum = [0u32; 3];
    for p in pals {
        let c = rgb(color_from_pal(*p, sample, dat));
        for (s, v) in sum.iter_mut().zip(c) {
            *s += u32::from(v);
        }
    }
    let n = pals.len() as u32;
    Some([(sum[0] / n) as u8, (sum[1] / n) as u8, (sum[2] / n) as u8])
}

/// The colour wheel's spots for `part` (`SetSelection`,
/// acclient.c:186939):
/// - hair: one per hair-colour PalSet, sampled at entry 208;
/// - eyes: one per eye palette, `GetColorFromPal(palette, 259)`;
/// - nose / mouth / skin: the skin PalSet's single spot, at 176;
/// - headgear / shirt / trousers / footwear: one per PalSet of the gear's
///   `StoreColorInformation` list, at 1312 (none without `gear`).
///
/// `None` marks a spot whose records are not loaded.
pub fn chargen_spot_colors(
    gender: &CharacterGenGenderDefinition,
    part: ChargenPart,
    gear: Option<&GearColorChoices>,
    dat: &impl BarberDat,
) -> Vec<Option<[u8; 3]>> {
    match part {
        ChargenPart::Hair => gender
            .appearance
            .hair_color_ids
            .iter()
            .map(|set| pal_set_spot_color(*set, HAIR_SPOT_SAMPLE, dat))
            .collect(),
        ChargenPart::Eyes => gender
            .appearance
            .eye_color_ids
            .iter()
            .map(|p| {
                dat.palette_colors(*p)
                    .map(|colors| rgb(palette_color32(colors, EYE_SPOT_SAMPLE)))
            })
            .collect(),
        ChargenPart::Nose | ChargenPart::Mouth | ChargenPart::Skin => vec![pal_set_spot_color(
            gender.skin_palette_set,
            SKIN_SPOT_SAMPLE,
            dat,
        )],
        ChargenPart::Headgear
        | ChargenPart::Shirt
        | ChargenPart::Trousers
        | ChargenPart::Footwear => gear
            .map(|g| {
                g.pal_set_ids
                    .iter()
                    .map(|set| pal_set_spot_color(*set, CLOTHING_SPOT_SAMPLE, dat))
                    .collect()
            })
            .unwrap_or_default(),
    }
}

/// The PalSets [`chargen_spot_colors`] reads for `part` (non-zero,
/// deduplicated).
pub fn chargen_part_palette_set_ids(
    gender: &CharacterGenGenderDefinition,
    part: ChargenPart,
    gear: Option<&GearColorChoices>,
) -> Vec<u32> {
    let mut out = Vec::new();
    match part {
        ChargenPart::Hair => {
            for set in &gender.appearance.hair_color_ids {
                push_unique(&mut out, *set);
            }
        }
        ChargenPart::Eyes => {}
        ChargenPart::Nose | ChargenPart::Mouth | ChargenPart::Skin => {
            push_unique(&mut out, gender.skin_palette_set);
        }
        ChargenPart::Headgear
        | ChargenPart::Shirt
        | ChargenPart::Trousers
        | ChargenPart::Footwear => {
            for set in gear.map(|g| g.pal_set_ids.as_slice()).unwrap_or_default() {
                push_unique(&mut out, *set);
            }
        }
    }
    out
}

/// The Palettes [`chargen_spot_colors`] reads for `part`: every palette of
/// its loaded PalSets, or the eye palettes for the eyes.
pub fn chargen_part_palette_ids(
    gender: &CharacterGenGenderDefinition,
    part: ChargenPart,
    gear: Option<&GearColorChoices>,
    dat: &impl BarberDat,
) -> Vec<u32> {
    let mut out = Vec::new();
    if part == ChargenPart::Eyes {
        for p in &gender.appearance.eye_color_ids {
            push_unique(&mut out, *p);
        }
        return out;
    }
    for set in chargen_part_palette_set_ids(gender, part, gear) {
        if let Some(pals) = dat.palette_set(set) {
            for p in pals {
                push_unique(&mut out, *p);
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::barber::BarberDatCache;
    use crate::character_gen::{CharacterGenBuild, CharacterGenBuilder};
    use holtburger_content::CharacterGenCatalog;
    use holtburger_content::character_gen::CharacterGenHeritageGroup;
    use holtburger_protocol::messages::CharacterCreateAppearanceData;
    use std::collections::BTreeMap;
    use std::sync::Arc;

    fn template(key: u32, num_sub_palettes: usize, first_pal_set: u32) -> CloPaletteTemplateRef {
        CloPaletteTemplateRef {
            key,
            num_sub_palettes,
            first_pal_set,
        }
    }

    fn gear(clothing_table: u32) -> CharacterGenGear {
        CharacterGenGear {
            name: format!("Gear {clothing_table:08X}"),
            clothing_table,
            weenie_default: 1,
        }
    }

    fn appearance() -> CharacterGenAppearanceOptions {
        CharacterGenAppearanceOptions {
            hair_color_ids: vec![0x0F00_0201, 0x0F00_0202],
            hair_styles: vec![],
            eye_color_ids: vec![0x0400_0301, 0x0400_0302],
            eye_strips: vec![],
            nose_strips: vec![],
            mouth_strips: vec![],
            headgear: vec![gear(0x1000_0010)],
            shirts: vec![gear(0x1000_0001), gear(0x1000_0002)],
            pants: vec![gear(0x1000_0003)],
            footwear: vec![gear(0x1000_0001)],
            // The gender list holds every key the gears may offer.
            clothing_color_ids: vec![9, 6, 4, 1, 12],
        }
    }

    fn gender_def() -> CharacterGenGenderDefinition {
        CharacterGenGenderDefinition {
            gender_id: 1,
            name: "Male".to_string(),
            scale: 100,
            setup_id: 0,
            sound_table: 0,
            icon_image: 0,
            base_palette: 0,
            skin_palette_set: 0x0F00_0100,
            physics_table: 0,
            motion_table: 0,
            combat_table: 0,
            appearance: appearance(),
        }
    }

    /// Shirt 0 / footwear: table 0x10000001 walks 4, 7, 9, 1 (7 is not in
    /// the gender list, 1 has no sub-palettes). Shirt 1: 0x10000002 walks
    /// 12, 6. Trousers: 0x10000003 is not loaded.
    fn tables() -> ChargenClothingTables {
        let mut t = ChargenClothingTables::default();
        t.insert_templates(
            0x1000_0001,
            vec![
                template(4, 1, 0x0F00_0004),
                template(7, 2, 0x0F00_0007),
                template(9, 3, 0x0F00_0009),
                template(1, 0, 0),
            ],
        );
        t.insert_templates(
            0x1000_0002,
            vec![template(12, 1, 0x0F00_000C), template(6, 1, 0x0F00_0006)],
        );
        t.insert_templates(0x1000_0010, vec![template(9, 1, 0x0F00_0019)]);
        t
    }

    #[test]
    fn store_color_information_keeps_listed_templates_with_sub_palettes_in_walk_order() {
        let t = tables();
        let choices = store_color_information(t.templates(0x1000_0001).unwrap(), &[9, 6, 4, 1]);
        assert_eq!(choices.template_ids, vec![4, 9]);
        assert_eq!(choices.pal_set_ids, vec![0x0F00_0004, 0x0F00_0009]);
        assert_eq!(choices.template_for(0), 4);
        assert_eq!(choices.template_for(1), 9);
        assert_eq!(choices.template_for(2), 0, "out of range → 0");
        assert_eq!(choices.template_for(u32::MAX), 0);
        assert!(store_color_information(&[], &[9]).is_empty());
    }

    #[test]
    fn gear_choices_follow_the_chosen_style() {
        let t = tables();
        let a = appearance();
        let shirt0 = t.gear_choices(&a, ChargenGearSlot::Shirt, 0).unwrap();
        assert_eq!(shirt0.template_ids, vec![4, 9]);
        let shirt1 = t.gear_choices(&a, ChargenGearSlot::Shirt, 1).unwrap();
        assert_eq!(shirt1.template_ids, vec![12, 6]);
        assert!(t.gear_choices(&a, ChargenGearSlot::Shirt, 2).is_none(), "no such style");
        assert!(
            t.gear_choices(&a, ChargenGearSlot::Trousers, 0).is_none(),
            "table not loaded"
        );
        assert!(t.gear_choices(&a, ChargenGearSlot::Headgear, u32::MAX).is_none());
        assert_eq!(
            chargen_clothing_table_ids(&a),
            vec![0x1000_0010, 0x1000_0001, 0x1000_0002, 0x1000_0003]
        );
    }

    #[test]
    fn palette_color32_widens_a_256_entry_palette() {
        let small: Vec<u32> = (0..256).collect();
        assert_eq!(palette_color32(&small, 1312), 164);
        assert_eq!(palette_color32(&small, 7), 0);
        assert_eq!(palette_color32(&small, 2047), 255);
        let full: Vec<u32> = (0..2048).collect();
        assert_eq!(palette_color32(&full, 1312), 1312);
        assert_eq!(palette_color32(&full, 4096), 0, "past the end → 0");
        assert_eq!(palette_color32(&[], 0), 0);
    }

    fn dat() -> BarberDatCache {
        let mut dat = BarberDatCache::default();
        let solid = |argb: u32| vec![argb; 2048];
        dat.palette_sets.insert(0x0F00_0100, vec![0x0400_0101, 0x0400_0102]);
        dat.palettes.insert(0x0400_0101, solid(0xFF10_2030));
        dat.palettes.insert(0x0400_0102, solid(0xFF30_4051));
        // Hair set 0x0F000201: one palette loaded, one missing (counts 0).
        dat.palette_sets.insert(0x0F00_0201, vec![0x0400_0201, 0x0400_0299]);
        dat.palettes.insert(0x0400_0201, solid(0xFF64_C8FF));
        // Eye palette 0x04000301 is a 256-entry palette: 259 → raw 32.
        let mut eye = vec![0xFF00_0000; 256];
        eye[32] = 0xFF0A_0B0C;
        dat.palettes.insert(0x0400_0301, eye);
        // Shirt 0 PalSets.
        dat.palette_sets.insert(0x0F00_0004, vec![0x0400_0401]);
        dat.palettes.insert(0x0400_0401, solid(0xFF01_0203));
        dat.palette_sets.insert(0x0F00_0009, vec![0x0400_0901]);
        dat
    }

    #[test]
    fn spot_colors_follow_set_selection() {
        let g = gender_def();
        let d = dat();
        // Skin (and nose / mouth): mean of the two skin palettes at 176.
        let skin = chargen_spot_colors(&g, ChargenPart::Skin, None, &d);
        assert_eq!(skin, vec![Some([0x20, 0x30, 0x40])]);
        assert_eq!(chargen_spot_colors(&g, ChargenPart::Nose, None, &d), skin);
        assert_eq!(chargen_spot_colors(&g, ChargenPart::Mouth, None, &d), skin);
        // Hair: the missing palette counts 0; the second set is not loaded.
        let hair = chargen_spot_colors(&g, ChargenPart::Hair, None, &d);
        assert_eq!(hair, vec![Some([0x32, 0x64, 0x7F]), None]);
        // Eyes: one palette each, entry 259 of the widened palette.
        let eyes = chargen_spot_colors(&g, ChargenPart::Eyes, None, &d);
        assert_eq!(eyes, vec![Some([0x0A, 0x0B, 0x0C]), None]);
        // Shirt 0: its StoreColorInformation PalSets; 0x0F000009's only
        // palette is missing, so that spot is unknown.
        let shirt0 = tables().gear_choices(&g.appearance, ChargenGearSlot::Shirt, 0);
        let shirt = chargen_spot_colors(&g, ChargenPart::Shirt, shirt0.as_ref(), &d);
        assert_eq!(shirt, vec![Some([0x01, 0x02, 0x03]), None]);
        assert!(chargen_spot_colors(&g, ChargenPart::Trousers, None, &d).is_empty());

        assert_eq!(
            chargen_part_palette_set_ids(&g, ChargenPart::Shirt, shirt0.as_ref()),
            vec![0x0F00_0004, 0x0F00_0009]
        );
        assert_eq!(
            chargen_part_palette_ids(&g, ChargenPart::Shirt, shirt0.as_ref(), &d),
            vec![0x0400_0401, 0x0400_0901]
        );
        assert_eq!(
            chargen_part_palette_ids(&g, ChargenPart::Eyes, None, &d),
            vec![0x0400_0301, 0x0400_0302]
        );
        assert!(chargen_part_palette_set_ids(&g, ChargenPart::Eyes, None).is_empty());
    }

    #[test]
    fn part_names_round_trip() {
        for part in ChargenPart::ALL {
            assert_eq!(ChargenPart::from_name(part.name()), Some(part));
        }
        assert_eq!(ChargenPart::from_name("pants"), Some(ChargenPart::Trousers));
        assert_eq!(ChargenPart::from_name("cape"), None);
        assert!(!ChargenPart::Eyes.has_shade());
        assert!(ChargenPart::Skin.has_shade());
        assert_eq!(ChargenPart::Shirt.gear_slot(), Some(ChargenGearSlot::Shirt));
        assert_eq!(ChargenPart::Hair.gear_slot(), None);
    }

    fn catalog() -> Arc<CharacterGenCatalog> {
        Arc::new(CharacterGenCatalog {
            starter_areas: vec![],
            heritage_groups: BTreeMap::from([(
                1,
                CharacterGenHeritageGroup {
                    heritage_id: 1,
                    name: "Aluvian".to_string(),
                    icon_image: 0,
                    setup_id: 0,
                    environment_setup_id: 0,
                    attribute_credits: 330,
                    skill_credits: 50,
                    primary_start_area_ids: vec![0],
                    secondary_start_area_ids: vec![],
                    skill_overrides: BTreeMap::new(),
                    templates: vec![],
                    genders: BTreeMap::from([(1, gender_def())]),
                },
            )]),
            skill_definitions: BTreeMap::new(),
            expected_skill_slots: 0,
        })
    }

    fn build(appearance: CharacterCreateAppearanceData) -> CharacterGenBuild {
        CharacterGenBuild {
            heritage: 1,
            gender: 1,
            appearance,
            template_option: 0,
            strength_ability: 10,
            endurance_ability: 10,
            coordination_ability: 10,
            quickness_ability: 10,
            focus_ability: 10,
            self_ability: 10,
            character_slot: 0,
            skill_advancement_classes: vec![],
            name: "Bestie".to_string(),
            start_area: 0,
            is_admin: false,
            is_sentinel: false,
        }
    }

    fn appearance_data(
        headgear: (u32, u32),
        shirt: (u32, u32),
        pants: (u32, u32),
        footwear: (u32, u32),
    ) -> CharacterCreateAppearanceData {
        CharacterCreateAppearanceData {
            eyes: 0,
            nose: 0,
            mouth: 0,
            hair_color: 1,
            eye_color: 1,
            hair_style: 0,
            headgear_style: headgear.0,
            headgear_color: headgear.1,
            shirt_style: shirt.0,
            shirt_color: shirt.1,
            pants_style: pants.0,
            pants_color: pants.1,
            footwear_style: footwear.0,
            footwear_color: footwear.1,
            skin_hue: 0.5,
            hair_hue: 0.5,
            headgear_hue: 0.5,
            shirt_hue: 0.5,
            pants_hue: 0.5,
            footwear_hue: 0.5,
        }
    }

    /// The verifier's latent bug: the wire key is the GEAR's list entry
    /// (GetCharGenResult), not the gender list's; out of range → 0.
    #[test]
    fn wire_appearance_sends_the_gear_list_key() {
        let builder =
            CharacterGenBuilder::new(catalog()).with_clothing_tables(Arc::new(tables()));
        let wire = builder.wire_appearance(&build(appearance_data(
            (0, 0),
            (1, 1),
            (0, 2),
            (0, 1),
        )));
        assert_eq!(wire.headgear_color, 9, "hat 0x10000010 offers only 9");
        assert_eq!(wire.shirt_color, 6, "shirt 1 offers 12, 6");
        assert_eq!(wire.footwear_color, 9, "0x10000001 offers 4, 9");
        // Trousers' table is not loaded: the gender list, as before.
        assert_eq!(wire.pants_color, 4);
        assert_eq!(wire.hair_color, 1, "hair colour stays an index");
        assert_eq!(wire.eye_color, 1);

        // Out of the gear's range → 0, as GetCharGenResult sends.
        let wire = builder.wire_appearance(&build(appearance_data(
            (0, 1),
            (0, 2),
            (0, 0),
            (0, 4),
        )));
        assert_eq!(wire.headgear_color, 0);
        assert_eq!(wire.shirt_color, 0);
        assert_eq!(wire.footwear_color, 0);

        // No headgear → 0.
        let wire = builder.wire_appearance(&build(appearance_data(
            (u32::MAX, 0),
            (0, 0),
            (0, 0),
            (0, 0),
        )));
        assert_eq!(wire.headgear_color, 0);
        assert_eq!(wire.shirt_color, 4);

        // Without the tables: the old gender-list key.
        let plain = CharacterGenBuilder::new(catalog());
        let wire = plain.wire_appearance(&build(appearance_data(
            (0, 0),
            (1, 1),
            (0, 2),
            (0, 1),
        )));
        assert_eq!(wire.headgear_color, 9);
        assert_eq!(wire.shirt_color, 6);
        assert_eq!(wire.pants_color, 4);
        assert_eq!(wire.footwear_color, 6);
    }

    #[test]
    fn randomize_appearance_rolls_inside_the_gear_list() {
        let builder =
            CharacterGenBuilder::new(catalog()).with_clothing_tables(Arc::new(tables()));
        for _ in 0..200 {
            let a = builder.randomize_appearance(1, 1);
            // Both shirts offer two colours.
            assert!(a.shirt_color < 2, "{a:?}");
            assert!(a.footwear_color < 2, "{a:?}");
            assert_eq!(a.headgear_color, 0, "the hat offers one colour");
            // Trousers' table is not loaded: the gender list's range.
            assert!(a.pants_color < 5, "{a:?}");
            let wire = builder.wire_appearance(&build(a.clone()));
            assert_ne!(wire.shirt_color, 0, "{a:?}");
            assert_ne!(wire.footwear_color, 0, "{a:?}");
        }
    }

    // ── real client_portal.dat (test-fixtures-real-data) ────────────────────

    fn real_portal() -> Option<holtburger_dat::DatDatabase> {
        let path = std::env::var("HOLTBURGER_PORTAL_DAT")
            .unwrap_or_else(|_| "/home/wbterminal/ac_base_dats/client_portal.dat".to_string());
        holtburger_dat::DatDatabase::new(path).ok()
    }

    /// The verifier's test plan: for every heritage / gender / gear style,
    /// each colour index the gear offers goes on the wire as a key that is
    /// in the gear's ClothingTable AND the gender's ClothingColorsList; one
    /// past the end goes as 0. Every list key comes from the walk order.
    #[test]
    fn real_dat_wire_colour_keys_are_gear_valid() {
        use holtburger_dat::file_type::{CharGen, SkillTable};
        use std::io::Cursor;
        let Some(portal) = real_portal() else {
            eprintln!("skipping chargen colour keys: client_portal.dat not found");
            return;
        };
        let bytes = portal.get_file(CharGen::FILE_ID).expect("CharGen record");
        let char_gen = CharGen::read(&mut Cursor::new(bytes)).expect("CharGen parses");
        let catalog = Arc::new(CharacterGenCatalog::from_assets(
            &char_gen,
            &SkillTable::default(),
        ));

        let mut tables = ChargenClothingTables::default();
        let mut raw: HashMap<u32, ClothingTable> = HashMap::new();
        for heritage in catalog.heritage_groups.values() {
            for gender in heritage.genders.values() {
                for id in chargen_clothing_table_ids(&gender.appearance) {
                    if raw.contains_key(&id) {
                        continue;
                    }
                    let b = portal.get_file(id).expect("gear ClothingTable");
                    let table = ClothingTable::unpack(&b).expect("ClothingTable parses");
                    tables.insert(id, &table);
                    raw.insert(id, table);
                }
            }
        }
        assert!(!tables.is_empty());
        let builder = CharacterGenBuilder::new(catalog.clone())
            .with_clothing_tables(Arc::new(tables.clone()));

        let mut checked = 0usize;
        let mut differs_from_gender_list = 0usize;
        for heritage in catalog.heritage_groups.values() {
            for gender in heritage.genders.values() {
                let a = &gender.appearance;
                for slot in ChargenGearSlot::ALL {
                    for (style, gear) in slot.gear_list(a).iter().enumerate() {
                        let choices = tables
                            .gear_choices(a, slot, style as u32)
                            .expect("every gear table is loaded");
                        let table = &raw[&gear.clothing_table];
                        let walk = table.sub_pal_effect_keys_in_retail_order();
                        for (i, key) in choices.template_ids.iter().enumerate() {
                            assert!(table.clothing_sub_pal_effects.contains_key(key));
                            assert!(a.clothing_color_ids.contains(key));
                            assert!(walk.contains(key));
                            // Walk order: each later key comes later in the walk.
                            if i > 0 {
                                let before = choices.template_ids[i - 1];
                                let prev = walk.iter().position(|k| *k == before);
                                let here = walk.iter().position(|k| k == key);
                                assert!(prev < here, "walk order");
                            }
                        }
                        for color in 0..=choices.len() as u32 {
                            let mut look = CharacterCreateAppearanceData {
                                headgear_style: u32::MAX,
                                ..appearance_data((0, 0), (0, 0), (0, 0), (0, 0))
                            };
                            match slot {
                                ChargenGearSlot::Headgear => {
                                    look.headgear_style = style as u32;
                                    look.headgear_color = color;
                                }
                                ChargenGearSlot::Shirt => {
                                    look.shirt_style = style as u32;
                                    look.shirt_color = color;
                                }
                                ChargenGearSlot::Trousers => {
                                    look.pants_style = style as u32;
                                    look.pants_color = color;
                                }
                                ChargenGearSlot::Footwear => {
                                    look.footwear_style = style as u32;
                                    look.footwear_color = color;
                                }
                            }
                            let mut b = build(look);
                            b.heritage = heritage.heritage_id;
                            b.gender = gender.gender_id;
                            let wire = builder.wire_appearance(&b);
                            let sent = match slot {
                                ChargenGearSlot::Headgear => wire.headgear_color,
                                ChargenGearSlot::Shirt => wire.shirt_color,
                                ChargenGearSlot::Trousers => wire.pants_color,
                                ChargenGearSlot::Footwear => wire.footwear_color,
                            };
                            if (color as usize) < choices.len() {
                                assert_eq!(sent, choices.template_ids[color as usize]);
                                assert!(table.clothing_sub_pal_effects.contains_key(&sent));
                                assert!(a.clothing_color_ids.contains(&sent));
                                if a.clothing_color_ids.get(color as usize) != Some(&sent) {
                                    differs_from_gender_list += 1;
                                }
                            } else {
                                assert_eq!(sent, 0, "out of range → 0");
                            }
                            checked += 1;
                        }
                    }
                }
            }
        }
        assert!(checked > 100, "only {checked} colour picks checked");
        eprintln!(
            "chargen colour keys: {checked} picks checked, {differs_from_gender_list} differ from the old gender-list key"
        );
    }

    /// Spot colours come out for every part of a real Sex_CG once its
    /// records are loaded.
    #[test]
    fn real_dat_spot_colors_cover_every_part() {
        use holtburger_dat::file_type::{CharGen, Palette, PaletteSet, SkillTable};
        use std::io::Cursor;
        let Some(portal) = real_portal() else {
            eprintln!("skipping chargen spot colours: client_portal.dat not found");
            return;
        };
        let bytes = portal.get_file(CharGen::FILE_ID).expect("CharGen record");
        let char_gen = CharGen::read(&mut Cursor::new(bytes)).expect("CharGen parses");
        let catalog = CharacterGenCatalog::from_assets(&char_gen, &SkillTable::default());
        let gender = &catalog.heritage_group(1).expect("Aluvian").genders[&1];
        let mut tables = ChargenClothingTables::default();
        for id in chargen_clothing_table_ids(&gender.appearance) {
            let b = portal.get_file(id).expect("gear ClothingTable");
            tables.insert(id, &ClothingTable::unpack(&b).expect("parses"));
        }
        let mut dat = BarberDatCache::default();
        for part in ChargenPart::ALL {
            let gear = part
                .gear_slot()
                .and_then(|slot| tables.gear_choices(&gender.appearance, slot, 0));
            for set in chargen_part_palette_set_ids(gender, part, gear.as_ref()) {
                if let Ok(b) = portal.get_file(set) {
                    if let Ok(ps) = PaletteSet::unpack(&b) {
                        dat.palette_sets.insert(set, ps.palettes);
                    }
                }
            }
            for p in chargen_part_palette_ids(gender, part, gear.as_ref(), &dat) {
                if let Ok(b) = portal.get_file(p) {
                    if let Ok(pal) = Palette::unpack(&b) {
                        dat.palettes.insert(p, pal.colors);
                    }
                }
            }
            let spots = chargen_spot_colors(gender, part, gear.as_ref(), &dat);
            let expected = match part {
                ChargenPart::Hair => gender.appearance.hair_color_ids.len(),
                ChargenPart::Eyes => gender.appearance.eye_color_ids.len(),
                ChargenPart::Nose | ChargenPart::Mouth | ChargenPart::Skin => 1,
                _ => gear.as_ref().map_or(0, GearColorChoices::len),
            };
            assert_eq!(spots.len(), expected, "{part:?}");
            assert!(spots.iter().all(Option::is_some), "{part:?}: {spots:?}");
        }
    }
}
