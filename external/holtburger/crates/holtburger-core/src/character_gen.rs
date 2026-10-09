use holtburger_content::CharacterGenCatalog;
use holtburger_content::character_gen::{
    CharacterGenHeritageGroup, CharacterGenSkillCosts, CharacterGenSkillDefinition,
    CharacterGenTemplate,
};
use holtburger_protocol::messages::{
    CharacterCreateAppearanceData, CharacterCreateRequestData, SkillAdvancementClass,
};
use rand::RngExt;
use std::collections::BTreeSet;
use std::sync::Arc;
use thiserror::Error;

pub const CHARACTER_GEN_UNKNOWN_CONSTANT: u32 = 1;
pub const CHARACTER_GEN_DEFAULT_CLASS_ID: u32 = 1;
pub const CHARACTER_GEN_MIN_ATTRIBUTE: u32 = 10;
pub const CHARACTER_GEN_MAX_ATTRIBUTE: u32 = 100;
pub const CHARACTER_GEN_UNAVAILABLE_SKILL_COST: i32 = 999;

pub fn is_unavailable_character_gen_skill_cost(cost: i32) -> bool {
    cost >= CHARACTER_GEN_UNAVAILABLE_SKILL_COST
}

pub fn custom_template_for_heritage(
    heritage: &CharacterGenHeritageGroup,
) -> Option<&CharacterGenTemplate> {
    heritage
        .templates
        .iter()
        .find(|template| template.name.eq_ignore_ascii_case("Custom"))
        .or_else(|| {
            heritage
                .templates
                .iter()
                .find(|template| template.template_option == 0)
        })
        .or_else(|| heritage.templates.first())
}

/// Whether a catalog skill is one of the real SkillTable entries retail
/// character creation walks: id >= 1 (`CharGenState::ResetSkillLevels` and
/// `UpdateRemainingSkillCredits` start at skill 1) and not a retired-skill
/// placeholder holtburger-dat injects.
pub fn is_creation_table_skill(definition: &CharacterGenSkillDefinition) -> bool {
    definition.skill_id >= 1 && !definition.retired
}

/// The heritage-adjusted cost of holding `advancement`. Each tier's cost is
/// its full price: retail charges a specialised skill `specialized_cost`
/// alone, never trained + specialized (`CharGenState::
/// UpdateRemainingSkillCredits`, acclient.c:495070), and `SetSkillLevel`
/// (495350) refunds the old tier's full cost before charging the new one.
pub fn skill_advancement_cost(
    costs: CharacterGenSkillCosts,
    advancement: SkillAdvancementClass,
) -> i64 {
    match advancement {
        SkillAdvancementClass::Trained => i64::from(costs.trained_cost),
        SkillAdvancementClass::Specialized => i64::from(costs.specialized_cost),
        SkillAdvancementClass::Untrained | SkillAdvancementClass::Inactive => 0,
    }
}

/// Retail `CharGenState::ResetSkillLevels` (acclient.c:495832) for one table
/// skill: Trained when training is free (heritage trained cost <= 0),
/// Specialized when specialising is free too, otherwise Untrained. Negative
/// costs leave the slot Inactive. The same costs are the skills page's
/// floors: `gmCGSkillsPage::DoSkillRecords` sets `bUntrainable = trainCost
/// != 0` and `bUnspecializable = specCost != 0`, and `DecreaseSkillLevel`
/// refuses to go below them. Template skills are not floors.
pub fn skill_advancement_floor(costs: CharacterGenSkillCosts) -> SkillAdvancementClass {
    if costs.trained_cost < 0 || costs.specialized_cost < 0 {
        SkillAdvancementClass::Inactive
    } else if costs.trained_cost <= 0 {
        if costs.specialized_cost <= 0 {
            SkillAdvancementClass::Specialized
        } else {
            SkillAdvancementClass::Trained
        }
    } else {
        SkillAdvancementClass::Untrained
    }
}

/// The floor of one skill slot for a heritage (see `skill_advancement_floor`).
/// Slots that are not real table skills (slot 0, retired placeholders,
/// unknown ids) stay Inactive.
pub fn minimum_skill_advancement_for_heritage(
    catalog: &CharacterGenCatalog,
    heritage_id: u32,
    skill_id: u32,
) -> SkillAdvancementClass {
    if !catalog
        .skill_definition(skill_id)
        .is_some_and(is_creation_table_skill)
    {
        return SkillAdvancementClass::Inactive;
    }
    catalog
        .skill_costs_for_heritage(heritage_id, skill_id)
        .map(skill_advancement_floor)
        .unwrap_or(SkillAdvancementClass::Inactive)
}

/// Retail `CharGenState::ResetSkillLevels` over every skill slot.
pub fn reset_skill_levels(
    catalog: &CharacterGenCatalog,
    heritage_id: u32,
) -> Vec<SkillAdvancementClass> {
    let mut classes = vec![SkillAdvancementClass::Inactive; catalog.expected_skill_slots];
    for definition in catalog.skill_definitions.values() {
        if let Some(slot) = classes.get_mut(definition.skill_id as usize) {
            *slot = minimum_skill_advancement_for_heritage(catalog, heritage_id, definition.skill_id);
        }
    }
    classes
}

/// The skill half of retail `CharGenState::ApplyTemplate` (acclient.c:496607):
/// reset, then train each of the template's normal skills and specialise
/// each primary skill, each step only when the credits it leaves are not
/// negative (`SetSkillLevel` 495350 refunds the current tier first). Retail
/// forces template 0 for heritages 12 and 13; callers pick the template.
pub fn template_skill_levels(
    catalog: &CharacterGenCatalog,
    heritage_id: u32,
    template: &CharacterGenTemplate,
) -> Vec<SkillAdvancementClass> {
    let mut classes = reset_skill_levels(catalog, heritage_id);
    let mut remaining = catalog
        .heritage_group(heritage_id)
        .map(|heritage| i64::from(heritage.skill_credits))
        .unwrap_or_default();
    let steps = template
        .normal_skills
        .iter()
        .map(|skill| (*skill, SkillAdvancementClass::Trained))
        .chain(
            template
                .primary_skills
                .iter()
                .map(|skill| (*skill, SkillAdvancementClass::Specialized)),
        );
    for (skill_id, advancement) in steps {
        if !catalog
            .skill_definition(skill_id)
            .is_some_and(is_creation_table_skill)
        {
            continue;
        }
        let Some(costs) = catalog.skill_costs_for_heritage(heritage_id, skill_id) else {
            continue;
        };
        let Some(slot) = classes.get_mut(skill_id as usize) else {
            continue;
        };
        let after = remaining + skill_advancement_cost(costs, *slot)
            - skill_advancement_cost(costs, advancement);
        if after >= 0 {
            remaining = after;
            *slot = advancement;
        }
    }
    classes
}

