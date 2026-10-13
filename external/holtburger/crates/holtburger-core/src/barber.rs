//! maps-chargen-barber-1 (2026-10-13) — the barber page's data half.
//!
//! Retail opens gmBarberUI on GameEventStartBarber (0x0075):
//! `gmBarberUI::RecvNotice_StartBarberNotice` (acclient.c:271178) runs
//! `InitializePage` (:270582), which turns the 16 StartBarber fields back
//! into Sex_CG list indices with `ACCharGenData::Get*FromID`
//! (:494562-494900). Apply (`ListenToElementMessage` case 0x100005A6,
//! :270145-270366) rebuilds the DIDs with
//! `ACCharGenData::GenerateBaseAppearanceData` (:494345), applies the
//! heritage option (Empyrean motion table; Undead flame / Shadow crown setup
//! and PhysicsScript) and sends `CM_Character::Event_FinishBarber` (0x0311)
//! with the same 16-field layout. Cancel only hides the page.
//!
//! This module is that logic, pure and synchronous. The wasm crate feeds it
//! the CharGen ObjDescs ([`CharacterGenFaceSex`]) and the PalSet / Palette
//! records ([`BarberDat`]); plugins/barber-panel.js is the page.
//!
//! ACE (`Player_Character.HandleActionFinishBarber`, Player_Character.cs:
//! 404-595) checks every DID against the Sex_CG lists and silently drops the
//! whole request on any mismatch, so [`validate_finish_barber`] ports those
//! checks as a pre-send self-test.

use holtburger_content::character_gen::{
    CharacterGenAnimPartChange, CharacterGenFaceSex, CharacterGenFaceStripDesc,
    CharacterGenHairStyleDesc, CharacterGenTextureChange,
};
use holtburger_protocol::messages::StartBarberEventData;
use std::collections::HashMap;

/// `BALD_TEXTURE_57` (acclient.c:45117).
pub const BALD_TEXTURE: u32 = 0x0500_10B7;

/// HeritageGroup values the page special-cases (ACE `HeritageGroup`).
pub const HERITAGE_SHADOWBOUND: u32 = 5;
pub const HERITAGE_GEARKNIGHT: u32 = 6;
pub const HERITAGE_EMPYREAN: u32 = 9;
pub const HERITAGE_PENUMBRAEN: u32 = 10;
pub const HERITAGE_UNDEAD: u32 = 11;
pub const HERITAGE_OLTHOI: u32 = 12;
pub const HERITAGE_OLTHOI_ACID: u32 = 13;
/// ACE `Gender.Female` (the decomp's `gender == 2`).
pub const GENDER_FEMALE: u32 = 2;

/// The client-only setups the option checkbox / Apply pick
/// (acclient.c:45122-45139; ACE `SetupConst`).
pub mod setup {
    pub const UNDEAD_MALE_SKELETON: u32 = 0x0200_1A9C;
    pub const UNDEAD_MALE_SKELETON_NOFLAME: u32 = 0x0200_1A9E;
    pub const UNDEAD_MALE_ZOMBIE: u32 = 0x0200_1A9D;
    pub const UNDEAD_MALE_ZOMBIE_NOFLAME: u32 = 0x0200_1A96;
    pub const UNDEAD_FEMALE_SKELETON: u32 = 0x0200_1AA0;
    pub const UNDEAD_FEMALE_SKELETON_NOFLAME: u32 = 0x0200_1A9F;
    pub const UNDEAD_FEMALE_ZOMBIE: u32 = 0x0200_1AA1;
    pub const UNDEAD_FEMALE_ZOMBIE_NOFLAME: u32 = 0x0200_1AA2;
    pub const UMBRAEN_MALE_CROWN: u32 = 0x0200_196F;
    pub const UMBRAEN_MALE_NOCROWN: u32 = 0x0200_1A5F;
    pub const UMBRAEN_FEMALE_CROWN: u32 = 0x0200_1970;
    pub const UMBRAEN_FEMALE_NOCROWN: u32 = 0x0200_1A5E;
    pub const PENUMBRAEN_MALE_CROWN: u32 = 0x0200_196E;
    pub const PENUMBRAEN_MALE_NOCROWN: u32 = 0x0200_1A5D;
    pub const PENUMBRAEN_FEMALE_CROWN: u32 = 0x0200_196D;
    pub const PENUMBRAEN_FEMALE_NOCROWN: u32 = 0x0200_1A5C;
}

/// The PhysicsScripts Apply plays on the player (acclient.c:45140-45149).
/// `UNDEAD_*_NOFLAME_PES` and `PENUMBRAEN_*_NOCROWN_PES` are declared
/// (acclient.c:53849-53854) but live in .bss with no initializer (0 in the
/// 2013 image too, 0x8405cc-0x8405e0), so Apply plays nothing for them —
/// only the particle manager goes.
pub mod script {
    pub const UNDEAD_MALE_SKELETON: u32 = 0x3300_12D4;
    pub const UNDEAD_MALE_ZOMBIE: u32 = 0x3300_12D3;
    pub const UNDEAD_FEMALE_SKELETON: u32 = 0x3300_12D5;
    pub const UNDEAD_FEMALE_ZOMBIE: u32 = 0x3300_12D6;
    pub const UNDEAD_NOFLAME: u32 = 0;
    pub const UMBRAEN_MALE_CROWN: u32 = 0x3300_1256;
    pub const UMBRAEN_MALE_NOCROWN: u32 = 0x3300_12BB;
    pub const UMBRAEN_FEMALE_CROWN: u32 = 0x3300_1257;
    pub const UMBRAEN_FEMALE_NOCROWN: u32 = 0x3300_12BA;
    pub const PENUMBRAEN_MALE_CROWN: u32 = 0x3300_1255;
    pub const PENUMBRAEN_FEMALE_CROWN: u32 = 0x3300_1254;
    pub const PENUMBRAEN_NOCROWN: u32 = 0;
}

/// The Empyrean motion tables Apply sets on the player
/// (acclient.c:45118-45121; ACE GameEventStartBarber / Player_Character).
pub mod empyrean_motion {
    pub const MALE_FLOAT: u32 = 0x0900_020B;
    pub const FEMALE_FLOAT: u32 = 0x0900_020A;
    pub const MALE_BOUND: u32 = 0x0900_020E;
    pub const FEMALE_BOUND: u32 = 0x0900_020D;
}

/// `gmBarberUI::SetSelection` colour-wheel sample indices: hair PalSets at
/// 208, the skin PalSet at 176 (nose / mouth / skin rows), eye palettes at
/// 259 (`ClientCharGenState::GetColorFromPal`).
pub const HAIR_SPOT_SAMPLE: usize = 208;
pub const SKIN_SPOT_SAMPLE: usize = 176;
pub const EYE_SPOT_SAMPLE: usize = 259;

/// The DAT records the barber reads besides CharGen: PalSets (0x0F) for the
/// skin and hair shades, Palettes (0x04) for the colour wheel.
pub trait BarberDat {
    /// `PalSet::palette_IDs`, or `None` when the record is not loaded.
    fn palette_set(&self, id: u32) -> Option<&[u32]>;
    /// `Palette::ARGB`, or `None` when the record is not loaded.
    fn palette_colors(&self, _id: u32) -> Option<&[u32]> {
        None
    }
}

