use crate::entity::Entity;
use crate::stats::{Skill, SkillType, TrainingLevel};
use holtburger_common::properties::{ItemType, MaterialType, PropertyInt, WorldObjectExt};

const MAX_SALVAGE_BAG_UNITS: u32 = 100;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SalvageSkillProfile {
    pub salvaging_skill: u32,
    pub best_tinkering_skill: u32,
    pub augmentation_bonus_salvage: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SalvageItemInput {
    pub item_type: ItemType,
    pub material_type: MaterialType,
    pub stack_size: u32,
    pub structure: u32,
    pub item_workmanship: u32,
    pub num_items_in_material: u32,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SalvagePreview {
    pub item_count: usize,
    pub bags: Vec<SalvagePreviewBag>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SalvagePreviewBag {
    pub material_type: MaterialType,
    pub units: u32,
    pub workmanship: f64,
}

#[derive(Debug, Clone)]
struct WorkingBag {
    material_type: MaterialType,
    units: u32,
    item_workmanship: u32,
    num_items_in_material: u32,
}

impl SalvageItemInput {
    pub fn from_world_object<T: WorldObjectExt>(entity: &T) -> Option<Self> {
        Some(Self {
            item_type: entity.item_type()?,
            material_type: entity.material_type()?,
            // Rust review 2026-08-03 — read the RAW i32 and narrow it the way
            // ACE does, instead of going through the shared `WorldObjectExt`
            // accessors. Those do a bare `value as u32` reinterpret
            // (holtburger-common/src/properties/world_object.rs:40,135), so a
            // server-sent `Structure = -1` arrived here as 4_294_967_295 and
            // drove `predict_salvage_preview`'s `while remaining > 0` loop for
            // ~4.29e9 iterations, each doing a linear scan of a `bags` Vec that
            // grows to ~4.29e7 entries — an O(n²) hang plus ~1 GB of allocation
            // from one wire property.
            //
            // ACE narrows `Structure` to `ushort?`
            // (ACE.Server/WorldObjects/WorldObject_Properties.cs:1427-1430), an
            // unchecked C# `(ushort)` cast — `as u16 as u32` here is the exact
            // same truncation (-1 -> 65535, 70000 -> 4464), which caps the loop
            // at 656 bags.
            stack_size: entity
                .get_int_prop(PropertyInt::StackSize)
                .unwrap_or(1)
                .max(1) as u32,
            structure: entity.get_int_prop(PropertyInt::Structure).unwrap_or(0) as u16 as u32,
            item_workmanship: entity.get_int_prop(PropertyInt::ItemWorkmanship)?.max(0) as u32,
            num_items_in_material: entity
                .get_int_prop(PropertyInt::NumItemsInMaterial)
                .unwrap_or(1)
                .max(1) as u32,
        })
    }

    pub fn from_entity(entity: &Entity) -> Option<Self> {
        Self::from_world_object(entity)
    }

    pub fn average_workmanship(&self) -> f64 {
        self.item_workmanship as f64 / self.num_items_in_material.max(1) as f64
    }
}

impl WorkingBag {
    fn new(material_type: MaterialType) -> Self {
        Self {
            material_type,
            units: 0,
            item_workmanship: 0,
            num_items_in_material: 0,
        }
    }

    fn has_space(&self) -> bool {
        self.units < MAX_SALVAGE_BAG_UNITS
    }

    fn workmanship(&self) -> f64 {
        if self.num_items_in_material == 0 {
            0.0
        } else {
            self.item_workmanship as f64 / self.num_items_in_material as f64
        }
    }

    fn to_preview(&self) -> SalvagePreviewBag {
        SalvagePreviewBag {
            material_type: self.material_type,
            units: self.units,
            workmanship: self.workmanship(),
        }
    }
}

pub fn best_trained_tinkering_skill<'a>(skills: impl IntoIterator<Item = &'a Skill>) -> u32 {
    skills
        .into_iter()
        .filter(|skill| {
            matches!(
                skill.skill_type,
                SkillType::ArmorTinkering
                    | SkillType::WeaponTinkering
                    | SkillType::ItemTinkering
                    | SkillType::MagicItemTinkering
            ) && matches!(
                skill.training,
                TrainingLevel::Trained | TrainingLevel::Specialized
            )
        })
        .map(|skill| skill.current)
        .max()
        .unwrap_or_default()
}

pub fn predict_salvage_preview(
    items: &[SalvageItemInput],
    skills: SalvageSkillProfile,
) -> SalvagePreview {
    let mut bags = Vec::new();

    for item in items {
        let mut item = item.clone();
        let mut remaining = get_structure(&item, skills);

        while remaining > 0 {
            let bag = get_or_create_bag(item.material_type, &mut bags);
            let added = try_add_salvage(bag, &mut item, remaining);
            remaining -= added;
        }
    }

    SalvagePreview {
        item_count: items.len(),
        bags: bags.into_iter().map(|bag| bag.to_preview()).collect(),
    }
}

pub fn get_material_name(material_type: MaterialType) -> String {
    material_type.to_string()
}

fn calc_num_units(skill: u32, workmanship: f64, num_augs: u32) -> u32 {
    1 + ((skill as f64 / 194.0) * workmanship * (1.0 + 0.25 * num_augs as f64)).floor() as u32
}

fn get_structure(item: &SalvageItemInput, skills: SalvageSkillProfile) -> u32 {
    if item.item_type == ItemType::TINKERING_MATERIAL {
        return item.structure;
    }

    let workmanship = item.average_workmanship();
    let salvage_amount = calc_num_units(
        skills.salvaging_skill,
        workmanship,
        skills.augmentation_bonus_salvage,
    ) * item.stack_size.max(1);
    let tinkering_amount = calc_num_units(skills.best_tinkering_skill, workmanship, 0)
        .min(workmanship.round().max(1.0) as u32)
        * item.stack_size.max(1);

    salvage_amount.max(tinkering_amount)
}

fn get_or_create_bag(material_type: MaterialType, bags: &mut Vec<WorkingBag>) -> &mut WorkingBag {
    if let Some(index) = bags
        .iter()
        .position(|bag| bag.material_type == material_type && bag.has_space())
    {
        return &mut bags[index];
    }

    bags.push(WorkingBag::new(material_type));
    bags.last_mut().expect("bag was just pushed")
}

fn try_add_salvage(bag: &mut WorkingBag, item: &mut SalvageItemInput, try_amount: u32) -> u32 {
    let space = MAX_SALVAGE_BAG_UNITS.saturating_sub(bag.units);
    let amount = try_amount.min(space);

    bag.units += amount;

    let mut item_num_items = item.stack_size.max(1);
    let item_workmanship = item.item_workmanship;
    bag.item_workmanship += item_workmanship.saturating_mul(item_num_items);

    if item.item_type == ItemType::TINKERING_MATERIAL {
        item_num_items = item.num_items_in_material.max(1);

        // NOTE (2026-08-03): ACE's guard is `if (tryAmount > space)` alone
        // (Player_Crafting.cs:259). The extra `space > 0` here is dead —
        // `get_or_create_bag` only ever returns a bag with `units < 100`, so
        // `space >= 1` always. Left in place because removing it changes
        // nothing; recorded so nobody reads it as a real branch.
        if try_amount > space && space > 0 {
            let mut scalar = space as f64 / try_amount as f64;
            let mut new_items = (item_num_items as f64 * scalar).ceil() as u32;
            scalar = new_items as f64 / item_num_items as f64;
            let prev_num_items = item_num_items;
            item_num_items = new_items;

            bag.item_workmanship = bag
                .item_workmanship
                .saturating_sub(((item_workmanship as f64) * (1.0 - scalar)).round() as u32);

            if prev_num_items == new_items && new_items > 0 {
                new_items -= 1;
            }

            let item_avg_workmanship = item.average_workmanship();
            item.num_items_in_material = item.num_items_in_material.saturating_sub(new_items);
            item.item_workmanship =
                (item.num_items_in_material as f64 * item_avg_workmanship).round() as u32;
        }
    }

    bag.num_items_in_material += item_num_items;

    // Rust review 2026-08-03 — the overage rule. ACE
    // `Player_Crafting.cs:283-291`:
    //
    //     if (item.ItemType == ItemType.TinkeringMaterial) {
    //         if (!PropertyManager.GetBool("salvage_handle_overages").Item)
    //             return tryAmount;      // overage LOST
    //         else
    //             return amount;
    //     } else
    //         return amount;
    //
    // and the property defaults to FALSE (PropertyManager.cs:589, described as
    // "in retail, if 2 salvage bags were combined beyond 100 structure, the
    // overages would be lost"). So on a stock ACE server — and on retail —
    // combining tinkering-material bags past 100 structure consumes the whole
    // request and produces NO overflow bag. This port unconditionally returned
    // `amount`, i.e. it implemented the non-default `true` branch, so the
    // client preview promised a bag the server never creates.
    if item.item_type == ItemType::TINKERING_MATERIAL {
        try_amount
    } else {
        amount
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn skill_profile(salvaging_skill: u32, best_tinkering_skill: u32) -> SalvageSkillProfile {
        SalvageSkillProfile {
            salvaging_skill,
            best_tinkering_skill,
            augmentation_bonus_salvage: 0,
        }
    }

    #[test]
    fn best_trained_tinkering_skill_ignores_untrained_entries() {
        let skills = [
            Skill {
                skill_type: SkillType::ItemTinkering,
                ranks: 0,
                init: 0,
                spent_xp: 0,
                next_rank_xp: None,
                base: 300,
                current: 300,
                training: TrainingLevel::Untrained,
                trained_cost: 0,
                specialized_cost: 0,
            },
            Skill {
                skill_type: SkillType::WeaponTinkering,
                ranks: 0,
                init: 0,
                spent_xp: 0,
                next_rank_xp: None,
                base: 250,
                current: 250,
                training: TrainingLevel::Trained,
                trained_cost: 0,
                specialized_cost: 0,
            },
        ];

        assert_eq!(best_trained_tinkering_skill(skills.iter()), 250);
    }

    #[test]
    fn preview_splits_large_salvage_output_into_multiple_bags() {
        let items = vec![SalvageItemInput {
            item_type: ItemType::MISSILE_WEAPON,
            material_type: MaterialType::Steel,
            stack_size: 6,
            structure: 0,
            item_workmanship: 10,
            num_items_in_material: 1,
        }];

        let preview = predict_salvage_preview(&items, skill_profile(387, 50));

        assert_eq!(preview.item_count, 1);
        assert_eq!(preview.bags.len(), 2);
        assert_eq!(preview.bags[0].material_type, MaterialType::Steel);
        assert_eq!(preview.bags[0].units, 100);
        assert!((preview.bags[0].workmanship - 10.0).abs() < f64::EPSILON);
        assert_eq!(preview.bags[1].units, 20);
        assert!((preview.bags[1].workmanship - 10.0).abs() < f64::EPSILON);
    }

    #[test]
    fn preview_matches_ace_overage_behavior_when_combining_salvage_bags() {
        let items = vec![
            SalvageItemInput {
                item_type: ItemType::MISSILE_WEAPON,
                material_type: MaterialType::Steel,
                stack_size: 3,
                structure: 0,
                item_workmanship: 10,
                num_items_in_material: 1,
            },
            SalvageItemInput {
                item_type: ItemType::TINKERING_MATERIAL,
                material_type: MaterialType::Steel,
                stack_size: 1,
                structure: 80,
                item_workmanship: 40,
                num_items_in_material: 8,
            },
        ];

        let preview = predict_salvage_preview(&items, skill_profile(387, 0));

        // The first (non-tinkering) item yields 60 units. The tinkering
        // material then asks for 80 into a bag with 40 free.
        //
        // ACE `Player_Crafting.cs:283-291` with the DEFAULT
        // `salvage_handle_overages = false` (PropertyManager.cs:589 — "in
        // retail … the overages would be lost") returns `tryAmount` for a
        // TinkeringMaterial, so `remaining` goes straight to 0 and there is NO
        // second bag. This port used to return `amount` (the non-default
        // `true` branch) and promised a 40-unit bag the server never creates.
        assert_eq!(preview.item_count, 2);
        assert_eq!(
            preview.bags.len(),
            1,
            "ACE default salvage_handle_overages=false LOSES the overage — no \
             second bag (got {:?})",
            preview.bags
        );
        assert_eq!(preview.bags[0].units, 100);
        assert!((preview.bags[0].workmanship - (50.0 / 7.0)).abs() < 0.001);
    }

    /// NEGATIVE CONTROL for the overage rule: a NON-tinkering item must still
    /// split across bags. ACE returns `amount` (the capped value) on that
    /// branch (`Player_Crafting.cs:290-291`), so "always return try_amount"
    /// would be just as wrong as "always return amount".
    #[test]
    fn non_tinkering_overflow_still_splits_across_bags() {
        let items = vec![SalvageItemInput {
            item_type: ItemType::MISSILE_WEAPON,
            material_type: MaterialType::Steel,
            stack_size: 6,
            structure: 0,
            item_workmanship: 10,
            num_items_in_material: 1,
        }];

        let preview = predict_salvage_preview(&items, skill_profile(387, 50));
        assert_eq!(preview.bags.len(), 2);
        assert_eq!(preview.bags[0].units, 100);
        assert_eq!(preview.bags[1].units, 20);
    }

    /// Rust review 2026-08-03 — a server-sent negative `Structure` used to
    /// reinterpret as ~4.29e9 (`value as u32` in
    /// holtburger-common/src/properties/world_object.rs:135) and drive the
    /// `while remaining > 0` loop for billions of iterations against a `bags`
    /// Vec it linear-scans every pass. `SalvageItemInput::from_world_object`
    /// now narrows the raw i32 the way ACE's `ushort? Structure`
    /// (WorldObject_Properties.cs:1427-1430) does.
    ///
    /// This test asserts on `from_world_object`'s output rather than calling
    /// `predict_salvage_preview` with the unbounded value: the un-narrowed run
    /// does not fail, it HANGS, which is not something a test suite can
    /// observe safely.
    #[test]
    fn negative_wire_structure_narrows_like_ace_ushort() {
        use holtburger_common::properties::{
            WorldObjectProperties, WorldObjectPropertyAccessorsMut,
        };

        let mut props = WorldObjectProperties::default();
        props.set_int_prop(PropertyInt::ItemType, ItemType::TINKERING_MATERIAL.bits() as i32);
        props.set_int_prop(PropertyInt::MaterialType, MaterialType::Steel as i32);
        props.set_int_prop(PropertyInt::ItemWorkmanship, 10);
        props.set_int_prop(PropertyInt::NumItemsInMaterial, 1);
        props.set_int_prop(PropertyInt::StackSize, 1);
        props.set_int_prop(PropertyInt::Structure, -1);

        let input = SalvageItemInput::from_world_object(&props)
            .expect("a fully populated property bag should convert");
        assert_eq!(
            input.structure,
            65_535,
            "C# unchecked (ushort)(-1) == 65535; a bare `as u32` reinterpret \
             would give 4294967295 and hang predict_salvage_preview"
        );

        // A negative StackSize is likewise nonsense; it must not become ~4.29e9.
        props.set_int_prop(PropertyInt::StackSize, -1);
        let input = SalvageItemInput::from_world_object(&props)
            .expect("a fully populated property bag should convert");
        assert_eq!(input.stack_size, 1);

        // And the whole preview now terminates promptly on the worst input.
        let preview = predict_salvage_preview(
            &[SalvageItemInput {
                item_type: ItemType::TINKERING_MATERIAL,
                material_type: MaterialType::Steel,
                stack_size: 1,
                structure: 65_535,
                item_workmanship: 10,
                num_items_in_material: 1,
            }],
            skill_profile(387, 0),
        );
        assert!(preview.bags.len() <= 656, "at most ceil(65535/100) bags");
    }
}