fn advancement_rank(advancement: SkillAdvancementClass) -> u8 {
    match advancement {
        SkillAdvancementClass::Inactive => 0,
        SkillAdvancementClass::Untrained => 1,
        SkillAdvancementClass::Trained => 2,
        SkillAdvancementClass::Specialized => 3,
    }
}

/// `ACCharGenData::FormatName` (acclient.c:488655) — the name retail's
/// `CharGenState::SetName` stores and `VerifyCharacterGenerationResult`
/// requires (`strcmp(FormatName(name), name) == 0`). Keeps letters, and
/// spaces / apostrophes / hyphens where they join letters; drops digits and
/// everything else; caps the scan at 32 bytes; then capitalises the first
/// letter, lowercases the rest except after a space, hyphen or apostrophe
/// or a Mac/Mc/Fitz/Von/Van/De/Di/Du/Le/La prefix (left as typed), and
/// uppercases I/V/X roman-numeral words.
pub fn format_character_name(raw: &str) -> String {
    let bytes = raw.trim_end_matches(' ').as_bytes();
    let window = &bytes[..bytes.len().min(32)];
    let letterish = |c: Option<u8>| c.is_some_and(|c| c.is_ascii_alphabetic() || c >= 0x80);
    let mut out: Vec<u8> = Vec::with_capacity(window.len());
    for (i, &c) in window.iter().enumerate() {
        let prev = i.checked_sub(1).map(|j| window[j]);
        let next = window.get(i + 1).copied();
        let keep = match c {
            b'A'..=b'Z' | b'a'..=b'z' => true,
            b' ' => !(prev.is_none() || prev == Some(b' ') || next.is_none()),
            b'\'' => {
                letterish(prev) || (prev.is_some() && prev != Some(b'\'') && letterish(next))
            }
            b'-' => prev != Some(b'-') && letterish(prev) && (letterish(next) || next == Some(b'-')),
            _ => false,
        };
        if keep {
            out.push(c);
        }
    }
    #[derive(Clone, Copy, PartialEq)]
    enum Case {
        Upper,
        Lower,
        Either,
    }
    let n = out.len();
    let mut cases = vec![Case::Lower; n];
    if n > 0 {
        cases[0] = Case::Upper;
    }
    let prefixes: [(&[u8], usize); 10] = [
        (b"mac", 3),
        (b"mc", 2),
        (b"fitz", 4),
        (b"von", 3),
        (b"van", 3),
        (b"de", 2),
        (b"di", 2),
        (b"du", 2),
        (b"le", 2),
        (b"la", 2),
    ];
    let mut word_start = 0usize;
    loop {
        if word_start > 0 && word_start < n {
            cases[word_start] = Case::Either;
        }
        for (prefix, len) in prefixes {
            let end = word_start + len;
            if end < n && out[word_start..end].eq_ignore_ascii_case(prefix) {
                cases[end] = Case::Either;
            }
        }
        let Some(sep) = out[word_start.min(n)..]
            .iter()
            .position(|c| matches!(c, b' ' | b'-' | b'\''))
        else {
            break;
        };
        word_start += sep + 1;
        if word_start >= n {
            break;
        }
    }
    let mut i = 0;
    while i < n {
        if !(out[i].is_ascii_alphabetic() || out[i] >= 0x80) {
            i += 1;
            continue;
        }
        let start = i;
        while i < n && (out[i].is_ascii_alphabetic() || out[i] >= 0x80) {
            i += 1;
        }
        if out[start..i].iter().all(|c| matches!(c, b'I' | b'V' | b'X')) {
            cases[start..i].fill(Case::Upper);
        }
    }
    for (c, case) in out.iter_mut().zip(cases) {
        match case {
            Case::Upper => c.make_ascii_uppercase(),
            Case::Lower => c.make_ascii_lowercase(),
            Case::Either => {}
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[derive(Debug, Clone)]
pub struct CharacterGenBuild {
    pub heritage: u32,
    pub gender: u32,
    pub appearance: CharacterCreateAppearanceData,
    pub template_option: i32,
    pub strength_ability: u32,
    pub endurance_ability: u32,
    pub coordination_ability: u32,
    pub quickness_ability: u32,
    pub focus_ability: u32,
    pub self_ability: u32,
    pub character_slot: u32,
    pub skill_advancement_classes: Vec<SkillAdvancementClass>,
    pub name: String,
    pub start_area: u32,
    pub is_admin: bool,
    pub is_sentinel: bool,
}

impl CharacterGenBuild {
    pub fn attribute_total(&self) -> u32 {
        self.strength_ability
            + self.endurance_ability
            + self.coordination_ability
            + self.quickness_ability
            + self.focus_ability
            + self.self_ability
    }
}

#[derive(Debug, Clone)]
pub struct CharacterGenPolicy {
    pub unknown_constant: u32,
    pub class_id: u32,
    pub allow_admin_flag: bool,
    pub allow_sentinel_flag: bool,
    pub disabled_heritages: BTreeSet<u32>,
    pub enforce_heritage_start_area_membership: bool,
    pub require_nonempty_name: bool,
}

impl Default for CharacterGenPolicy {
    fn default() -> Self {
        Self {
            unknown_constant: CHARACTER_GEN_UNKNOWN_CONSTANT,
            class_id: CHARACTER_GEN_DEFAULT_CLASS_ID,
            allow_admin_flag: false,
            allow_sentinel_flag: false,
            disabled_heritages: BTreeSet::new(),
            enforce_heritage_start_area_membership: false,
            require_nonempty_name: true,
        }
    }
}

#[derive(Debug, Clone)]
pub struct CharacterGenBuilder {
    catalog: Arc<CharacterGenCatalog>,
    policy: CharacterGenPolicy,
}

impl CharacterGenBuilder {
    pub fn new(catalog: Arc<CharacterGenCatalog>) -> Self {
        Self::with_policy(catalog, CharacterGenPolicy::default())
    }

    pub fn with_policy(catalog: Arc<CharacterGenCatalog>, policy: CharacterGenPolicy) -> Self {
        Self { catalog, policy }
    }

    pub fn catalog(&self) -> &CharacterGenCatalog {
        self.catalog.as_ref()
    }

    pub fn policy(&self) -> &CharacterGenPolicy {
        &self.policy
    }

    pub fn validate(
        &self,
        build: &CharacterGenBuild,
    ) -> Result<(), Vec<CharacterGenValidationError>> {
        let errors = self.collect_errors(build);
        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors)
        }
    }

    pub fn build_request(
        &self,
        build: CharacterGenBuild,
    ) -> Result<CharacterCreateRequestData, Vec<CharacterGenValidationError>> {
        self.validate(&build)?;
        let appearance = self.wire_appearance(&build);

        Ok(CharacterCreateRequestData {
            account_name: String::new(),
            unknown_constant: self.policy.unknown_constant,
            heritage: build.heritage,
            gender: build.gender,
            appearance,
            template_option: build.template_option,
            strength_ability: build.strength_ability,
            endurance_ability: build.endurance_ability,
            coordination_ability: build.coordination_ability,
            quickness_ability: build.quickness_ability,
            focus_ability: build.focus_ability,
            self_ability: build.self_ability,
            character_slot: build.character_slot,
            class_id: self.policy.class_id,
            skill_advancement_classes: build.skill_advancement_classes,
            name: build.name,
            start_area: build.start_area,
            is_admin: build.is_admin,
            is_sentinel: build.is_sentinel,
        })
    }

    /// The appearance as it goes on the wire. The build carries every
    /// choice as a list index, as retail `CharGenState` does;
    /// `CharGenState::GetCharGenResult` (acclient.c:495612) then sends the
    /// headgear / shirt / trousers / footwear colours as palette-template
    /// keys (`shirtPaletteTemplateIDs[shirtColor]`, 0 when out of range)
    /// and hair / eye colours as indices. The server looks the key up in
    /// the gear's ClothingTable (`VerifyCharacterGenerationResult` →
    /// `ClothingTable::GetCloPaletteTemplate`; ACE stamps it as the item's
    /// PaletteTemplate and icon), so an index there is the wrong colour.
    ///
    /// The keys come from the gender's ClothingColorsList, which holds
    /// every key retail's per-gear lists (StoreColorInformation) can
    /// offer. Retail orders each gear's list by ClothingTable hash order
    /// instead; the wizard picks clothing colours at random, so only the
    /// key's validity matters here.
    fn wire_appearance(&self, build: &CharacterGenBuild) -> CharacterCreateAppearanceData {
        let mut appearance = build.appearance.clone();
        let keys = self
            .catalog
            .heritage_group(build.heritage)
            .and_then(|heritage| heritage.genders.get(&build.gender))
            .map(|gender| gender.appearance.clothing_color_ids.as_slice())
            .unwrap_or_default();
        let key = |index: u32| keys.get(index as usize).copied().unwrap_or(0);
        appearance.headgear_color = if appearance.headgear_style == u32::MAX {
            0
        } else {
            key(appearance.headgear_color)
        };
        appearance.shirt_color = key(appearance.shirt_color);
        appearance.pants_color = key(appearance.pants_color);
        appearance.footwear_color = key(appearance.footwear_color);
        appearance
    }

    pub fn randomize_appearance(
        &self,
        heritage_id: u32,
        gender_id: u32,
    ) -> CharacterCreateAppearanceData {
        let Some(appearance) = self
            .catalog
            .heritage_group(heritage_id)
            .and_then(|heritage| heritage.genders.get(&gender_id))
            .map(|gender| &gender.appearance)
        else {
            return empty_appearance();
        };

        let mut rng = rand::rng();
        let headgear_style = random_optional_index(&mut rng, appearance.headgear.len());

        CharacterCreateAppearanceData {
            eyes: random_required_index(&mut rng, appearance.eye_strips.len()),
            nose: random_required_index(&mut rng, appearance.nose_strips.len()),
            mouth: random_required_index(&mut rng, appearance.mouth_strips.len()),
            hair_color: random_required_index(&mut rng, appearance.hair_color_ids.len()),
            eye_color: random_required_index(&mut rng, appearance.eye_color_ids.len()),
            hair_style: random_required_index(&mut rng, appearance.hair_styles.len()),
            headgear_style,
            headgear_color: if headgear_style == u32::MAX {
                0
            } else {
                random_required_index(&mut rng, appearance.clothing_color_ids.len())
            },
            shirt_style: random_required_index(&mut rng, appearance.shirts.len()),
            shirt_color: random_required_index(&mut rng, appearance.clothing_color_ids.len()),
            pants_style: random_required_index(&mut rng, appearance.pants.len()),
            pants_color: random_required_index(&mut rng, appearance.clothing_color_ids.len()),
            footwear_style: random_required_index(&mut rng, appearance.footwear.len()),
            footwear_color: random_required_index(&mut rng, appearance.clothing_color_ids.len()),
            skin_hue: rng.random::<f64>(),
            hair_hue: rng.random::<f64>(),
            headgear_hue: if headgear_style == u32::MAX {
                0.0
            } else {
                rng.random::<f64>()
            },
            shirt_hue: rng.random::<f64>(),
            pants_hue: rng.random::<f64>(),
            footwear_hue: rng.random::<f64>(),
        }
    }

    fn collect_errors(&self, build: &CharacterGenBuild) -> Vec<CharacterGenValidationError> {
        let mut errors = Vec::new();

        if self.policy.require_nonempty_name && build.name.trim().is_empty() {
            errors.push(CharacterGenValidationError::EmptyName);
        } else if !build.name.is_empty() {
            // `VerifyCharacterGenerationResult` (acclient.c:499125) needs
            // 1..32 characters already in FormatName form.
            let formatted = format_character_name(&build.name);
            if formatted != build.name {
                errors.push(CharacterGenValidationError::NameNotFormatted { formatted });
            }
        }

        if build.is_admin && !self.policy.allow_admin_flag {
            errors.push(CharacterGenValidationError::AdminFlagNotAllowed);
        }

        if build.is_sentinel && !self.policy.allow_sentinel_flag {
            errors.push(CharacterGenValidationError::SentinelFlagNotAllowed);
        }

        if self.policy.disabled_heritages.contains(&build.heritage) {
            errors.push(CharacterGenValidationError::DisabledHeritage {
                heritage_id: build.heritage,
            });
        }

        let Some(heritage) = self.catalog.heritage_group(build.heritage) else {
            errors.push(CharacterGenValidationError::UnknownHeritage {
                heritage_id: build.heritage,
            });
            return errors;
        };

        let Some(gender) = heritage.genders.get(&build.gender) else {
            errors.push(CharacterGenValidationError::UnknownGender {
                heritage_id: build.heritage,
                gender_id: build.gender,
            });
            return errors;
        };

        if build.template_option < 0 || build.template_option as usize >= heritage.templates.len() {
            errors.push(CharacterGenValidationError::InvalidTemplateOption {
                heritage_id: build.heritage,
                template_option: build.template_option,
            });
        }

        if self.catalog.starter_area(build.start_area).is_none() {
            errors.push(CharacterGenValidationError::InvalidStartArea {
                start_area_id: build.start_area,
            });
        } else if self.policy.enforce_heritage_start_area_membership {
            let allowed = self
                .catalog
                .allowed_start_area_ids_for_heritage(build.heritage)
                .unwrap_or_default();
            if !allowed.contains(&build.start_area) {
                errors.push(
                    CharacterGenValidationError::StartAreaNotAllowedForHeritage {
                        heritage_id: build.heritage,
                        start_area_id: build.start_area,
                    },
                );
            }
        }

        self.validate_attributes(build, heritage.attribute_credits, &mut errors);
        self.validate_skills(build, heritage, &mut errors);
        self.validate_appearance(build, gender, &mut errors);

        errors
    }

    fn validate_attributes(
        &self,
        build: &CharacterGenBuild,
        attribute_budget: u32,
        errors: &mut Vec<CharacterGenValidationError>,
    ) {
        for (field, value) in [
            ("strength", build.strength_ability),
            ("endurance", build.endurance_ability),
            ("coordination", build.coordination_ability),
            ("quickness", build.quickness_ability),
            ("focus", build.focus_ability),
            ("self", build.self_ability),
        ] {
            if !(CHARACTER_GEN_MIN_ATTRIBUTE..=CHARACTER_GEN_MAX_ATTRIBUTE).contains(&value) {
                errors.push(CharacterGenValidationError::AttributeOutOfRange {
                    field,
                    value,
                    min: CHARACTER_GEN_MIN_ATTRIBUTE,
                    max: CHARACTER_GEN_MAX_ATTRIBUTE,
                });
            }
        }

        // Unspent credits are allowed: retail `gmCharGenMainUI::DoFinish`
        // (acclient.c:278604) only warns (ID_CharGen_CreditWarning) and
        // sends on Yes, and `VerifyCharacterGenerationResult` checks only
        // `total <= numAttributeCredits` (:499060), as ACE does.
        let total = build.attribute_total();
        if total > attribute_budget {
            errors.push(CharacterGenValidationError::AttributeBudgetExceeded {
                total,
                budget: attribute_budget,
            });
        }
    }

    fn validate_skills(
        &self,
        build: &CharacterGenBuild,
        heritage: &holtburger_content::character_gen::CharacterGenHeritageGroup,
        errors: &mut Vec<CharacterGenValidationError>,
    ) {
        if build.skill_advancement_classes.len() != self.catalog.expected_skill_slots {
            errors.push(CharacterGenValidationError::SkillSlotCountMismatch {
                expected: self.catalog.expected_skill_slots,
                actual: build.skill_advancement_classes.len(),
            });
            return;
        }

        // Retail `VerifyCharacterGenerationResult` (acclient.c:499087)
        // requires exactly one non-Inactive class per SkillTable entry, and
        // the skills page never lets a free skill drop below its floor
        // (`gmCGSkillsPage::DecreaseSkillLevel`); see `reset_skill_levels`.
        let mut spent_credits = 0i64;

        for (skill_id, advancement) in build.skill_advancement_classes.iter().enumerate() {
            let skill_id = skill_id as u32;
            let definition = self.catalog.skill_definition(skill_id);
            let Some(skill_definition) = definition.filter(|d| is_creation_table_skill(d)) else {
                if *advancement != SkillAdvancementClass::Inactive {
                    errors.push(if definition.is_some() {
                        CharacterGenValidationError::SkillNotInSkillTable { skill_id }
                    } else {
                        CharacterGenValidationError::UnknownSkill { skill_id }
                    });
                }
                continue;
            };

            if *advancement == SkillAdvancementClass::Inactive {
                errors.push(CharacterGenValidationError::SkillInactive { skill_id });
                continue;
            }

            if !skill_definition.chargen_use && *advancement != SkillAdvancementClass::Untrained {
                errors.push(
                    CharacterGenValidationError::SkillUnavailableAtCharacterCreation { skill_id },
                );
                continue;
            }

            let Some(costs) = self
                .catalog
                .skill_costs_for_heritage(build.heritage, skill_id)
            else {
                errors.push(CharacterGenValidationError::UnknownSkill { skill_id });
                continue;
            };

            let floor = skill_advancement_floor(costs);
            if advancement_rank(*advancement) < advancement_rank(floor) {
                errors.push(CharacterGenValidationError::SkillBelowFloor {
                    skill_id,
                    floor,
                });
            }

            spent_credits += skill_advancement_cost(costs, *advancement);
        }

        if spent_credits > i64::from(heritage.skill_credits) {
            errors.push(CharacterGenValidationError::SkillBudgetExceeded {
                spent: spent_credits,
                budget: i64::from(heritage.skill_credits),
            });
        }
    }

    fn validate_appearance(
        &self,
        build: &CharacterGenBuild,
        gender: &holtburger_content::character_gen::CharacterGenGenderDefinition,
        errors: &mut Vec<CharacterGenValidationError>,
    ) {
        let appearance = &gender.appearance;

        validate_required_index(
            "eyes",
            build.appearance.eyes,
            appearance.eye_strips.len(),
            errors,
        );
        validate_required_index(
            "nose",
            build.appearance.nose,
            appearance.nose_strips.len(),
            errors,
        );
        validate_required_index(
            "mouth",
            build.appearance.mouth,
            appearance.mouth_strips.len(),
            errors,
        );
        validate_required_index(
            "hair_color",
            build.appearance.hair_color,
            appearance.hair_color_ids.len(),
            errors,
        );
        validate_required_index(
            "eye_color",
            build.appearance.eye_color,
            appearance.eye_color_ids.len(),
            errors,
        );
        validate_required_index(
            "hair_style",
            build.appearance.hair_style,
            appearance.hair_styles.len(),
            errors,
        );
        validate_optional_index(
            "headgear_style",
            build.appearance.headgear_style,
            appearance.headgear.len(),
            u32::MAX,
            errors,
        );
        validate_required_index(
            "shirt_style",
            build.appearance.shirt_style,
            appearance.shirts.len(),
            errors,
        );
        validate_required_index(
            "pants_style",
            build.appearance.pants_style,
            appearance.pants.len(),
            errors,
        );
        validate_required_index(
            "footwear_style",
            build.appearance.footwear_style,
            appearance.footwear.len(),
            errors,
        );

        if build.appearance.headgear_style != u32::MAX {
            validate_required_index(
                "headgear_color",
                build.appearance.headgear_color,
                appearance.clothing_color_ids.len(),
                errors,
            );
        }

        validate_required_index(
            "shirt_color",
            build.appearance.shirt_color,
            appearance.clothing_color_ids.len(),
            errors,
        );
        validate_required_index(
            "pants_color",
            build.appearance.pants_color,
            appearance.clothing_color_ids.len(),
            errors,
        );
        validate_required_index(
            "footwear_color",
            build.appearance.footwear_color,
            appearance.clothing_color_ids.len(),
            errors,
        );
    }
}

fn validate_required_index(
    field: &'static str,
    value: u32,
    options_len: usize,
    errors: &mut Vec<CharacterGenValidationError>,
) {
    if options_len == 0 {
        if value != 0 {
            errors.push(CharacterGenValidationError::AppearanceChoiceOutOfRange {
                field,
                selected: value,
                options_len,
            });
        }
        return;
    }

    if value as usize >= options_len {
        errors.push(CharacterGenValidationError::AppearanceChoiceOutOfRange {
            field,
            selected: value,
            options_len,
        });
    }
}

fn validate_optional_index(
    field: &'static str,
    value: u32,
    options_len: usize,
    none_sentinel: u32,
    errors: &mut Vec<CharacterGenValidationError>,
) {
    if value == none_sentinel {
        return;
    }

    validate_required_index(field, value, options_len, errors);
}

fn empty_appearance() -> CharacterCreateAppearanceData {
    CharacterCreateAppearanceData {
        eyes: 0,
        nose: 0,
        mouth: 0,
        hair_color: 0,
        eye_color: 0,
        hair_style: 0,
        headgear_style: u32::MAX,
        headgear_color: 0,
        shirt_style: 0,
        shirt_color: 0,
        pants_style: 0,
        pants_color: 0,
        footwear_style: 0,
        footwear_color: 0,
        skin_hue: 0.0,
        hair_hue: 0.0,
        headgear_hue: 0.0,
        shirt_hue: 0.0,
        pants_hue: 0.0,
        footwear_hue: 0.0,
    }
}

fn random_required_index(rng: &mut impl RngExt, options_len: usize) -> u32 {
    if options_len == 0 {
        0
    } else {
        rng.random_range(0..options_len) as u32
    }
}

fn random_optional_index(rng: &mut impl RngExt, options_len: usize) -> u32 {
    if options_len == 0 {
        u32::MAX
    } else {
        random_required_index(rng, options_len)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum CharacterGenValidationError {
    #[error("character name cannot be empty")]
    EmptyName,
    #[error("heritage {heritage_id} is disabled by local policy")]
    DisabledHeritage { heritage_id: u32 },
    #[error("unknown heritage {heritage_id}")]
    UnknownHeritage { heritage_id: u32 },
    #[error("unknown gender {gender_id} for heritage {heritage_id}")]
    UnknownGender { heritage_id: u32, gender_id: u32 },
    #[error("invalid template option {template_option} for heritage {heritage_id}")]
    InvalidTemplateOption {
        heritage_id: u32,
        template_option: i32,
    },
    #[error("invalid start area {start_area_id}")]
    InvalidStartArea { start_area_id: u32 },
    #[error("start area {start_area_id} is not allowed for heritage {heritage_id}")]
    StartAreaNotAllowedForHeritage {
        heritage_id: u32,
        start_area_id: u32,
    },
    #[error("attribute {field} value {value} must be between {min} and {max}")]
    AttributeOutOfRange {
        field: &'static str,
        value: u32,
        min: u32,
        max: u32,
    },
    #[error("attribute total {total} exceeds budget {budget}")]
    AttributeBudgetExceeded { total: u32, budget: u32 },
    #[error("character name is not in retail form (expected {formatted:?})")]
    NameNotFormatted { formatted: String },
    #[error("expected {expected} skill slots but got {actual}")]
    SkillSlotCountMismatch { expected: usize, actual: usize },
    #[error("unknown skill {skill_id}")]
    UnknownSkill { skill_id: u32 },
    #[error("skill {skill_id} is not in the skill table and must stay inactive")]
    SkillNotInSkillTable { skill_id: u32 },
    #[error("skill {skill_id} must be untrained, trained or specialized")]
    SkillInactive { skill_id: u32 },
    #[error("skill {skill_id} cannot go below {floor:?} (it is free at that tier)")]
    SkillBelowFloor {
        skill_id: u32,
        floor: SkillAdvancementClass,
    },
    #[error("skill {skill_id} is not available at character creation")]
    SkillUnavailableAtCharacterCreation { skill_id: u32 },
    #[error("skill credits spent {spent} exceed budget {budget}")]
    SkillBudgetExceeded { spent: i64, budget: i64 },
    #[error("appearance choice {field}={selected} is out of range for {options_len} options")]
    AppearanceChoiceOutOfRange {
        field: &'static str,
        selected: u32,
        options_len: usize,
    },
    #[error("admin flag is not allowed by local policy")]
    AdminFlagNotAllowed,
    #[error("sentinel flag is not allowed by local policy")]
    SentinelFlagNotAllowed,
}

#[cfg(test)]
mod tests {
    use super::*;
    use holtburger_content::character_gen::{
        CharacterGenAppearanceOptions, CharacterGenCatalog, CharacterGenGenderDefinition,
        CharacterGenHeritageGroup, CharacterGenSkillDefinition, CharacterGenStarterArea,
        CharacterGenStarterLocation, CharacterGenTemplate,
    };
    use std::collections::BTreeMap;

    fn test_catalog() -> Arc<CharacterGenCatalog> {
        Arc::new(CharacterGenCatalog {
            starter_areas: vec![CharacterGenStarterArea {
                start_area_id: 0,
                name: "Holtburg".to_string(),
                locations: vec![CharacterGenStarterLocation {
                    obj_cell_id: 1,
                    frame: Default::default(),
                }],
            }],
            heritage_groups: BTreeMap::from([(
                6,
                CharacterGenHeritageGroup {
                    heritage_id: 6,
                    name: "Sho".to_string(),
                    icon_image: 0,
                    setup_id: 0,
                    environment_setup_id: 0,
                    attribute_credits: 330,
                    skill_credits: 10,
                    primary_start_area_ids: vec![0],
                    secondary_start_area_ids: vec![],
                    skill_overrides: BTreeMap::from([(
                        1,
                        holtburger_content::character_gen::CharacterGenSkillOverride {
                            skill_id: 1,
                            skill_type: None,
                            trained_cost: 4,
                            specialized_cost: 6,
                        },
                    )]),
                    templates: vec![
                        CharacterGenTemplate {
                            template_option: 0,
                            name: "Adventurer".to_string(),
                            icon_image: 0,
                            title_id: 1,
                            strength: 100,
                            endurance: 10,
                            coordination: 100,
                            quickness: 100,
                            focus: 10,
                            self_stat: 10,
                            normal_skills: vec![],
                            primary_skills: vec![],
                        },
                        CharacterGenTemplate {
                            template_option: 1,
                            name: "Custom".to_string(),
                            icon_image: 0,
                            title_id: 2,
                            strength: 10,
                            endurance: 10,
                            coordination: 10,
                            quickness: 10,
                            focus: 10,
                            self_stat: 10,
                            normal_skills: vec![1],
                            primary_skills: vec![3],
                        },
                    ],
                    genders: BTreeMap::from([(
                        1,
                        CharacterGenGenderDefinition {
                            gender_id: 1,
                            name: "Male".to_string(),
                            scale: 100,
                            setup_id: 0,
                            sound_table: 0,
                            icon_image: 0,
                            base_palette: 0,
                            skin_palette_set: 0,
                            physics_table: 0,
                            motion_table: 0,
                            combat_table: 0,
                            appearance: CharacterGenAppearanceOptions {
                                hair_color_ids: vec![1],
                                hair_styles: vec![],
                                eye_color_ids: vec![1],
                                eye_strips: vec![
                                    holtburger_content::character_gen::CharacterGenEyeStrip {
                                        icon_image: 1,
                                        icon_image_bald: 1,
                                    },
                                ],
                                nose_strips: vec![
                                    holtburger_content::character_gen::CharacterGenFaceStrip {
                                        icon_image: 1,
                                    },
                                ],
                                mouth_strips: vec![
                                    holtburger_content::character_gen::CharacterGenFaceStrip {
                                        icon_image: 1,
                                    },
                                ],
                                headgear: vec![],
                                shirts: vec![holtburger_content::character_gen::CharacterGenGear {
                                    name: "Shirt".to_string(),
                                    clothing_table: 1,
                                    weenie_default: 1,
                                }],
                                pants: vec![holtburger_content::character_gen::CharacterGenGear {
                                    name: "Pants".to_string(),
                                    clothing_table: 1,
                                    weenie_default: 1,
                                }],
                                footwear: vec![
                                    holtburger_content::character_gen::CharacterGenGear {
                                        name: "Boots".to_string(),
                                        clothing_table: 1,
                                        weenie_default: 1,
                                    },
                                ],
                                clothing_color_ids: vec![1],
                            },
                        },
                    )]),
                },
            )]),
            skill_definitions: BTreeMap::from([
                (
                    0,
                    CharacterGenSkillDefinition {
                        skill_id: 0,
                        skill_type: None,
                        name: "Inactive".to_string(),
                        description: "Inactive".to_string(),
                        chargen_use: true,
                        trained_cost: 0,
                        specialized_cost: 0,
                        retired: false,
                    },
                ),
                (
                    1,
                    CharacterGenSkillDefinition {
                        skill_id: 1,
                        skill_type: None,
                        name: "Axe".to_string(),
                        description: "Axe".to_string(),
                        chargen_use: true,
                        trained_cost: 6,
                        specialized_cost: 10,
                        retired: false,
                    },
                ),
                (
                    2,
                    CharacterGenSkillDefinition {
                        skill_id: 2,
                        skill_type: None,
                        name: "Bow".to_string(),
                        description: "Bow".to_string(),
                        chargen_use: true,
                        trained_cost: 0,
                        specialized_cost: 4,
                        retired: false,
                    },
                ),
                (
                    3,
                    CharacterGenSkillDefinition {
                        skill_id: 3,
                        skill_type: None,
                        name: "Crossbow".to_string(),
                        description: "Crossbow".to_string(),
                        chargen_use: true,
                        trained_cost: 6,
                        specialized_cost: 8,
                        retired: false,
                    },
                ),
                (
                    4,
                    CharacterGenSkillDefinition {
                        skill_id: 4,
                        skill_type: None,
                        name: "Hidden".to_string(),
                        description: "Hidden".to_string(),
                        chargen_use: false,
                        trained_cost: 6,
                        specialized_cost: 12,
                        retired: false,
                    },
                ),
                (
                    5,
                    CharacterGenSkillDefinition {
                        skill_id: 5,
                        skill_type: None,
                        name: "Mace".to_string(),
                        description: "Retired skill: Mace".to_string(),
                        chargen_use: true,
                        trained_cost: 0,
                        specialized_cost: 0,
                        retired: true,
                    },
                ),
            ]),
            expected_skill_slots: 6,
        })
    }

    fn test_build() -> CharacterGenBuild {
        CharacterGenBuild {
            heritage: 6,
            gender: 1,
            appearance: CharacterCreateAppearanceData {
                eyes: 0,
                nose: 0,
                mouth: 0,
                hair_color: 0,
                eye_color: 0,
                hair_style: 0,
                headgear_style: u32::MAX,
                headgear_color: 0,
                shirt_style: 0,
                shirt_color: 0,
                pants_style: 0,
                pants_color: 0,
                footwear_style: 0,
                footwear_color: 0,
                skin_hue: 1.0,
                hair_hue: 1.0,
                headgear_hue: 0.0,
                shirt_hue: 0.0,
                pants_hue: 0.0,
                footwear_hue: 0.0,
            },
            template_option: 0,
            strength_ability: 100,
            endurance_ability: 10,
            coordination_ability: 100,
            quickness_ability: 100,
            focus_ability: 10,
            self_ability: 10,
            character_slot: 0,
            // Slot 0 and the retired Mace stay Inactive; Bow is free to
            // train, so Trained is its floor.
            skill_advancement_classes: vec![
                SkillAdvancementClass::Inactive,
                SkillAdvancementClass::Specialized,
                SkillAdvancementClass::Trained,
                SkillAdvancementClass::Untrained,
                SkillAdvancementClass::Untrained,
                SkillAdvancementClass::Inactive,
            ],
            name: "Bestie".to_string(),
            start_area: 0,
            is_admin: false,
            is_sentinel: false,
        }
    }

    #[test]
    fn build_request_uses_policy_defaults() {
        let builder = CharacterGenBuilder::new(test_catalog());
        let request = builder
            .build_request(test_build())
            .expect("build should validate");

        assert_eq!(request.unknown_constant, CHARACTER_GEN_UNKNOWN_CONSTANT);
        assert_eq!(request.class_id, CHARACTER_GEN_DEFAULT_CLASS_ID);
        assert_eq!(request.name, "Bestie");
    }

    #[test]
    fn randomize_appearance_uses_valid_catalog_ranges() {
        let builder = CharacterGenBuilder::new(test_catalog());

        let appearance = builder.randomize_appearance(6, 1);

        assert_eq!(appearance.eyes, 0);
        assert_eq!(appearance.nose, 0);
        assert_eq!(appearance.mouth, 0);
        assert_eq!(appearance.hair_color, 0);
        assert_eq!(appearance.eye_color, 0);
        assert_eq!(appearance.hair_style, 0);
        assert_eq!(appearance.headgear_style, u32::MAX);
        assert_eq!(appearance.headgear_color, 0);
        assert_eq!(appearance.shirt_style, 0);
        assert_eq!(appearance.shirt_color, 0);
        assert_eq!(appearance.pants_style, 0);
        assert_eq!(appearance.pants_color, 0);
        assert_eq!(appearance.footwear_style, 0);
        assert_eq!(appearance.footwear_color, 0);
        assert!((0.0..1.0).contains(&appearance.skin_hue));
        assert!((0.0..1.0).contains(&appearance.hair_hue));
        assert_eq!(appearance.headgear_hue, 0.0);
        assert!((0.0..1.0).contains(&appearance.shirt_hue));
        assert!((0.0..1.0).contains(&appearance.pants_hue));
        assert!((0.0..1.0).contains(&appearance.footwear_hue));
    }

    #[test]
    fn validate_rejects_attribute_budget_overrun() {
        let builder = CharacterGenBuilder::new(test_catalog());
        let mut build = test_build();
        build.focus_ability = 50;

        let errors = builder.validate(&build).expect_err("build should fail");
        assert!(errors.iter().any(|error| matches!(
            error,
            CharacterGenValidationError::AttributeBudgetExceeded { .. }
        )));
    }

    #[test]
    fn validate_allows_unspent_attribute_budget() {
        // Retail DoFinish only warns about unspent credits; the server
        // checks total <= budget.
        let builder = CharacterGenBuilder::new(test_catalog());
        let mut build = test_build();
        build.strength_ability = 95;
        assert_eq!(build.attribute_total(), 325);

        builder.validate(&build).expect("325 of 330 is a legal build");
    }

    #[test]
    fn validate_rejects_skill_budget_overrun() {
        let builder = CharacterGenBuilder::new(test_catalog());
        let mut build = test_build();
        build.skill_advancement_classes[3] = SkillAdvancementClass::Specialized;

        let errors = builder.validate(&build).expect_err("build should fail");
        assert!(errors.iter().any(|error| matches!(
            error,
            CharacterGenValidationError::SkillBudgetExceeded { .. }
        )));
    }

    #[test]
    fn validate_rejects_non_chargen_skill() {
        let builder = CharacterGenBuilder::new(test_catalog());
        let mut build = test_build();
        build.skill_advancement_classes[4] = SkillAdvancementClass::Trained;

        let errors = builder.validate(&build).expect_err("build should fail");
        assert!(errors.iter().any(|error| matches!(
            error,
            CharacterGenValidationError::SkillUnavailableAtCharacterCreation { skill_id: 4 }
        )));
    }

    #[test]
    fn custom_template_for_heritage_prefers_named_custom_template() {
        let catalog = test_catalog();
        let heritage = catalog
            .heritage_group(6)
            .expect("test heritage should exist");

        let template = custom_template_for_heritage(heritage).expect("custom template expected");

        assert_eq!(template.name, "Custom");
        assert_eq!(template.template_option, 1);
    }

    #[test]
    fn minimum_skill_advancement_is_the_retail_cost_floor() {
        // ResetSkillLevels / bUntrainable: costs decide, template lists do
        // not. Axe has the heritage override (4, 6).
        let catalog = test_catalog();
        let floor = |skill| minimum_skill_advancement_for_heritage(catalog.as_ref(), 6, skill);
        assert_eq!(floor(0), SkillAdvancementClass::Inactive, "slot 0 is not a table skill");
        assert_eq!(floor(1), SkillAdvancementClass::Untrained);
        assert_eq!(floor(2), SkillAdvancementClass::Trained, "free to train");
        assert_eq!(floor(3), SkillAdvancementClass::Untrained, "a template primary is no floor");
        assert_eq!(floor(5), SkillAdvancementClass::Inactive, "a retired placeholder");
        assert_eq!(floor(9), SkillAdvancementClass::Inactive, "unknown");
    }

    #[test]
    fn skill_advancement_floor_follows_reset_skill_levels() {
        let costs = |trained_cost, specialized_cost| CharacterGenSkillCosts {
            trained_cost,
            specialized_cost,
        };
        assert_eq!(skill_advancement_floor(costs(6, 10)), SkillAdvancementClass::Untrained);
        assert_eq!(skill_advancement_floor(costs(0, 4)), SkillAdvancementClass::Trained);
        assert_eq!(skill_advancement_floor(costs(0, 0)), SkillAdvancementClass::Specialized);
        assert_eq!(skill_advancement_floor(costs(0, 999)), SkillAdvancementClass::Trained);
        assert_eq!(skill_advancement_floor(costs(-1, 4)), SkillAdvancementClass::Inactive);
    }

    #[test]
    fn reset_and_template_follow_retail_apply_template() {
        let catalog = test_catalog();
        use SkillAdvancementClass::{Inactive, Specialized, Trained, Untrained};
        assert_eq!(
            reset_skill_levels(catalog.as_ref(), 6),
            vec![Inactive, Untrained, Trained, Untrained, Untrained, Inactive]
        );
        let custom = &catalog.heritage_group(6).unwrap().templates[1];
        // Axe trains for 4 of 10 credits; Crossbow's specialisation (8)
        // no longer fits, so ApplyTemplate leaves it Untrained.
        assert_eq!(
            template_skill_levels(catalog.as_ref(), 6, custom),
            vec![Inactive, Trained, Trained, Untrained, Untrained, Inactive]
        );
        let mut roomy = (*catalog).clone();
        roomy.heritage_groups.get_mut(&6).unwrap().skill_credits = 12;
        assert_eq!(
            template_skill_levels(&roomy, 6, custom),
            vec![Inactive, Trained, Trained, Specialized, Untrained, Inactive]
        );
    }

    fn catalog_with_skill_credits(credits: u32) -> Arc<CharacterGenCatalog> {
        let mut catalog = (*test_catalog()).clone();
        catalog.heritage_groups.get_mut(&6).unwrap().skill_credits = credits;
        Arc::new(catalog)
    }

    #[test]
    fn validate_charges_a_specialised_skill_its_total_cost_only() {
        // Axe Trained (4) + Crossbow Specialized (8) = 12. The old
        // trained + specialized rule charged Crossbow 14.
        let mut build = test_build();
        build.skill_advancement_classes[1] = SkillAdvancementClass::Trained;
        build.skill_advancement_classes[3] = SkillAdvancementClass::Specialized;

        CharacterGenBuilder::new(catalog_with_skill_credits(12))
            .validate(&build)
            .expect("12 credits exactly");
        let errors = CharacterGenBuilder::new(catalog_with_skill_credits(11))
            .validate(&build)
            .expect_err("one credit short");
        assert!(errors.contains(&CharacterGenValidationError::SkillBudgetExceeded {
            spent: 12,
            budget: 11,
        }));
    }

    #[test]
    fn validate_requires_every_table_skill_and_only_those() {
        let builder = CharacterGenBuilder::new(test_catalog());
        let check = |slot: usize, class, expected: CharacterGenValidationError| {
            let mut build = test_build();
            build.skill_advancement_classes[slot] = class;
            let errors = builder.validate(&build).expect_err("build should fail");
            assert!(errors.contains(&expected), "{errors:?}");
        };
        check(
            3,
            SkillAdvancementClass::Inactive,
            CharacterGenValidationError::SkillInactive { skill_id: 3 },
        );
        check(
            2,
            SkillAdvancementClass::Untrained,
            CharacterGenValidationError::SkillBelowFloor {
                skill_id: 2,
                floor: SkillAdvancementClass::Trained,
            },
        );
        check(
            5,
            SkillAdvancementClass::Trained,
            CharacterGenValidationError::SkillNotInSkillTable { skill_id: 5 },
        );
        check(
            0,
            SkillAdvancementClass::Untrained,
            CharacterGenValidationError::SkillNotInSkillTable { skill_id: 0 },
        );
    }

    #[test]
    fn build_request_sends_clothing_colours_as_palette_template_keys() {
        let mut catalog = (*test_catalog()).clone();
        catalog
            .heritage_groups
            .get_mut(&6)
            .unwrap()
            .genders
            .get_mut(&1)
            .unwrap()
            .appearance
            .clothing_color_ids = vec![9, 6, 4];
        let builder = CharacterGenBuilder::new(Arc::new(catalog));
        let mut build = test_build();
        build.appearance.shirt_color = 2;
        build.appearance.pants_color = 1;
        build.appearance.footwear_color = 0;
        build.appearance.hair_color = 0;

        let request = builder.build_request(build).expect("build should validate");
        assert_eq!(request.appearance.shirt_color, 4);
        assert_eq!(request.appearance.pants_color, 6);
        assert_eq!(request.appearance.footwear_color, 9);
        assert_eq!(request.appearance.headgear_color, 0, "no headgear");
        assert_eq!(request.appearance.hair_color, 0, "hair colour stays an index");
    }

    #[test]
    fn format_character_name_matches_retail_format_name() {
        for (raw, formatted) in [
            ("bob2", "Bob"),
            ("BOB SMITH", "Bob Smith"),
            ("bob smith", "Bob smith"),
            ("MACDONALD", "MacDonald"),
            ("mcdonald", "Mcdonald"),
            ("jean-luc", "Jean-luc"),
            ("o''neil", "O'neil"),
            ("a--b", "A-b"),
            ("Bob III", "Bob III"),
            ("bob iii", "Bob iii"),
            ("  x ", "X"),
            ("DEAN", "DeAn"),
            ("al", "Al"),
            ("Bob  Smith", "Bob Smith"),
            ("'Bob", "Bob"),
            ("-Bob-", "Bob"),
            ("a - b", "A  b"),
        ] {
            assert_eq!(format_character_name(raw), formatted, "{raw:?}");
        }
        assert_eq!(format_character_name(&"a".repeat(40)).len(), 32);
    }

    #[test]
    fn validate_rejects_a_name_not_in_retail_form() {
        let builder = CharacterGenBuilder::new(test_catalog());
        let mut build = test_build();
        build.name = "bob2".to_string();
        let errors = builder.validate(&build).expect_err("build should fail");
        assert!(errors.contains(&CharacterGenValidationError::NameNotFormatted {
            formatted: "Bob".to_string(),
        }));
        build.name = "Al".to_string();
        builder.validate(&build).expect("two letters are fine");
    }
}