/// A plain [`BarberDat`] the caller fills.
#[derive(Debug, Clone, Default)]
pub struct BarberDatCache {
    pub palette_sets: HashMap<u32, Vec<u32>>,
    pub palettes: HashMap<u32, Vec<u32>>,
}

impl BarberDat for BarberDatCache {
    fn palette_set(&self, id: u32) -> Option<&[u32]> {
        self.palette_sets.get(&id).map(Vec::as_slice)
    }
    fn palette_colors(&self, id: u32) -> Option<&[u32]> {
        self.palettes.get(&id).map(Vec::as_slice)
    }
}

/// The PalSets InitializePage / Apply read for `sex`: the skin PalSet and
/// every hair-colour PalSet (non-zero, deduplicated, in list order).
pub fn barber_palette_set_ids(sex: &CharacterGenFaceSex) -> Vec<u32> {
    let mut out = Vec::new();
    for id in std::iter::once(sex.skin_palette_set).chain(sex.hair_color_ids.iter().copied()) {
        if id != 0 && !out.contains(&id) {
            out.push(id);
        }
    }
    out
}

/// The Palettes the colour wheel samples for `sex`: every palette of the
/// loaded skin / hair PalSets plus the eye-colour palettes.
pub fn barber_spot_palette_ids(sex: &CharacterGenFaceSex, dat: &impl BarberDat) -> Vec<u32> {
    let mut out = Vec::new();
    let mut push = |id: u32| {
        if id != 0 && !out.contains(&id) {
            out.push(id);
        }
    };
    for set in barber_palette_set_ids(sex) {
        if let Some(pals) = dat.palette_set(set) {
            for p in pals {
                push(*p);
            }
        }
    }
    for p in &sex.eye_color_ids {
        push(*p);
    }
    out
}

/// The heritage option checkbox (0x100005C9, InitializePage :271074-271170).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BarberOption {
    /// No checkbox.
    None,
    /// `ID_Barber_Empyrean_Earthbound` — the bound (walking) motion table.
    EmpyreanEarthbound,
    /// `ID_Barber_Undead_NoFlame` — the NOFLAME setups.
    UndeadNoFlame,
    /// `ID_Barber_Shadow_NoCrown` — the NOCROWN setups (Umbraen and
    /// Penumbraen).
    ShadowNoCrown,
}

impl BarberOption {
    pub fn for_heritage(heritage: u32) -> Self {
        match heritage {
            HERITAGE_EMPYREAN => Self::EmpyreanEarthbound,
            HERITAGE_UNDEAD => Self::UndeadNoFlame,
            HERITAGE_SHADOWBOUND | HERITAGE_PENUMBRAEN => Self::ShadowNoCrown,
            _ => Self::None,
        }
    }

    /// The checkbox label's string token (StringTable 0x23000001).
    pub fn string_token(self) -> Option<&'static str> {
        match self {
            Self::None => None,
            Self::EmpyreanEarthbound => Some("ID_Barber_Empyrean_Earthbound"),
            Self::UndeadNoFlame => Some("ID_Barber_Undead_NoFlame"),
            Self::ShadowNoCrown => Some("ID_Barber_Shadow_NoCrown"),
        }
    }
}

/// Gearknight and the two Olthoi heritages: no hair texture, nose / mouth
/// rows hidden, the eyes row's arrows ghosted (InitializePage :270858-270938).
pub fn is_gear_or_olthoi(heritage: u32) -> bool {
    matches!(
        heritage,
        HERITAGE_GEARKNIGHT | HERITAGE_OLTHOI | HERITAGE_OLTHOI_ACID
    )
}

/// The CharGenState fields the barber reads and writes (indices into the
/// Sex_CG lists, plus the two shades and the option checkbox).
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct BarberFace {
    pub hair_style: u32,
    pub eyes_strip: u32,
    pub nose_strip: u32,
    pub mouth_strip: u32,
    pub hair_color: u32,
    pub hair_shade: f64,
    pub skin_shade: f64,
    pub eye_color: u32,
    /// `m_pOption1Checkbox->m_state == 6`.
    pub option: bool,
}

/// `CharAppearanceData` — GenerateBaseAppearanceData's output (0 = INVALID).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct CharAppearanceData {
    pub base_palette: u32,
    pub head_object: u32,
    pub eyes_texture: u32,
    pub default_eyes_texture: u32,
    pub nose_texture: u32,
    pub default_nose_texture: u32,
    pub mouth_texture: u32,
    pub default_mouth_texture: u32,
    pub skin_palette: u32,
    pub hair_palette: u32,
    pub eyes_palette: u32,
}

/// What Apply does to the player in the world before the server answers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct BarberLocalEffects {
    /// `CPhysicsObj::SetMotionTableID` on the player (Empyrean); 0 = none.
    pub motion_table_id: u32,
    /// `CPhysicsObj::destroy_particle_manager` on the player.
    pub destroy_particles: bool,
    /// `CPhysicsObj::play_script` on the player; 0 = none.
    pub play_script: u32,
}

/// Apply's outcome.
#[derive(Debug, Clone, PartialEq)]
pub struct BarberApplyResult {
    /// The FinishBarber fields; `None` when GenerateBaseAppearanceData
    /// fails (retail then sends nothing and only hides the page).
    pub fields: Option<StartBarberEventData>,
    pub effects: BarberLocalEffects,
}

// ── ObjDesc access ──────────────────────────────────────────────────────────

/// `ObjDesc::GetTextureMapChange(n)` (acclient.c:469201) on the list
/// `ObjDesc::UnPack` builds: each change first removes an earlier one that
/// it `replaces` (same part index and old texture,
/// `RemoveDuplicateTextureMapChange` :469303 / `TextureMapChange::replaces`
/// :471676), then is appended.
pub fn retail_texture_change(
    changes: &[CharacterGenTextureChange],
    n: usize,
) -> Option<CharacterGenTextureChange> {
    let mut list: Vec<CharacterGenTextureChange> = Vec::with_capacity(changes.len());
    for c in changes {
        list.retain(|o| !(o.part_index == c.part_index && o.old_texture == c.old_texture));
        list.push(*c);
    }
    list.get(n).copied()
}

/// `ObjDesc::GetAnimPartChange(n)` (acclient.c:469228) on the list
/// `ObjDesc::UnPack` builds (a later change to the same part replaces an
/// earlier one, `RemoveDuplicateAnimPartChange`).
pub fn retail_anim_part_change(
    changes: &[CharacterGenAnimPartChange],
    n: usize,
) -> Option<CharacterGenAnimPartChange> {
    let mut list: Vec<CharacterGenAnimPartChange> = Vec::with_capacity(changes.len());
    for c in changes {
        list.retain(|o| o.part_index != c.part_index);
        list.push(*c);
    }
    list.get(n).copied()
}

/// `PalSet::GetPaletteID(shade)` (acclient.c:470484):
/// `palette_IDs[(num_pals - 0.000001) * shade]` for a shade in [0, 1], else
/// INVALID (0).
pub fn palette_for_shade(palettes: &[u32], shade: f64) -> u32 {
    let n = palettes.len();
    if n == 0 || !(0.0..=1.0).contains(&shade) {
        return 0;
    }
    let idx = ((n as f64 - 0.000_001) * shade) as usize;
    palettes[idx.min(n - 1)]
}

/// `CharGenState::GetSetupID` (acclient.c:497124) with a hair style chosen:
/// the style's alternate setup, else the Sex_CG setup.
pub fn chargen_setup_id(sex: &CharacterGenFaceSex, hair_style: u32) -> u32 {
    match sex.hair_styles.get(hair_style as usize) {
        Some(h) if h.alternate_setup != 0 => h.alternate_setup,
        _ => sex.setup_id,
    }
}

fn is_skeleton_setup(setup_id: u32) -> bool {
    matches!(
        setup_id,
        setup::UNDEAD_MALE_SKELETON
            | setup::UNDEAD_MALE_SKELETON_NOFLAME
            | setup::UNDEAD_FEMALE_SKELETON
            | setup::UNDEAD_FEMALE_SKELETON_NOFLAME
    )
}

fn is_zombie_setup(setup_id: u32) -> bool {
    matches!(
        setup_id,
        setup::UNDEAD_FEMALE_ZOMBIE
            | setup::UNDEAD_FEMALE_ZOMBIE_NOFLAME
            | setup::UNDEAD_MALE_ZOMBIE
            | setup::UNDEAD_MALE_ZOMBIE_NOFLAME
    )
}

// ── ACCharGenData lookups (InitializePage) ──────────────────────────────────

/// `ACCharGenData::GetHairIndexFromID` (acclient.c:494562): the first style
/// whose head object (`AnimPartChange[0]`) is `head_object` and whose bald
/// flag matches; 0 for INVALID or no match.
pub fn hair_index_from_id(sex: &CharacterGenFaceSex, head_object: u32, bald: bool) -> u32 {
    if head_object == 0 {
        return 0;
    }
    sex.hair_styles
        .iter()
        .position(|h| {
            retail_anim_part_change(&h.anim_part_changes, 0)
                .is_some_and(|a| a.part_id == head_object)
                && h.bald == bald
        })
        .map_or(0, |i| i as u32)
}

/// `ACCharGenData::GetEyeStripIndexFromID` (acclient.c:494614): match the
/// new texture of `(bald ? objDesc_Bald : objDesc).GetTextureMapChange(
/// use_alternate_texture)`.
pub fn eye_strip_index_from_id(
    sex: &CharacterGenFaceSex,
    eyes_texture: u32,
    use_alternate_texture: bool,
    bald: bool,
) -> u32 {
    if eyes_texture == 0 {
        return 0;
    }
    let n = usize::from(use_alternate_texture);
    sex.eye_strips
        .iter()
        .position(|e| {
            let changes = if bald {
                &e.texture_changes_bald
            } else {
                &e.texture_changes
            };
            retail_texture_change(changes, n).is_some_and(|t| t.new_texture == eyes_texture)
        })
        .map_or(0, |i| i as u32)
}

/// `ACCharGenData::GetNoseStripIndexFromID` / `GetMouthStripIndexFromID`
/// (acclient.c:494676 / :494726).
pub fn face_strip_index_from_id(
    strips: &[CharacterGenFaceStripDesc],
    texture: u32,
    use_alternate_texture: bool,
) -> u32 {
    if texture == 0 {
        return 0;
    }
    let n = usize::from(use_alternate_texture);
    strips
        .iter()
        .position(|s| {
            retail_texture_change(&s.texture_changes, n).is_some_and(|t| t.new_texture == texture)
        })
        .map_or(0, |i| i as u32)
}

/// `ACCharGenData::GetSkinShadeFromID` (acclient.c:494776): (index + 1) /
/// num_pals of the skin PalSet — (num_pals + 1) / num_pals when absent,
/// which GetPaletteID then rejects; 0 for INVALID.
pub fn skin_shade_from_id(sex: &CharacterGenFaceSex, skin_palette: u32, dat: &impl BarberDat) -> f64 {
    if skin_palette == 0 {
        return 0.0;
    }
    let Some(pals) = dat.palette_set(sex.skin_palette_set) else {
        return 0.0;
    };
    if pals.is_empty() {
        return 0.0;
    }
    let i = pals.iter().position(|p| *p == skin_palette).unwrap_or(pals.len());
    (i + 1) as f64 / pals.len() as f64
}

/// `ACCharGenData::GetHairColorFromID` (acclient.c:494814): the first hair
/// colour whose PalSet holds `hair_palette`, with shade (index + 1) /
/// num_pals; (0, 0) for INVALID or no match.
pub fn hair_color_from_id(
    sex: &CharacterGenFaceSex,
    hair_palette: u32,
    dat: &impl BarberDat,
) -> (u32, f64) {
    if hair_palette == 0 {
        return (0, 0.0);
    }
    for (color, set) in sex.hair_color_ids.iter().enumerate() {
        let Some(pals) = dat.palette_set(*set) else {
            continue;
        };
        if let Some(j) = pals.iter().position(|p| *p == hair_palette) {
            return (color as u32, (j + 1) as f64 / pals.len() as f64);
        }
    }
    (0, 0.0)
}

/// `ACCharGenData::GetEyeColorFromID` (acclient.c:494883): the palette's
/// index in `mEyeColorList`; 0 for INVALID or no match.
pub fn eye_color_from_id(sex: &CharacterGenFaceSex, eyes_palette: u32) -> u32 {
    if eyes_palette == 0 {
        return 0;
    }
    sex.eye_color_ids
        .iter()
        .position(|p| *p == eyes_palette)
        .map_or(0, |i| i as u32)
}

/// InitializePage's clamp of each recovered choice (`>= iNumChoices` → 0).
fn clamp_choice(index: u32, count: usize) -> u32 {
    if (index as usize) < count { index } else { 0 }
}

/// `gmBarberUI::InitializePage` (acclient.c:270582): the face the page opens
/// with for the server's StartBarber fields.
///
/// - skeleton = the setup is one of the four Undead SKELETON setups (their
///   strips use the second TextureMapChange);
/// - bald = the hair texture is BALD_TEXTURE (bald styles use the eye
///   strip's bald ObjDesc);
/// - the option checkbox starts checked for an Earthbound Empyrean
///   (`option1`), a NOFLAME Undead or a NOCROWN Umbraen / Penumbraen setup.
pub fn barber_init(
    sex: &CharacterGenFaceSex,
    fields: &StartBarberEventData,
    dat: &impl BarberDat,
) -> BarberFace {
    let skeleton = is_skeleton_setup(fields.setup_table_id);
    let bald = fields.hair_texture == BALD_TEXTURE;
    let hair_style = clamp_choice(
        hair_index_from_id(sex, fields.head_object_did, bald),
        sex.hair_styles.len(),
    );
    let eyes_strip = clamp_choice(
        eye_strip_index_from_id(sex, fields.eyes_texture_did, skeleton, bald),
        sex.eye_strips.len(),
    );
    let nose_strip = clamp_choice(
        face_strip_index_from_id(&sex.nose_strips, fields.nose_texture_did, skeleton),
        sex.nose_strips.len(),
    );
    let mouth_strip = clamp_choice(
        face_strip_index_from_id(&sex.mouth_strips, fields.mouth_texture_did, skeleton),
        sex.mouth_strips.len(),
    );
    let (hair_color, hair_shade) = hair_color_from_id(sex, fields.hair_palette_did, dat);
    let skin_shade = skin_shade_from_id(sex, fields.skin_palette_did, dat);
    let eye_color = eye_color_from_id(sex, fields.eyes_palette_did);
    let s = fields.setup_table_id;
    let option = match sex.heritage_id {
        HERITAGE_EMPYREAN => fields.option1 != 0,
        HERITAGE_UNDEAD => matches!(
            s,
            setup::UNDEAD_FEMALE_SKELETON_NOFLAME
                | setup::UNDEAD_FEMALE_ZOMBIE_NOFLAME
                | setup::UNDEAD_MALE_SKELETON_NOFLAME
                | setup::UNDEAD_MALE_ZOMBIE_NOFLAME
        ),
        HERITAGE_SHADOWBOUND => {
            s == setup::UMBRAEN_MALE_NOCROWN || s == setup::UMBRAEN_FEMALE_NOCROWN
        }
        HERITAGE_PENUMBRAEN => {
            s == setup::PENUMBRAEN_MALE_NOCROWN || s == setup::PENUMBRAEN_FEMALE_NOCROWN
        }
        _ => false,
    };
    BarberFace {
        hair_style,
        eyes_strip,
        nose_strip,
        mouth_strip,
        hair_color,
        hair_shade,
        skin_shade,
        eye_color,
        option,
    }
}

// ── Apply ───────────────────────────────────────────────────────────────────

/// The first TextureMapChange Apply takes from a strip: the second one for a
/// skeleton hair style when it exists, else the first.
fn pick_texture_change(
    changes: &[CharacterGenTextureChange],
    use_second_texture: bool,
) -> Option<CharacterGenTextureChange> {
    let second = if use_second_texture {
        retail_texture_change(changes, 1)
    } else {
        None
    };
    second.or_else(|| retail_texture_change(changes, 0))
}

/// `ACCharGenData::GenerateBaseAppearanceData` (acclient.c:494345). `None`
/// when a list index is out of range or the skin / hair-colour PalSet is not
/// loaded (retail returns 0 and Apply sends nothing).
pub fn generate_base_appearance(
    sex: &CharacterGenFaceSex,
    face: &BarberFace,
    dat: &impl BarberDat,
) -> Option<CharAppearanceData> {
    let hair: &CharacterGenHairStyleDesc = sex.hair_styles.get(face.hair_style as usize)?;
    let eyes = sex.eye_strips.get(face.eyes_strip as usize)?;
    let nose = sex.nose_strips.get(face.nose_strip as usize)?;
    let mouth = sex.mouth_strips.get(face.mouth_strip as usize)?;
    let mut out = CharAppearanceData {
        base_palette: sex.base_palette,
        ..CharAppearanceData::default()
    };
    if let Some(head) = retail_anim_part_change(&hair.anim_part_changes, 0) {
        out.head_object = if sex.heritage_id == HERITAGE_GEARKNIGHT {
            0
        } else {
            head.part_id
        };
    }
    let use_second_texture = hair.alternate_setup == setup::UNDEAD_MALE_SKELETON
        || hair.alternate_setup == setup::UNDEAD_FEMALE_SKELETON;
    let eye_changes = if hair.bald {
        &eyes.texture_changes_bald
    } else {
        &eyes.texture_changes
    };
    if let Some(t) = pick_texture_change(eye_changes, use_second_texture) {
        out.eyes_texture = t.new_texture;
        out.default_eyes_texture = t.old_texture;
    }
    if let Some(t) = pick_texture_change(&nose.texture_changes, use_second_texture) {
        out.nose_texture = t.new_texture;
        out.default_nose_texture = t.old_texture;
    }
    if let Some(t) = pick_texture_change(&mouth.texture_changes, use_second_texture) {
        out.mouth_texture = t.new_texture;
        out.default_mouth_texture = t.old_texture;
    }
    let skin = dat.palette_set(sex.skin_palette_set)?;
    out.skin_palette = palette_for_shade(skin, face.skin_shade);
    let hair_set = *sex.hair_color_ids.get(face.hair_color as usize)?;
    let hair_pals = dat.palette_set(hair_set)?;
    out.hair_palette = palette_for_shade(hair_pals, face.hair_shade);
    out.eyes_palette = *sex.eye_color_ids.get(face.eye_color as usize)?;
    Some(out)
}

/// gmBarberUI Apply (`ListenToElementMessage` case 0x100005A6,
/// acclient.c:270145-270366): the local effects and the FinishBarber fields.
///
/// - the setup is `CharGenState::GetSetupID` (the hair style's alternate
///   setup, else the Sex_CG's);
/// - the hair texture pair is the style's first TextureMapChange (new, old),
///   INVALID for Gearknight / Olthoi;
/// - Empyrean: option1 = the checkbox, and the bound or float motion table;
/// - Undead: skeleton / zombie (from the setup) × flame / no flame (the
///   checkbox) picks the setup and script; Umbraen / Penumbraen: crown / no
///   crown. Each of those destroys the particle manager first.
pub fn barber_apply(
    sex: &CharacterGenFaceSex,
    face: &BarberFace,
    dat: &impl BarberDat,
) -> BarberApplyResult {
    let heritage = sex.heritage_id;
    let female = sex.gender_id == GENDER_FEMALE;
    let mut new_setup = chargen_setup_id(sex, face.hair_style);

    let (mut head_texture, mut default_head_texture) = (0, 0);
    if !is_gear_or_olthoi(heritage) {
        if let Some(t) = sex
            .hair_styles
            .get(face.hair_style as usize)
            .and_then(|h| retail_texture_change(&h.texture_changes, 0))
        {
            head_texture = t.new_texture;
            default_head_texture = t.old_texture;
        }
    }

    let mut effects = BarberLocalEffects::default();
    let mut option1 = 0;
    if heritage == HERITAGE_EMPYREAN {
        if face.option {
            option1 = 1;
            effects.motion_table_id = if female {
                empyrean_motion::FEMALE_BOUND
            } else {
                empyrean_motion::MALE_BOUND
            };
        } else {
            effects.motion_table_id = if female {
                empyrean_motion::FEMALE_FLOAT
            } else {
                empyrean_motion::MALE_FLOAT
            };
        }
    }

    let picked: Option<(u32, u32)> = match heritage {
        HERITAGE_UNDEAD => {
            let zombie = is_zombie_setup(new_setup);
            Some(match (face.option, female, zombie) {
                (true, true, false) => (setup::UNDEAD_FEMALE_SKELETON_NOFLAME, script::UNDEAD_NOFLAME),
                (true, true, true) => (setup::UNDEAD_FEMALE_ZOMBIE_NOFLAME, script::UNDEAD_NOFLAME),
                (true, false, false) => (setup::UNDEAD_MALE_SKELETON_NOFLAME, script::UNDEAD_NOFLAME),
                (true, false, true) => (setup::UNDEAD_MALE_ZOMBIE_NOFLAME, script::UNDEAD_NOFLAME),
                (false, true, false) => (setup::UNDEAD_FEMALE_SKELETON, script::UNDEAD_FEMALE_SKELETON),
                (false, true, true) => (setup::UNDEAD_FEMALE_ZOMBIE, script::UNDEAD_FEMALE_ZOMBIE),
                (false, false, false) => (setup::UNDEAD_MALE_SKELETON, script::UNDEAD_MALE_SKELETON),
                (false, false, true) => (setup::UNDEAD_MALE_ZOMBIE, script::UNDEAD_MALE_ZOMBIE),
            })
        }
        HERITAGE_SHADOWBOUND => Some(match (face.option, female) {
            (true, true) => (setup::UMBRAEN_FEMALE_NOCROWN, script::UMBRAEN_FEMALE_NOCROWN),
            (true, false) => (setup::UMBRAEN_MALE_NOCROWN, script::UMBRAEN_MALE_NOCROWN),
            (false, true) => (setup::UMBRAEN_FEMALE_CROWN, script::UMBRAEN_FEMALE_CROWN),
            (false, false) => (setup::UMBRAEN_MALE_CROWN, script::UMBRAEN_MALE_CROWN),
        }),
        HERITAGE_PENUMBRAEN => Some(match (face.option, female) {
            (true, true) => (setup::PENUMBRAEN_FEMALE_NOCROWN, script::PENUMBRAEN_NOCROWN),
            (true, false) => (setup::PENUMBRAEN_MALE_NOCROWN, script::PENUMBRAEN_NOCROWN),
            (false, true) => (setup::PENUMBRAEN_FEMALE_CROWN, script::PENUMBRAEN_FEMALE_CROWN),
            (false, false) => (setup::PENUMBRAEN_MALE_CROWN, script::PENUMBRAEN_MALE_CROWN),
        }),
        _ => None,
    };
    if let Some((s, pes)) = picked {
        new_setup = s;
        effects.destroy_particles = true;
        effects.play_script = pes;
    }

    let fields = generate_base_appearance(sex, face, dat).map(|cad| StartBarberEventData {
        palette_base_did: cad.base_palette,
        head_object_did: cad.head_object,
        hair_texture: head_texture,
        default_hair_texture: default_head_texture,
        eyes_texture_did: cad.eyes_texture,
        default_eyes_texture_did: cad.default_eyes_texture,
        nose_texture_did: cad.nose_texture,
        default_nose_texture_did: cad.default_nose_texture,
        mouth_texture_did: cad.mouth_texture,
        default_mouth_texture_did: cad.default_mouth_texture,
        skin_palette_did: cad.skin_palette,
        hair_palette_did: cad.hair_palette,
        eyes_palette_did: cad.eyes_palette,
        setup_table_id: new_setup,
        option1,
        option2: 0,
    });
    BarberApplyResult { fields, effects }
}

// ── The colour wheel ────────────────────────────────────────────────────────

/// The page's parts (`gmBarberUI::EParts`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BarberPart {
    Hair = 1,
    Eyes = 2,
    Nose = 3,
    Mouth = 4,
    Skin = 5,
}

/// `ClientCharGenState::GetColorFromPal` (acclient.c, `Palette::get_color32`
/// :365029) split into RGB; `None` when the palette is not loaded or too
/// short.
pub fn palette_spot_color(palette: u32, sample: usize, dat: &impl BarberDat) -> Option<[u8; 3]> {
    let c = *dat.palette_colors(palette)?.get(sample)?;
    Some([(c >> 16) as u8, (c >> 8) as u8, c as u8])
}

/// One `gmBarberUI::SetSelection` PalSet spot: the per-channel integer mean
/// of `GetColorFromPal(palette, sample)` over the PalSet's palettes.
/// `None` when the PalSet (or any of its palettes) is not loaded.
pub fn palette_set_spot_color(set: u32, sample: usize, dat: &impl BarberDat) -> Option<[u8; 3]> {
    let pals = dat.palette_set(set)?;
    if pals.is_empty() {
        return None;
    }
    let mut sum = [0u32; 3];
    for p in pals {
        let c = palette_spot_color(*p, sample, dat)?;
        for k in 0..3 {
            sum[k] += u32::from(c[k]);
        }
    }
    let n = pals.len() as u32;
    Some([(sum[0] / n) as u8, (sum[1] / n) as u8, (sum[2] / n) as u8])
}

/// The colour wheel's spots for `part` (`gmBarberUI::SetSelection`,
/// acclient.c:269647): hair — one spot per hair-colour PalSet;
/// eyes — one per eye palette; nose / mouth / skin — the skin PalSet's
/// single spot.
pub fn barber_spot_colors(
    sex: &CharacterGenFaceSex,
    part: BarberPart,
    dat: &impl BarberDat,
) -> Vec<Option<[u8; 3]>> {
    match part {
        BarberPart::Hair => sex
            .hair_color_ids
            .iter()
            .map(|s| palette_set_spot_color(*s, HAIR_SPOT_SAMPLE, dat))
            .collect(),
        BarberPart::Eyes => sex
            .eye_color_ids
            .iter()
            .map(|p| palette_spot_color(*p, EYE_SPOT_SAMPLE, dat))
            .collect(),
        BarberPart::Nose | BarberPart::Mouth | BarberPart::Skin => {
            vec![palette_set_spot_color(sex.skin_palette_set, SKIN_SPOT_SAMPLE, dat)]
        }
    }
}

// ── ACE's validation (pre-send self-check) ──────────────────────────────────

/// A FinishBarber field ACE `HandleActionFinishBarber` would reject.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BarberFieldError {
    PaletteBase,
    HeadObject,
    EyesTexture,
    DefaultEyesTexture,
    NoseTexture,
    DefaultNoseTexture,
    MouthTexture,
    DefaultMouthTexture,
    HairTexture,
    DefaultHairTexture,
    SkinPalette,
    HairPalette,
    EyesPalette,
    SetupTable,
}

impl BarberFieldError {
    /// A stable camelCase name for JS.
    pub fn name(self) -> &'static str {
        match self {
            Self::PaletteBase => "paletteBase",
            Self::HeadObject => "headObject",
            Self::EyesTexture => "eyesTexture",
            Self::DefaultEyesTexture => "defaultEyesTexture",
            Self::NoseTexture => "noseTexture",
            Self::DefaultNoseTexture => "defaultNoseTexture",
            Self::MouthTexture => "mouthTexture",
            Self::DefaultMouthTexture => "defaultMouthTexture",
            Self::HairTexture => "hairTexture",
            Self::DefaultHairTexture => "defaultHairTexture",
            Self::SkinPalette => "skinPalette",
            Self::HairPalette => "hairPalette",
            Self::EyesPalette => "eyesPalette",
            Self::SetupTable => "setupTable",
        }
    }
}

/// ACE `ValidHeritageSetups` (Player_Character.cs:616-640): setups defined
/// in acclient but not in the DAT, per heritage and gender.
fn ace_valid_heritage_setup(heritage: u32, gender: u32, setup_id: u32) -> bool {
    let female = gender == GENDER_FEMALE;
    let male = gender == 1;
    match heritage {
        HERITAGE_SHADOWBOUND => {
            (male && (setup_id == setup::UMBRAEN_MALE_CROWN || setup_id == setup::UMBRAEN_MALE_NOCROWN))
                || (female
                    && (setup_id == setup::UMBRAEN_FEMALE_CROWN
                        || setup_id == setup::UMBRAEN_FEMALE_NOCROWN))
        }
        HERITAGE_PENUMBRAEN => {
            (male
                && (setup_id == setup::PENUMBRAEN_MALE_CROWN
                    || setup_id == setup::PENUMBRAEN_MALE_NOCROWN))
                || (female
                    && (setup_id == setup::PENUMBRAEN_FEMALE_CROWN
                        || setup_id == setup::PENUMBRAEN_FEMALE_NOCROWN))
        }
        HERITAGE_UNDEAD => {
            (male
                && matches!(
                    setup_id,
                    setup::UNDEAD_MALE_SKELETON
                        | setup::UNDEAD_MALE_SKELETON_NOFLAME
                        | setup::UNDEAD_MALE_ZOMBIE
                        | setup::UNDEAD_MALE_ZOMBIE_NOFLAME
                ))
                || (female
                    && matches!(
                        setup_id,
                        setup::UNDEAD_FEMALE_SKELETON
                            | setup::UNDEAD_FEMALE_SKELETON_NOFLAME
                            | setup::UNDEAD_FEMALE_ZOMBIE
                            | setup::UNDEAD_FEMALE_ZOMBIE_NOFLAME
                    ))
        }
        _ => false,
    }
}

fn any_texture(changes: &[CharacterGenTextureChange], id: u32, compare_old: bool) -> bool {
    changes.iter().any(|t| {
        if compare_old {
            t.old_texture == id
        } else {
            t.new_texture == id
        }
    })
}

/// Port of ACE `Player.HandleActionFinishBarber`'s validation
/// (Player_Character.cs:442-484 and the `Validate*` helpers :598-765). An
/// empty result means ACE applies the change; any entry means ACE clears
/// BarberActive and drops the request without a word.
pub fn validate_finish_barber(
    sex: &CharacterGenFaceSex,
    f: &StartBarberEventData,
    dat: &impl BarberDat,
) -> Vec<BarberFieldError> {
    let heritage = sex.heritage_id;
    let gear_olthoi = is_gear_or_olthoi(heritage);
    let mut bad = Vec::new();

    if sex.base_palette != f.palette_base_did {
        bad.push(BarberFieldError::PaletteBase);
    }

    // ValidateHairStyle: any AnimPartChange of any style (0 is fine for
    // Gearknight / Olthoi, with no style).
    let mut style: Option<&CharacterGenHairStyleDesc> = None;
    let head_ok = if f.head_object_did == 0 && gear_olthoi {
        true
    } else {
        style = sex.hair_styles.iter().find(|h| {
            h.anim_part_changes
                .iter()
                .any(|a| a.part_id == f.head_object_did)
        });
        style.is_some()
    };
    if !head_ok {
        bad.push(BarberFieldError::HeadObject);
    }
    let bald = style.is_some_and(|h| h.bald);

    // ValidateEyeTexture: any TextureMapChange of any eye strip's (bald)
    // ObjDesc.
    let eye_ok = |id: u32, compare_old: bool| {
        sex.eye_strips.iter().any(|e| {
            let changes = if bald {
                &e.texture_changes_bald
            } else {
                &e.texture_changes
            };
            any_texture(changes, id, compare_old)
        })
    };
    if !eye_ok(f.eyes_texture_did, false) {
        bad.push(BarberFieldError::EyesTexture);
    }
    if !eye_ok(f.default_eyes_texture_did, true) {
        bad.push(BarberFieldError::DefaultEyesTexture);
    }

    // ValidateFaceTexture.
    let face_ok = |strips: &[CharacterGenFaceStripDesc], id: u32, compare_old: bool| {
        strips
            .iter()
            .any(|s| any_texture(&s.texture_changes, id, compare_old))
    };
    if !face_ok(sex.nose_strips.as_slice(), f.nose_texture_did, false) {
        bad.push(BarberFieldError::NoseTexture);
    }
    if !face_ok(sex.nose_strips.as_slice(), f.default_nose_texture_did, true) {
        bad.push(BarberFieldError::DefaultNoseTexture);
    }
    if !face_ok(sex.mouth_strips.as_slice(), f.mouth_texture_did, false) {
        bad.push(BarberFieldError::MouthTexture);
    }
    if !face_ok(sex.mouth_strips.as_slice(), f.default_mouth_texture_did, true) {
        bad.push(BarberFieldError::DefaultMouthTexture);
    }

    // ValidateHairTexture: 0 is fine for Gearknight / Olthoi; otherwise a
    // TextureMapChange of the validated style (no style → invalid; ACE
    // dereferences null there).
    let hair_ok = |id: u32, compare_old: bool| {
        if id == 0 && gear_olthoi {
            return true;
        }
        style.is_some_and(|h| any_texture(&h.texture_changes, id, compare_old))
    };
    if !hair_ok(f.hair_texture, false) {
        bad.push(BarberFieldError::HairTexture);
    }
    if !hair_ok(f.default_hair_texture, true) {
        bad.push(BarberFieldError::DefaultHairTexture);
    }

    // ValidateSkinPalette / ValidateEyesPalette / ValidateHairPalette.
    let skin_ok = dat
        .palette_set(sex.skin_palette_set)
        .is_some_and(|p| p.contains(&f.skin_palette_did));
    if !skin_ok {
        bad.push(BarberFieldError::SkinPalette);
    }
    if !sex.eye_color_ids.contains(&f.eyes_palette_did) {
        bad.push(BarberFieldError::EyesPalette);
    }
    let hair_pal_ok = sex.hair_color_ids.iter().any(|set| {
        dat.palette_set(*set)
            .is_some_and(|p| p.contains(&f.hair_palette_did))
    });
    if !hair_pal_ok {
        bad.push(BarberFieldError::HairPalette);
    }

    // ValidateSetupTable.
    let setup_ok = style.is_some_and(|h| {
        h.alternate_setup > 0 && h.alternate_setup == f.setup_table_id
    }) || sex.setup_id == f.setup_table_id
        || ace_valid_heritage_setup(heritage, sex.gender_id, f.setup_table_id);
    if !setup_ok {
        bad.push(BarberFieldError::SetupTable);
    }
    bad
}

#[cfg(test)]
mod tests {
    use super::*;
    use holtburger_content::character_gen::{
        CharacterGenEyeStripDesc, CharacterGenFaceTable,
    };

    fn tmc(part_index: u8, old: u32, new: u32) -> CharacterGenTextureChange {
        CharacterGenTextureChange {
            part_index,
            old_texture: old,
            new_texture: new,
        }
    }

    fn apc(part_index: u8, part_id: u32) -> CharacterGenAnimPartChange {
        CharacterGenAnimPartChange {
            part_index,
            part_id,
        }
    }

    #[test]
    fn retail_texture_change_drops_a_replaced_change_and_appends() {
        let list = [tmc(16, 0x10, 0x11), tmc(16, 0x20, 0x21), tmc(16, 0x10, 0x12)];
        // UnPack: the third replaces the first (same part + old) and goes last.
        assert_eq!(retail_texture_change(&list, 0), Some(tmc(16, 0x20, 0x21)));
        assert_eq!(retail_texture_change(&list, 1), Some(tmc(16, 0x10, 0x12)));
        assert_eq!(retail_texture_change(&list, 2), None);
        assert_eq!(
            retail_anim_part_change(&[apc(0, 1), apc(1, 2), apc(0, 3)], 0),
            Some(apc(1, 2))
        );
    }

    #[test]
    fn palette_for_shade_matches_palset_get_palette_id() {
        let pals = [10, 11, 12, 13];
        assert_eq!(palette_for_shade(&pals, 0.0), 10);
        assert_eq!(palette_for_shade(&pals, 1.0), 13);
        // (index + 1) / n — what Get*FromID hands back — maps to index.
        for i in 0..pals.len() {
            assert_eq!(palette_for_shade(&pals, (i + 1) as f64 / 4.0), pals[i]);
        }
        assert_eq!(palette_for_shade(&pals, 1.25), 0, "out of range → INVALID");
        assert_eq!(palette_for_shade(&pals, -0.1), 0);
        assert_eq!(palette_for_shade(&[], 0.5), 0);
    }

    /// A two-style Undead male: a skeleton style and a zombie style, strips
    /// with a second (skeleton) TextureMapChange.
    fn undead_male() -> (CharacterGenFaceSex, BarberDatCache) {
        let strip = |a: u32, b: u32| CharacterGenFaceStripDesc {
            texture_changes: vec![tmc(16, a, a + 1), tmc(16, b, b + 1)],
        };
        let sex = CharacterGenFaceSex {
            heritage_id: HERITAGE_UNDEAD,
            gender_id: 1,
            setup_id: 0x0200_1A0E,
            base_palette: 0x0400_0001,
            skin_palette_set: 0x0F00_0001,
            hair_color_ids: vec![0x0F00_0002],
            eye_color_ids: vec![0x0400_0100, 0x0400_0101],
            hair_styles: vec![
                CharacterGenHairStyleDesc {
                    bald: false,
                    alternate_setup: setup::UNDEAD_MALE_SKELETON,
                    anim_part_changes: vec![apc(16, 0x0100_0001)],
                    texture_changes: vec![tmc(16, 0x0500_0001, 0x0500_0001)],
                },
                CharacterGenHairStyleDesc {
                    bald: false,
                    alternate_setup: setup::UNDEAD_MALE_ZOMBIE,
                    anim_part_changes: vec![apc(16, 0x0100_0002)],
                    texture_changes: vec![tmc(16, 0x0500_0002, 0x0500_0002)],
                },
            ],
            eye_strips: vec![
                CharacterGenEyeStripDesc {
                    texture_changes: vec![tmc(16, 0x0500_0100, 0x0500_0101), tmc(16, 0x0500_0200, 0x0500_0201)],
                    texture_changes_bald: vec![tmc(16, 0x0500_0100, 0x0500_0101), tmc(16, 0x0500_0200, 0x0500_0201)],
                },
                CharacterGenEyeStripDesc {
                    texture_changes: vec![tmc(16, 0x0500_0100, 0x0500_0102), tmc(16, 0x0500_0200, 0x0500_0202)],
                    texture_changes_bald: vec![tmc(16, 0x0500_0100, 0x0500_0102), tmc(16, 0x0500_0200, 0x0500_0202)],
                },
            ],
            nose_strips: vec![strip(0x0500_0300, 0x0500_0400), strip(0x0500_0310, 0x0500_0410)],
            mouth_strips: vec![strip(0x0500_0500, 0x0500_0600)],
        };
        let mut dat = BarberDatCache::default();
        dat.palette_sets.insert(0x0F00_0001, vec![0x0400_1000, 0x0400_1001, 0x0400_1002]);
        dat.palette_sets.insert(0x0F00_0002, vec![0x0400_2000, 0x0400_2001]);
        (sex, dat)
    }

    #[test]
    fn undead_apply_picks_setup_script_and_second_texture() {
        let (sex, dat) = undead_male();
        let face = BarberFace {
            hair_style: 0,
            nose_strip: 1,
            skin_shade: 0.5,
            hair_shade: 1.0,
            eye_color: 1,
            ..BarberFace::default()
        };
        let r = barber_apply(&sex, &face, &dat);
        let f = r.fields.expect("fields");
        assert_eq!(f.setup_table_id, setup::UNDEAD_MALE_SKELETON);
        assert_eq!(r.effects.play_script, script::UNDEAD_MALE_SKELETON);
        assert!(r.effects.destroy_particles);
        // Skeleton style → the strips' SECOND TextureMapChange.
        assert_eq!(f.nose_texture_did, 0x0500_0411);
        assert_eq!(f.default_nose_texture_did, 0x0500_0410);
        assert_eq!(f.eyes_texture_did, 0x0500_0201);
        assert_eq!(f.skin_palette_did, 0x0400_1001);
        assert_eq!(f.hair_palette_did, 0x0400_2001);
        assert_eq!(f.eyes_palette_did, 0x0400_0101);
        assert_eq!(f.hair_texture, 0x0500_0001);
        assert!(validate_finish_barber(&sex, &f, &dat).is_empty());

        // No flame: NOFLAME setup, particles go, no script plays (.bss 0).
        let r = barber_apply(&sex, &BarberFace { option: true, ..face }, &dat);
        assert_eq!(r.fields.unwrap().setup_table_id, setup::UNDEAD_MALE_SKELETON_NOFLAME);
        assert!(r.effects.destroy_particles);
        assert_eq!(r.effects.play_script, 0);

        // Zombie style keeps the zombie line and the FIRST texture.
        let r = barber_apply(&sex, &BarberFace { hair_style: 1, ..face }, &dat);
        let f = r.fields.unwrap();
        assert_eq!(f.setup_table_id, setup::UNDEAD_MALE_ZOMBIE);
        assert_eq!(r.effects.play_script, script::UNDEAD_MALE_ZOMBIE);
        assert_eq!(f.nose_texture_did, 0x0500_0311);

        // Init of a NOFLAME skeleton checks the box and finds the strip by
        // its second texture.
        let fields = barber_apply(&sex, &BarberFace { option: true, ..face }, &dat)
            .fields
            .unwrap();
        let back = barber_init(&sex, &fields, &dat);
        assert!(back.option);
        assert_eq!(back.nose_strip, 1);
        assert_eq!(barber_apply(&sex, &back, &dat).fields.unwrap(), fields);
    }

    #[test]
    fn missing_palset_sends_nothing_and_validation_flags_fields() {
        let (sex, mut dat) = undead_male();
        dat.palette_sets.remove(&0x0F00_0001);
        let r = barber_apply(&sex, &BarberFace::default(), &dat);
        assert!(r.fields.is_none());
        assert!(r.effects.destroy_particles, "effects run before the send");

        let (sex, dat) = undead_male();
        let mut f = barber_apply(&sex, &BarberFace::default(), &dat).fields.unwrap();
        f.head_object_did = 0x0100_FFFF;
        f.setup_table_id = 0x0200_0001;
        let bad = validate_finish_barber(&sex, &f, &dat);
        assert!(bad.contains(&BarberFieldError::HeadObject));
        assert!(bad.contains(&BarberFieldError::HairTexture), "no style → hair texture invalid");
        assert!(bad.contains(&BarberFieldError::SetupTable));
    }

    #[test]
    fn empyrean_option_sets_option1_and_the_motion_table() {
        let (mut sex, dat) = undead_male();
        sex.heritage_id = HERITAGE_EMPYREAN;
        sex.gender_id = GENDER_FEMALE;
        for h in &mut sex.hair_styles {
            h.alternate_setup = 0;
        }
        let r = barber_apply(&sex, &BarberFace { option: true, ..BarberFace::default() }, &dat);
        assert_eq!(r.fields.unwrap().option1, 1);
        assert_eq!(r.effects.motion_table_id, empyrean_motion::FEMALE_BOUND);
        assert!(!r.effects.destroy_particles);
        let r = barber_apply(&sex, &BarberFace::default(), &dat);
        assert_eq!(r.effects.motion_table_id, empyrean_motion::FEMALE_FLOAT);
        let f = r.fields.unwrap();
        assert_eq!(f.option1, 0);
        assert_eq!(f.setup_table_id, sex.setup_id);
        let mut start = f;
        start.option1 = 1;
        assert!(barber_init(&sex, &start, &dat).option);
    }

    // ── real client_portal.dat (test-fixtures-real-data) ────────────────────

    fn real_portal() -> Option<holtburger_dat::DatDatabase> {
        let path = std::env::var("HOLTBURGER_PORTAL_DAT")
            .unwrap_or_else(|_| "/home/wbterminal/ac_base_dats/client_portal.dat".to_string());
        holtburger_dat::DatDatabase::new(path).ok()
    }

    fn real_table_and_dat(
        portal: &holtburger_dat::DatDatabase,
    ) -> (CharacterGenFaceTable, BarberDatCache) {
        use holtburger_dat::file_type::{CharGen, PaletteSet};
        use std::io::Cursor;
        let bytes = portal.get_file(CharGen::FILE_ID).expect("CharGen record");
        let char_gen = CharGen::read(&mut Cursor::new(bytes)).expect("CharGen parses");
        let table = CharacterGenFaceTable::from_char_gen(&char_gen);
        let mut dat = BarberDatCache::default();
        for sex in table.sexes.values() {
            for id in barber_palette_set_ids(sex) {
                if dat.palette_sets.contains_key(&id) {
                    continue;
                }
                let Ok(b) = portal.get_file(id) else { continue };
                if let Ok(ps) = PaletteSet::unpack(&b) {
                    dat.palette_sets.insert(id, ps.palettes);
                }
            }
        }
        (table, dat)
    }

    /// Every face the test walks for one Sex_CG: each list index of every
    /// part (others at 0, option off and on), every bald style × every eye
    /// strip, every Undead skeleton / zombie style × every face strip, and a
    /// spread of shades.
    fn faces_for(sex: &CharacterGenFaceSex) -> Vec<BarberFace> {
        let base = BarberFace {
            hair_shade: 0.5,
            skin_shade: 0.5,
            ..BarberFace::default()
        };
        let mut out = Vec::new();
        let counts = [
            sex.hair_styles.len(),
            sex.eye_strips.len(),
            sex.nose_strips.len(),
            sex.mouth_strips.len(),
            sex.hair_color_ids.len(),
            sex.eye_color_ids.len(),
        ];
        for (part, n) in counts.iter().enumerate() {
            for i in 0..*n as u32 {
                for option in [false, true] {
                    let mut f = BarberFace { option, ..base };
                    match part {
                        0 => f.hair_style = i,
                        1 => f.eyes_strip = i,
                        2 => f.nose_strip = i,
                        3 => f.mouth_strip = i,
                        4 => f.hair_color = i,
                        _ => f.eye_color = i,
                    }
                    out.push(f);
                }
            }
        }
        for (hi, h) in sex.hair_styles.iter().enumerate() {
            let skeleton_or_zombie = matches!(
                h.alternate_setup,
                setup::UNDEAD_MALE_SKELETON
                    | setup::UNDEAD_FEMALE_SKELETON
                    | setup::UNDEAD_MALE_ZOMBIE
                    | setup::UNDEAD_FEMALE_ZOMBIE
            );
            if !h.bald && !skeleton_or_zombie {
                continue;
            }
            for ei in 0..sex.eye_strips.len() as u32 {
                out.push(BarberFace { hair_style: hi as u32, eyes_strip: ei, ..base });
            }
            if skeleton_or_zombie {
                for ni in 0..sex.nose_strips.len() as u32 {
                    out.push(BarberFace { hair_style: hi as u32, nose_strip: ni, ..base });
                }
                for mi in 0..sex.mouth_strips.len() as u32 {
                    out.push(BarberFace { hair_style: hi as u32, mouth_strip: mi, ..base });
                }
            }
        }
        for shade in [0.0, 0.01, 0.2, 0.37, 0.99, 1.0] {
            out.push(BarberFace { hair_shade: shade, skin_shade: shade, ..base });
        }
        out
    }

    /// The verifier's round trip: for every heritage / gender / list index,
    /// barberApply(barberInit(fields)) == fields, and every Apply passes the
    /// ported ACE validation. Skips when the real portal.dat is absent.
    #[test]
    fn real_dat_init_then_apply_returns_the_fields_and_ace_accepts_them() {
        let Some(portal) = real_portal() else {
            eprintln!("skipping barber real-dat round trip: client_portal.dat not found");
            return;
        };
        let (table, dat) = real_table_and_dat(&portal);
        assert!(table.sexes.len() >= 20, "expected every heritage × gender");
        let mut checked = 0usize;
        for sex in table.sexes.values() {
            if sex.hair_styles.is_empty() || sex.eye_strips.is_empty() {
                continue;
            }
            for face in faces_for(sex) {
                let first = barber_apply(sex, &face, &dat);
                let fields = first
                    .fields
                    .unwrap_or_else(|| panic!("{}/{} {face:?}: no fields", sex.heritage_id, sex.gender_id));
                let bad = validate_finish_barber(sex, &fields, &dat);
                assert!(
                    bad.is_empty(),
                    "{}/{} {face:?}: ACE would reject {bad:?} in {fields:?}",
                    sex.heritage_id,
                    sex.gender_id
                );
                let back = barber_init(sex, &fields, &dat);
                let again = barber_apply(sex, &back, &dat);
                assert_eq!(
                    again.fields.as_ref(),
                    Some(&fields),
                    "{}/{} {face:?} → init {back:?}",
                    sex.heritage_id,
                    sex.gender_id
                );
                assert_eq!(again.effects, first.effects);
                checked += 1;
            }
        }
        assert!(checked > 1000, "only {checked} faces checked");
    }

    /// Spot colours come out for every part once the palettes are loaded.
    #[test]
    fn real_dat_spot_colors_cover_every_part() {
        let Some(portal) = real_portal() else {
            eprintln!("skipping barber spot colours: client_portal.dat not found");
            return;
        };
        let (table, mut dat) = real_table_and_dat(&portal);
        let sex = table.sex(1, 1).expect("Aluvian male");
        for id in barber_spot_palette_ids(sex, &dat) {
            if let Ok(b) = portal.get_file(id) {
                if let Ok(p) = holtburger_dat::file_type::Palette::unpack(&b) {
                    dat.palettes.insert(id, p.colors);
                }
            }
        }
        let hair = barber_spot_colors(sex, BarberPart::Hair, &dat);
        assert_eq!(hair.len(), sex.hair_color_ids.len());
        assert!(hair.iter().all(Option::is_some));
        let eyes = barber_spot_colors(sex, BarberPart::Eyes, &dat);
        assert_eq!(eyes.len(), sex.eye_color_ids.len());
        assert!(eyes.iter().all(Option::is_some));
        let skin = barber_spot_colors(sex, BarberPart::Skin, &dat);
        assert_eq!(skin.len(), 1);
        assert!(skin[0].is_some());
        assert_eq!(barber_spot_colors(sex, BarberPart::Nose, &dat), skin);
    }
}
