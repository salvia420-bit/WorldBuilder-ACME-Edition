use crate::entity::Entity;
use crate::state::WorldState;
use crate::stats::{AttributeType, SkillType, VitalType};
use crate::vendor::VendorState;
use holtburger_common::Guid;
use holtburger_common::properties::{
    EquipMask, ItemType, PropertyInt, Usable, WorldObjectExt, WorldObjectPropertyAccessors,
};
use holtburger_protocol::messages::combat::CombatMode;
use holtburger_protocol::messages::movement::InterpretedMotionCommand;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CombatTargetStatus {
    Available,
    Unavailable,
    DeathMotionObserved,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct StorageUsage {
    pub item_used: u32,
    pub item_capacity: u32,
    pub container_used: u32,
    pub container_capacity: u32,
}

impl StorageUsage {
    pub const fn total_used(self) -> u32 {
        self.item_used + self.container_used
    }

    pub const fn item_space_left(self) -> u32 {
        self.item_capacity.saturating_sub(self.item_used)
    }

    pub const fn container_space_left(self) -> u32 {
        self.container_capacity.saturating_sub(self.container_used)
    }
}

impl CombatTargetStatus {
    pub const fn is_available(self) -> bool {
        matches!(self, Self::Available)
    }
}

pub fn burden_load_modifier(burden: f32) -> f32 {
    if burden < 1.0 {
        1.0
    } else if burden < 2.0 {
        2.0 - burden
    } else {
        0.0
    }
}

// T1 (2026-06-02): this is the run-rate source the render velScale path
// consumes. `player_run_rate()` (below) calls it; the wasm
// `playerRunRate` getter caches that result and JS feeds it into
// `stateGroundSpeed`, which clamps the ground anim-speed to `run_rate *
// 4.0`. Mirrors ACE `GetRunRate`: the `/4.0` at the end is the unit
// divisor (raw run factor → rate). NOTE: the inner expression does NOT
// re-apply any extra scaling divisor — the `* 11.0 + 4.0` then single
// `/4.0` is the whole formula; any "scaling divisor omitted" worry is
// because the `4.0` cap (18/4 and the trailing `/4.0`) is the only
// divisor and it is present.
/// STAGE 2 AMENDMENT exhaustion lane, A3-D2(a) (2026-06-12,
/// `docs/2026-06-11-unified-movement-pipeline/DESIGN.md`
/// "ReportExhaustion"): feed the wire Stamina vital into the run-rate
/// resolution — at Stamina current == 0 ACE resolves run promotion at
/// the EXHAUSTED rate (server: stamina 0 → runskill treated as 0 →
/// `Creature.GetRunRate` formula → exactly 1.0; retail event chain
/// `MovementManager::ReportExhaustion` → `CMotionInterp::ReportExhaustion`
/// re-derive, `~/ac-headers/acclient.c:344318-344332`, `:339421-339434`).
/// Without it the exhausted player keeps predicting full run speed and
/// the snapback class Stage 1 fixed returns exactly at stamina 0.
/// Default-off const-gate pattern (url-flags.md §6); flipping it means
/// editing this source + wasm rebuild. Rollback: const off.
pub const USE_EXHAUSTION_RUN_RATE: bool = false;

/// The exhaustion input fold: wire Stamina current == 0 → run skill
/// treated as 0 (ACE server-side `runSkill = stamina == 0 ? 0 : ...`;
/// `run_rate_from_skill_and_burden(0, _)` = `(load_mod·0·11 + 4)/4` =
/// exactly 1.0 for every burden). `None` stamina (vital not yet
/// populated) passes the skill through untouched — absence of data is
/// never treated as exhaustion.
pub fn exhausted_run_skill(run_skill: f32, stamina_current: Option<u32>) -> f32 {
    match stamina_current {
        Some(0) => 0.0,
        _ => run_skill,
    }
}

pub fn run_rate_from_skill_and_burden(run_skill: f32, burden: f32) -> f32 {
    if run_skill >= 800.0 {
        18.0 / 4.0
    } else {
        let load_mod = burden_load_modifier(burden);
        (load_mod * (run_skill / (run_skill + 200.0) * 11.0) + 4.0) / 4.0
    }
}

/// Provenance of the `run_skill` value fed into `run_rate_from_skill_and_burden`
/// for the local player. ACE `Creature.GetRunRate` always uses
/// `GetCreatureSkill(Skill.Run).Current`; since unified-pipeline STAGE 1
/// (2026-06-11) [`WorldContextExt::player_run_rate`] matches that exactly
/// (wire Run skill or `None` — the Quickness fallback is retired), and a
/// live capture still reports WHICH source was used to diff against ACE.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum RunSkillSource {
    /// Neither the Run skill nor Quickness is loaded yet — `player_run_rate()`
    /// returns `None` and the caller applies the flat fallback cap.
    #[default]
    Unavailable,
    /// The wire-supplied Run skill `current` was used (matches ACE).
    WireRunSkill,
    /// HISTORICAL (retired by unified-pipeline STAGE 1, 2026-06-11): Run
    /// skill absent → fell back to the Quickness attribute `current`. No
    /// ACE equivalent — confirmed snapback root (DESIGN.md §2 defect 1)
    /// and removed from `player_run_rate()`; the variant is kept so old
    /// 1070 capture JSON (`"quickness_fallback"`) still diffs cleanly,
    /// but the probe can no longer produce it.
    QuicknessFallback,
}

impl RunSkillSource {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Unavailable => "unavailable",
            Self::WireRunSkill => "wire_run_skill",
            Self::QuicknessFallback => "quickness_fallback",
        }
    }
}

/// Read-only diagnostic snapshot of every input to
/// `run_rate_from_skill_and_burden` for the local player, with provenance.
/// Mirrors [`WorldContextExt::player_run_rate`] exactly — same skill fallback,
/// same `burden.unwrap_or(3.0)` — so a 1070 capture can be diffed against ACE
/// `Creature.GetRunRate` (`GetCreatureSkill(Skill.Run).Current` + burden from
/// `EncumbranceSystem.GetBurden`). Does NOT change any value; pure observation
/// of the snapback root (the run-skill INPUT, not the formula).
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct RunRateInputs {
    /// `run_rate_from_skill_and_burden(run_skill_used, burden)`, or `None` when
    /// stats aren't loaded (the caller then applies the flat fallback cap).
    pub run_rate: Option<f32>,
    /// The skill value actually fed into the formula.
    pub run_skill_used: Option<f32>,
    pub run_skill_source: RunSkillSource,
    /// The wire-supplied Run skill `current`, independent of which source won.
    pub run_skill_wire: Option<u32>,
    /// The Quickness attribute `current`, if present.
    pub quickness: Option<u32>,
    /// The burden actually fed into the formula (`encumbrance / capacity`,
    /// or `3.0` when capacity is unknown — same default as `player_run_rate`).
    pub burden: f32,
    /// `burden_load_modifier(burden)` — clamped at 1.0 (burden is a brake only).
    pub load_mod: f32,
    pub encumbrance: Option<f32>,
    pub capacity: Option<f32>,
    pub strength: Option<u32>,
    pub num_augs: i32,
}

impl RunRateInputs {
    /// Compact JSON for the wasm `playerRunRateInputs` getter / 1070 capture.
    pub fn to_json(&self) -> String {
        fn of(v: Option<f32>) -> String {
            v.map_or_else(|| "null".to_string(), |x| format!("{x}"))
        }
        fn ou(v: Option<u32>) -> String {
            v.map_or_else(|| "null".to_string(), |x| x.to_string())
        }
        format!(
            "{{\"run_rate\":{},\"run_skill_used\":{},\"run_skill_source\":\"{}\",\
             \"run_skill_wire\":{},\"quickness\":{},\"burden\":{},\"load_mod\":{},\
             \"encumbrance\":{},\"capacity\":{},\"strength\":{},\"num_augs\":{}}}",
            of(self.run_rate),
            of(self.run_skill_used),
            self.run_skill_source.as_str(),
            ou(self.run_skill_wire),
            ou(self.quickness),
            self.burden,
            self.load_mod,
            of(self.encumbrance),
            of(self.capacity),
            ou(self.strength),
            self.num_augs,
        )
    }
}

pub fn normalize_name_for_lookup(name: &str) -> String {
    name.chars()
        .filter(|character| character.is_alphanumeric())
        .map(|character| character.to_ascii_lowercase())
        .collect()
}

/// Provides access to the world state for common logic.
pub trait WorldContext {
    fn get_player_guid(&self) -> Option<Guid>;
    fn get_entity(&self, guid: Guid) -> Option<&Entity>;
    fn iter_inventory(&self) -> impl Iterator<Item = Guid> + '_;
    fn iter_equipment(&self) -> impl Iterator<Item = Guid> + '_;
    fn iter_entities(&self) -> impl Iterator<Item = &Entity> + '_;
    fn is_open_container(&self, guid: Guid) -> bool;

    fn get_player_attribute_current(&self, _attr: AttributeType) -> Option<u32> {
        None
    }

    fn get_player_skill_current(&self, _skill: SkillType) -> Option<u32> {
        None
    }

    fn get_player_vital_current(&self, _vital: VitalType) -> Option<u32> {
        None
    }

    fn get_player_int_property(&self, _prop: PropertyInt) -> Option<i32> {
        None
    }
}

impl WorldContext for WorldState {
    fn get_player_guid(&self) -> Option<Guid> {
        (self.player.guid != Guid::NULL).then_some(self.player.guid)
    }

    fn get_entity(&self, guid: Guid) -> Option<&Entity> {
        self.entities.get(guid)
    }

    fn iter_inventory(&self) -> impl Iterator<Item = Guid> + '_ {
        self.player.inventory.iter().copied()
    }

    fn iter_equipment(&self) -> impl Iterator<Item = Guid> + '_ {
        self.player.equipment.keys().copied()
    }

    fn iter_entities(&self) -> impl Iterator<Item = &Entity> + '_ {
        self.entities.iter()
    }

    fn is_open_container(&self, guid: Guid) -> bool {
        self.open_containers.contains(&guid)
    }

    fn get_player_attribute_current(&self, attr: AttributeType) -> Option<u32> {
        self.player
            .attributes
            .get(&attr)
            .map(|attribute| attribute.current)
    }

    fn get_player_skill_current(&self, skill: SkillType) -> Option<u32> {
        self.player.skills.get(&skill).map(|skill| skill.current)
    }

    fn get_player_vital_current(&self, vital: VitalType) -> Option<u32> {
        self.player.vitals.get(&vital).map(|vital| vital.current)
    }

    fn get_player_int_property(&self, prop: PropertyInt) -> Option<i32> {
        self.player_int_property(prop)
    }
}

/// Common game logic shared across all clients.
pub trait WorldContextExt: WorldContext {
    fn resolve_player_guid_by_name(&self, name: &str) -> Option<Guid> {
        let normalized_name = normalize_name_for_lookup(name);
        if normalized_name.is_empty() {
            return None;
        }

        self.iter_entities()
            .find(|entity| normalize_name_for_lookup(entity.name()) == normalized_name)
            .map(|entity| entity.guid)
    }

    fn get_player_monarch_guid(&self) -> Option<Guid> {
        let player_guid = self.get_player_guid()?;
        self.get_entity(player_guid)?.monarch_id()
    }

    fn player_encumbrance(&self) -> Option<f32> {
        let player_guid = self.get_player_guid()?;

        let mut encumbrance = 0.0;
        for guid in self.iter_inventory() {
            // Skip inventory guids whose entity hasn't loaded yet rather than
            // collapsing the whole sum to `None`. A single unresolved guid
            // (common during the boot window before all ObjectCreate frames
            // drain) used to make `player_burden` fall back to 3.0 → load_mod
            // 0.0, which would transiently floor `run_rate` to 1.0 on a
            // sub-800-Run char (observed in the 2026-06-06 capture). A partial
            // sum is correct-and-recovering; None was wrong-and-slow.
            let Some(item) = self.get_entity(guid) else {
                continue;
            };

            if let Some(container_id) = item.container_id()
                && self.is_in_player_inventory(container_id)
                && container_id != player_guid
            {
                continue;
            }

            encumbrance += item.get_int_prop(PropertyInt::EncumbranceVal).unwrap_or(0) as f32;
        }

        Some(encumbrance)
    }

    fn player_capacity(&self) -> Option<f32> {
        self.get_player_guid()?;

        let strength = self.get_player_attribute_current(AttributeType::StrengthAttr)? as f32;
        if strength <= 0.0 {
            return Some(0.0);
        }

        let num_augs = self
            .get_player_int_property(PropertyInt::AugmentationIncreasedCarryingCapacity)
            .unwrap_or(0)
            .max(0) as f32;
        // ACE `EncumbranceSystem.EncumbranceCapacity` caps the augmentation
        // bonus burden at 150 before scaling by strength: `bonusBurden = 30 *
        // numAugs; if (bonusBurden > 150) bonusBurden = 150` (EncumbranceSystem.cs:5-20).
        // Without the cap our capacity over-counts for num_augs >= 6 (30*6 = 180 > 150),
        // under-counting burden for heavily-augmented over-encumbered chars.
        let bonus_burden = (num_augs * 30.0).min(150.0);
        Some((150.0 * strength) + (bonus_burden * strength))
    }

    fn player_burden(&self) -> Option<f32> {
        let encumbrance = self.player_encumbrance()?;
        let capacity = self.player_capacity()?;

        if capacity <= 0.0 {
            return Some(3.0);
        }

        Some(encumbrance / capacity)
    }

    fn player_run_rate(&self) -> Option<f32> {
        // STAGE 1 unified-movement-pipeline (2026-06-11, DESIGN.md §2
        // defect 1): the run-rate input must be the wire Run skill
        // `Current` EXACTLY as ACE composes it (`Creature.GetRunRate` →
        // `GetCreatureSkill(Skill.Run).Current`; retail's Inq-failure
        // fallback is `my_run_rate`, acclient.c:343452-343455) — the
        // former Quickness synthesis here had NO ACE equivalent, so
        // whenever it disagreed with ACE's value every grounded tick
        // diverged position by 4.0×|Δrun_rate| m/s and ACE's
        // authoritative echoes pulled us back (the 1-2 m snapback).
        // Returns None when the wire Run skill hasn't populated; callers
        // degrade to my_run_rate / the run_rate_scalar=1.0 capability
        // override (under-prediction → lag, self-correcting) — NEVER a
        // skill-synthesized rate ACE doesn't hold.
        let run_skill = self.get_player_skill_current(SkillType::Run)? as f32;
        // A3-D2(a) exhaustion lane (2026-06-12): wire Stamina 0 →
        // exhausted rate 1.0, matching ACE's stamina==0 → runskill 0
        // chain (see [`USE_EXHAUSTION_RUN_RATE`]). Default-off.
        let run_skill = if USE_EXHAUSTION_RUN_RATE {
            exhausted_run_skill(run_skill, self.get_player_vital_current(VitalType::Stamina))
        } else {
            run_skill
        };
        let burden = self.player_burden().unwrap_or(3.0);
        Some(run_rate_from_skill_and_burden(run_skill, burden))
    }

    /// Read-only provenance snapshot of every input to `player_run_rate()` —
    /// the run-skill VALUE and its source (wire Run skill vs Quickness
    /// fallback), burden, encumbrance/capacity, and the resulting `run_rate`.
    /// Built for the live snapback probe: capture on the 1070 for `+Tester`
    /// and diff against ACE `Creature.GetRunRate`. Mirrors `player_run_rate()`
    /// step-for-step (same fallback order, same `burden.unwrap_or(3.0)`) so
    /// the reported `run_rate` equals what the velScale path actually consumed.
    fn player_run_rate_inputs(&self) -> RunRateInputs {
        let run_skill_wire = self.get_player_skill_current(SkillType::Run);
        let quickness = self.get_player_attribute_current(AttributeType::QuicknessAttr);
        let strength = self.get_player_attribute_current(AttributeType::StrengthAttr);
        let num_augs = self
            .get_player_int_property(PropertyInt::AugmentationIncreasedCarryingCapacity)
            .unwrap_or(0)
            .max(0);

        // STAGE 1 (2026-06-11): mirrors the fallback-free `player_run_rate()`
        // above — wire Run skill or nothing (Quickness is still REPORTED for
        // the capture diff, but never consumed).
        let (run_skill_used, run_skill_source) = match run_skill_wire {
            Some(v) => (Some(v as f32), RunSkillSource::WireRunSkill),
            None => (None, RunSkillSource::Unavailable),
        };
        // A3-D2(a) (2026-06-12): mirror `player_run_rate()`'s gated
        // exhaustion fold exactly, so the probe's `run_rate` keeps
        // matching what the velScale path consumed.
        let run_skill_used = run_skill_used.map(|s| {
            if USE_EXHAUSTION_RUN_RATE {
                exhausted_run_skill(s, self.get_player_vital_current(VitalType::Stamina))
            } else {
                s
            }
        });

        let burden = self.player_burden().unwrap_or(3.0);
        RunRateInputs {
            run_rate: run_skill_used.map(|s| run_rate_from_skill_and_burden(s, burden)),
            run_skill_used,
            run_skill_source,
            run_skill_wire,
            quickness,
            burden,
            load_mod: burden_load_modifier(burden),
            encumbrance: self.player_encumbrance(),
            capacity: self.player_capacity(),
            strength,
            num_augs,
        }
    }

    fn combat_target_status(&self, guid: Guid) -> CombatTargetStatus {
        if Some(guid) == self.get_player_guid() {
            return CombatTargetStatus::Unavailable;
        }

        let Some(entity) = self.get_entity(guid) else {
            return CombatTargetStatus::Unavailable;
        };

        if entity.position.landblock_id == Guid::NULL || !entity.is_creature() {
            return CombatTargetStatus::Unavailable;
        }

        if entity
            .motion_command()
            .is_some_and(InterpretedMotionCommand::is_dead)
        {
            return CombatTargetStatus::DeathMotionObserved;
        }

        CombatTargetStatus::Available
    }

    fn is_in_player_inventory(&self, guid: Guid) -> bool {
        self.iter_inventory().any(|candidate| candidate == guid)
    }

    fn is_equipped_item(&self, guid: Guid) -> bool {
        self.iter_equipment().any(|candidate| candidate == guid)
    }

    fn is_owned_by_player(&self, guid: Guid) -> bool {
        self.is_equipped_item(guid) || self.is_in_player_inventory(guid)
    }

    fn current_usable_location_flags(&self, guid: Guid, source_guid: Option<Guid>) -> Usable {
        let Some(entity) = self.get_entity(guid) else {
            return Usable::empty();
        };

        let mut available = Usable::empty();
        let is_equipped = self.is_equipped_item(guid);
        let is_owned = self.is_owned_by_player(guid);

        if is_owned {
            available |= Usable::CONTAINED;
        }

        if is_equipped {
            available |= Usable::WIELDED;
        }

        if entity
            .container_id()
            .is_some_and(|container_guid| self.is_open_container(container_guid))
        {
            available |= Usable::VIEWED;
        }

        if entity.position.landblock_id != Guid::NULL {
            available |= Usable::REMOTE;
        }

        if Some(guid) == self.get_player_guid() {
            available |= Usable::SELF;
        }

        if Some(guid) == source_guid {
            available |= Usable::OBJ_SELF;
        }

        available
    }

    fn matches_current_usable_location(
        &self,
        guid: Guid,
        required: Usable,
        source_guid: Option<Guid>,
    ) -> bool {
        let required = required.location_flags();
        if required.is_empty() {
            return false;
        }

        self.current_usable_location_flags(guid, source_guid)
            .intersects(required)
    }

    fn can_use(&self, guid: Guid) -> bool {
        let Some(item) = self.get_entity(guid) else {
            return false;
        };

        let usable = item.usable_flags();
        if usable.is_empty() {
            return true;
        }

        let source_flags = usable.source_flags();
        if source_flags == Usable::NO {
            return false;
        }

        let location_flags = source_flags.location_flags();
        if location_flags.is_empty() {
            return true;
        }

        self.matches_current_usable_location(guid, source_flags, Some(guid))
    }

    fn can_begin_use_with(&self, item_guid: Guid) -> bool {
        let Some(item) = self.get_entity(item_guid) else {
            return false;
        };

        let target_locations = item.usable_flags().target_flags().location_flags();

        item.target_item_type().is_some() && !target_locations.is_empty() && self.can_use(item_guid)
    }

    fn get_pyreal_balance(&self) -> u32 {
        self.iter_inventory()
            .filter_map(|guid| self.get_entity(guid))
            .filter(|entity| {
                entity
                    .item_type()
                    .is_some_and(|it: ItemType| it.intersects(ItemType::MONEY))
            })
            .map(|entity| entity.stack_size())
            .sum()
    }

    fn get_container_counts(&self) -> std::collections::HashMap<Guid, u32> {
        let mut counts = std::collections::HashMap::new();
        for e in self.iter_entities() {
            if let Some(cid) = e.container_id() {
                *counts.entry(cid).or_default() += 1;
            }
        }
        counts
    }

    fn get_container_count(&self, container_id: Guid) -> u32 {
        self.storage_usage(container_id)
            .map(StorageUsage::total_used)
            .unwrap_or(0)
    }

    fn storage_usage(&self, container_id: Guid) -> Option<StorageUsage> {
        let entity = self.get_entity(container_id)?;
        let is_player = Some(container_id) == self.get_player_guid();

        let mut usage = StorageUsage {
            item_capacity: entity.items_capacity().unwrap_or(0),
            container_capacity: if is_player {
                entity.containers_capacity().unwrap_or(0)
            } else {
                0
            },
            ..StorageUsage::default()
        };

        for child in self.iter_entities() {
            if child.container_id() != Some(container_id) {
                continue;
            }

            if is_player && child.uses_player_container_slot() {
                usage.container_used += 1;
            } else {
                usage.item_used += 1;
            }
        }

        Some(usage)
    }

    fn container_space_left(&self, container_id: Guid) -> u32 {
        self.storage_usage(container_id)
            .map(StorageUsage::item_space_left)
            .unwrap_or(0)
    }

    fn container_can_accept_item(&self, container_id: Guid, item_guid: Guid) -> bool {
        let Some(item) = self.get_entity(item_guid) else {
            return false;
        };

        if Some(container_id) == self.get_player_guid() {
            let Some(usage) = self.storage_usage(container_id) else {
                return false;
            };

            if item.uses_player_container_slot() {
                return usage.container_space_left() > 0;
            }

            return usage.item_space_left() > 0;
        }

        self.container_space_left(container_id) > 0
    }

    fn is_in_main_pack(&self, guid: Guid) -> bool {
        if let Some(player_guid) = self.get_player_guid() {
            self.get_entity(guid).and_then(|e| e.container_id()) == Some(player_guid)
        } else {
            false
        }
    }

    /// Recursively checks if an item or any of its contents are attuned or sticky.
    fn is_attuned_sticky_recursive(&self, guid: Guid) -> bool {
        let e = match self.get_entity(guid) {
            Some(e) => e,
            None => return false,
        };

        // Base case: the item itself is attuned or sticky.
        if e.is_attuned_sticky() {
            return true;
        }

        // Recursive case: check all items contained within this one
        for other_guid in self.iter_inventory() {
            if let Some(other) = self.get_entity(other_guid)
                && other.container_id() == Some(guid)
                && self.is_attuned_sticky_recursive(other_guid)
            {
                return true;
            }
        }

        false
    }

    fn is_container_empty(&self, container_id: Guid) -> bool {
        let e = match self.get_entity(container_id) {
            Some(e) => e,
            None => return true,
        };
        self.container_space_left(container_id) == e.items_capacity().unwrap_or(0)
    }

    fn can_sell_to_vendor(&self, guid: Guid, vendor: Option<&VendorState>) -> bool {
        let e = match self.get_entity(guid) {
            Some(e) => e,
            None => return false,
        };

        let itype = e.item_type().unwrap_or_default();

        if itype.is_empty() || !e.is_sellable() || e.item_value() == 0 {
            return false;
        }

        // If it's a container, it must be empty.
        if !self.is_container_empty(guid) {
            return false;
        }

        if let Some(vendor) = vendor
            && (itype.bits() & vendor.merchandise_item_types) == 0
        {
            return false;
        }

        // Check for active pet
        !e.has_active_pet()
    }

    fn can_add_to_trade(&self, guid: Guid) -> bool {
        let e = match self.get_entity(guid) {
            Some(e) => e,
            None => return false,
        };

        if e.is_attuned_sticky() {
            return false;
        }

        // If it's a container, it must be empty.
        if !self.is_container_empty(guid) {
            return false;
        }

        // Check for active pet
        !e.has_active_pet()
    }

    fn get_suggested_combat_mode(&self) -> CombatMode {
        let mut best = CombatMode::Melee;
        for guid in self.iter_equipment() {
            if let Some(entity) = self.get_entity(guid) {
                let wield_location = entity.wield_location();
                if wield_location.intersects(EquipMask::CASTER) {
                    return CombatMode::Magic;
                }
                if wield_location.intersects(EquipMask::MISSILE_WEAPON) {
                    best = CombatMode::Missile;
                }
            }
        }
        best
    }

    fn is_wielding_caster(&self) -> bool {
        self.get_suggested_combat_mode() == CombatMode::Magic
    }

    fn is_salvage_candidate(&self, guid: Guid) -> bool {
        let Some(entity) = self.get_entity(guid) else {
            return false;
        };

        if entity.is_retained() {
            return false;
        }

        let Some(item_type) = entity.item_type() else {
            return false;
        };

        if item_type.contains(ItemType::TINKERING_MATERIAL) {
            let structure = entity.structure().unwrap_or(0);
            let max_structure = entity.max_structure().unwrap_or(0);
            if structure >= max_structure && max_structure > 0 {
                return false;
            }
        }

        entity.material_type().is_some() && entity.workmanship().is_some()
    }

    /// Finds a non-full container in the player's possession that can accept the item.
    /// If preferred_container_id is given, it is checked first.
    /// Then the player itself (main pack), then all items in the inventory that are containers.
    fn find_non_full_pack(
        &self,
        item_guid: Guid,
        preferred_container_id: Option<Guid>,
    ) -> Option<Guid> {
        let player_guid = self.get_player_guid()?;

        // 1. Check preferred first
        if let Some(pref) = preferred_container_id
            && self.container_can_accept_item(pref, item_guid)
        {
            return Some(pref);
        }

        // 2. Check player (main pack)
        if self.container_can_accept_item(player_guid, item_guid) {
            return Some(player_guid);
        }

        // 3. Check all items in inventory
        for pack_guid in self.iter_inventory() {
            // Avoid double-checking player or preferred
            if Some(pack_guid) == preferred_container_id || pack_guid == player_guid {
                continue;
            }

            if self.container_can_accept_item(pack_guid, item_guid) {
                return Some(pack_guid);
            }
        }

        None
    }

    // Find the effective stack count that can be merged from src_guid into dst_guid.
    fn resolve_merge_stack_amount(
        &self,
        src_guid: Guid,
        dst_guid: Guid,
        max_src_amount: Option<u32>,
    ) -> Option<u32> {
        let src = self.get_entity(src_guid)?;
        let dst = self.get_entity(dst_guid)?;

        if src.wcid != dst.wcid {
            return None;
        }

        let max_stack_size = dst.max_stack_size()?;
        let src_count = src.stack_size().min(max_src_amount.unwrap_or(u32::MAX));
        let dst_count = dst.stack_size();
        Some(src_count.min(max_stack_size.saturating_sub(dst_count)))
    }

    fn can_move_item_into_container(&self, item_guid: Guid, container_id: Guid) -> bool {
        if self.get_player_guid() != Some(container_id)
            && !self.is_in_main_pack(container_id)
            && !self.is_open_container(container_id)
        {
            return false;
        }
        if !self.container_can_accept_item(container_id, item_guid) {
            return false;
        }
        let item = match self.get_entity(item_guid) {
            Some(e) => e,
            None => return false,
        };
        // Check for active pet
        !item.has_active_pet()
    }

    fn can_use_with(&self, item_guid: Guid, target_guid: Guid) -> bool {
        let item = match self.get_entity(item_guid) {
            Some(e) => e,
            None => return false,
        };
        let target = match self.get_entity(target_guid) {
            Some(e) => e,
            None => return false,
        };

        if !self.can_begin_use_with(item_guid) {
            return false;
        }

        if !item
            .target_item_type()
            .is_some_and(|t| target.item_type().unwrap_or_default().intersects(t))
        {
            return false;
        }

        self.matches_current_usable_location(
            target_guid,
            item.usable_flags().target_flags(),
            Some(item_guid),
        )
    }
}

impl<T: WorldContext + ?Sized> WorldContextExt for T {}

#[cfg(test)]
mod tests {
    use std::collections::{HashMap, HashSet};

    use super::{
        CombatTargetStatus, RunSkillSource, WorldContext, WorldContextExt, burden_load_modifier,
        exhausted_run_skill, run_rate_from_skill_and_burden,
    };
    use crate::entity::{Entity, EntityMotionSnapshot};
    use crate::stats::{AttributeType, SkillType, VitalType};
    use holtburger_common::Guid;
    use holtburger_common::position::WorldPosition;
    use holtburger_common::properties::EquipMask;
    use holtburger_common::properties::{
        ItemType, PropertyBool, PropertyInstanceId, PropertyInt, Usable,
    };
    use holtburger_protocol::messages::combat::CombatMode;
    use holtburger_protocol::messages::movement::{InterpretedMotionCommand, MotionStance};

    #[derive(Default)]
    struct TestWorld {
        player_guid: Option<Guid>,
        entities: HashMap<Guid, Entity>,
        inventory: HashSet<Guid>,
        equipment: HashSet<Guid>,
        open_containers: HashSet<Guid>,
        player_attributes: HashMap<AttributeType, u32>,
        player_skills: HashMap<SkillType, u32>,
        player_vitals: HashMap<VitalType, u32>,
        player_int_properties: Vec<(PropertyInt, i32)>,
    }

    impl WorldContext for TestWorld {
        fn get_player_guid(&self) -> Option<Guid> {
            self.player_guid
        }

        fn get_entity(&self, guid: Guid) -> Option<&Entity> {
            self.entities.get(&guid)
        }

        fn iter_inventory(&self) -> impl Iterator<Item = Guid> + '_ {
            self.inventory.iter().copied()
        }

        fn iter_equipment(&self) -> impl Iterator<Item = Guid> + '_ {
            self.equipment.iter().copied()
        }

        fn iter_entities(&self) -> impl Iterator<Item = &Entity> + '_ {
            self.entities.values()
        }

        fn is_open_container(&self, guid: Guid) -> bool {
            self.open_containers.contains(&guid)
        }

        fn get_player_attribute_current(&self, attr: AttributeType) -> Option<u32> {
            self.player_attributes.get(&attr).copied()
        }

        fn get_player_skill_current(&self, skill: SkillType) -> Option<u32> {
            self.player_skills.get(&skill).copied()
        }

        fn get_player_vital_current(&self, vital: VitalType) -> Option<u32> {
            self.player_vitals.get(&vital).copied()
        }

        fn get_player_int_property(&self, prop: PropertyInt) -> Option<i32> {
            self.player_int_properties
                .iter()
                .find_map(|(candidate, value)| (*candidate == prop).then_some(*value))
        }
    }

    fn entity(guid: Guid, name: &str) -> Entity {
        Entity::new(guid, name.to_string(), WorldPosition::default())
    }

    fn item_in_container(guid: Guid, container_id: Guid, name: &str) -> Entity {
        let mut item = entity(guid, name);
        item.properties
            .iids
            .insert(PropertyInstanceId::Container, container_id);
        item
    }

    #[test]
    fn burden_load_modifier_matches_ace_thresholds() {
        assert_eq!(burden_load_modifier(0.5), 1.0);
        assert_eq!(burden_load_modifier(1.25), 0.75);
        assert_eq!(burden_load_modifier(2.0), 0.0);
    }

    /// A3-D2(a) exhaustion lane (2026-06-12) — the "stamina 0→1.0" unit
    /// test DESIGN.md's Stage-1 list promised: at wire Stamina current
    /// == 0 ACE treats the run skill as 0, and `GetRunRate`'s formula
    /// then yields exactly 1.0 for EVERY burden
    /// (`(load_mod·0·11 + 4)/4`; acclient.c:339421-339434 event chain).
    /// Stamina > 0 and an unpopulated vital both pass the skill through
    /// untouched — absence of data is never exhaustion.
    #[test]
    fn exhausted_run_skill_stamina_zero_resolves_run_rate_one() {
        for burden in [0.0, 0.5, 1.25, 3.0] {
            assert_eq!(
                run_rate_from_skill_and_burden(exhausted_run_skill(300.0, Some(0)), burden),
                1.0,
                "stamina 0 must resolve the exhausted rate at burden {burden}"
            );
        }
        assert_eq!(exhausted_run_skill(300.0, Some(1)), 300.0);
        assert_eq!(exhausted_run_skill(300.0, None), 300.0);
    }

    /// T1 (2026-06-02): `run_rate_from_skill_and_burden` is the run-rate
    /// source the velScale path feeds into the `stateGroundSpeed` getter
    /// (which clamps to `run_rate * 4.0`). Lock the ACE `GetRunRate` math:
    /// the `>= 800` skill cap and the burden-modulated formula.
    #[test]
    fn run_rate_from_skill_and_burden_matches_ace_getrunrate() {
        // run_skill >= 800 → flat 18/4 = 4.5 cap regardless of burden.
        assert!((run_rate_from_skill_and_burden(800.0, 0.0) - 4.5).abs() < 1e-6);
        assert!((run_rate_from_skill_and_burden(1500.0, 0.5) - 4.5).abs() < 1e-6);

        // Unencumbered (burden < 1 → load_mod 1.0), run_skill 300:
        // (1.0 * (300/500 * 11) + 4) / 4 = (6.6 + 4) / 4 = 2.65.
        let r300 = run_rate_from_skill_and_burden(300.0, 0.0);
        assert!((r300 - 2.65).abs() < 1e-5, "r300 = {r300}");

        // Over-encumbered (burden >= 2 → load_mod 0.0): only the +4 base
        // survives → 4/4 = 1.0 (the slowest non-zero rate).
        let r_heavy = run_rate_from_skill_and_burden(300.0, 2.5);
        assert!((r_heavy - 1.0).abs() < 1e-6, "r_heavy = {r_heavy}");
    }

    /// Snapback probe (2026-06-06), updated for unified-pipeline STAGE 1
    /// (2026-06-11): `player_run_rate_inputs()` must (a) report the wire Run
    /// skill when present, (b) report `Unavailable` + `None` run_rate when the
    /// wire Run skill is absent EVEN IF Quickness is loaded — the Quickness
    /// fallback (confirmed snapback root, DESIGN.md §2 defect 1) is retired
    /// and must never resurface, (c) same when neither is loaded, and in
    /// every case its `run_rate` must equal `player_run_rate()` so the probe
    /// measures exactly what the movement/velScale paths consumed.
    #[test]
    fn player_run_rate_inputs_reports_skill_source_and_matches_run_rate() {
        let player_guid = Guid(0x5000_0001);
        let base = || TestWorld {
            player_guid: Some(player_guid),
            // Strength 100 → capacity 15000, empty inventory → burden 0 → load_mod 1.0,
            // keeping the rate skill-discriminating rather than collapsing to 3.0.
            player_attributes: HashMap::from([(AttributeType::StrengthAttr, 100)]),
            ..Default::default()
        };

        // (a) wire Run skill wins; run_rate matches player_run_rate.
        let mut wire = base();
        wire.player_skills.insert(SkillType::Run, 185);
        wire.player_attributes.insert(AttributeType::QuicknessAttr, 180);
        let i = wire.player_run_rate_inputs();
        assert_eq!(i.run_skill_source, RunSkillSource::WireRunSkill);
        assert_eq!(i.run_skill_used, Some(185.0));
        assert_eq!(i.run_skill_wire, Some(185));
        assert_eq!(i.quickness, Some(180));
        assert!((i.load_mod - 1.0).abs() < 1e-6);
        assert_eq!(i.run_rate, wire.player_run_rate());
        assert!(i.to_json().contains("\"run_skill_source\":\"wire_run_skill\""));

        // (b) no wire Run skill → Unavailable, EVEN with Quickness loaded.
        // STAGE 1 retired the Quickness synthesis: ACE has no such fallback
        // (retail's Inq-failure fallback is my_run_rate, acclient.c:343452-
        // 343455), so emitting one guaranteed a run-rate ACE doesn't hold.
        let mut fb = base();
        fb.player_attributes.insert(AttributeType::QuicknessAttr, 180);
        let i = fb.player_run_rate_inputs();
        assert_eq!(i.run_skill_source, RunSkillSource::Unavailable);
        assert_eq!(i.run_skill_used, None);
        assert_eq!(i.run_skill_wire, None);
        assert_eq!(i.quickness, Some(180), "Quickness still REPORTED for diffs");
        assert_eq!(i.run_rate, None);
        assert_eq!(fb.player_run_rate(), None);
        assert!(i.to_json().contains("\"run_skill_source\":\"unavailable\""));

        // (c) neither loaded → Unavailable + None run_rate (caller applies
        // the my_run_rate/1.0 degrade, never a synthesized rate).
        let mut none = TestWorld {
            player_guid: Some(player_guid),
            ..Default::default()
        };
        none.player_attributes.remove(&AttributeType::QuicknessAttr);
        let i = none.player_run_rate_inputs();
        assert_eq!(i.run_skill_source, RunSkillSource::Unavailable);
        assert_eq!(i.run_rate, None);
        assert_eq!(none.player_run_rate(), None);
        assert!(i.to_json().contains("\"run_rate\":null"));
    }

    /// AUG-CAP (2026-06-06): the augmentation carry-capacity bonus is capped at
    /// 150 (× strength) to match ACE `EncumbranceSystem.EncumbranceCapacity`.
    /// The cap only bites at num_augs >= 6 (30 * 6 = 180 > 150).
    #[test]
    fn player_capacity_caps_augmentation_bonus_at_150() {
        let player_guid = Guid(0x5000_0001);
        let with_augs = |augs: i32| TestWorld {
            player_guid: Some(player_guid),
            player_attributes: HashMap::from([(AttributeType::StrengthAttr, 100)]),
            player_int_properties: vec![(
                PropertyInt::AugmentationIncreasedCarryingCapacity,
                augs,
            )],
            ..Default::default()
        };
        // num_augs=1 → bonus 30 (< cap): 150*100 + 30*100 = 18000 (unchanged).
        assert_eq!(with_augs(1).player_capacity(), Some(18_000.0));
        // num_augs=6 → bonus 30*6=180 capped to 150: 150*100 + 150*100 = 30000.
        assert_eq!(with_augs(6).player_capacity(), Some(30_000.0));
        // num_augs=10 → still capped: 30000, NOT 150*100 + 300*100 = 45000.
        assert_eq!(with_augs(10).player_capacity(), Some(30_000.0));
    }

    /// ENC-ROBUST (2026-06-06): an inventory guid with no loaded entity is
    /// skipped (partial sum), not collapsed to `None` — so burden never
    /// transiently spikes to 3.0 (over-encumbered) during the boot window.
    #[test]
    fn player_encumbrance_skips_unresolved_inventory_guids() {
        let player_guid = Guid(0x5000_0001);
        let loaded_guid = Guid(0x8000_0001);
        let unloaded_guid = Guid(0x8000_0002); // in inventory, NOT in entities

        let mut world = TestWorld {
            player_guid: Some(player_guid),
            inventory: HashSet::from([loaded_guid, unloaded_guid]),
            ..Default::default()
        };
        let mut loaded = item_in_container(loaded_guid, player_guid, "Sack");
        loaded
            .properties
            .ints
            .insert(PropertyInt::EncumbranceVal, 250);
        world.entities.insert(loaded_guid, loaded);

        // Unresolved guid skipped → partial sum of the loaded item only, NOT None.
        assert_eq!(world.player_encumbrance(), Some(250.0));
    }

    #[test]
    fn player_run_rate_uses_nested_container_burden_and_ace_formula() {
        let player_guid = Guid(0x5000_0001);
        let side_pack_guid = Guid(0x8000_0001);
        let nested_item_guid = Guid(0x8000_0002);
        let equipped_item_guid = Guid(0x8000_0003);

        let mut world = TestWorld {
            player_guid: Some(player_guid),
            inventory: HashSet::from([side_pack_guid, nested_item_guid, equipped_item_guid]),
            equipment: HashSet::from([equipped_item_guid]),
            player_attributes: HashMap::from([(AttributeType::StrengthAttr, 100)]),
            player_skills: HashMap::from([(SkillType::Run, 300)]),
            player_int_properties: vec![(PropertyInt::AugmentationIncreasedCarryingCapacity, 1)],
            ..Default::default()
        };

        let mut side_pack = item_in_container(side_pack_guid, player_guid, "Side Pack");
        side_pack
            .properties
            .ints
            .insert(PropertyInt::EncumbranceVal, 120);
        world.entities.insert(side_pack_guid, side_pack);

        let mut nested_item = item_in_container(nested_item_guid, side_pack_guid, "Nested Item");
        nested_item
            .properties
            .ints
            .insert(PropertyInt::EncumbranceVal, 9999);
        world.entities.insert(nested_item_guid, nested_item);

        let mut equipped_item = entity(equipped_item_guid, "Wand");
        equipped_item
            .properties
            .ints
            .insert(PropertyInt::EncumbranceVal, 180);
        world.entities.insert(equipped_item_guid, equipped_item);

        let expected_burden = 300.0 / 18000.0;
        assert_eq!(world.player_encumbrance(), Some(300.0));
        assert_eq!(world.player_capacity(), Some(18_000.0));
        assert_eq!(world.player_burden(), Some(expected_burden));
        assert_eq!(
            world.player_run_rate(),
            Some(run_rate_from_skill_and_burden(300.0, expected_burden))
        );
    }

    #[test]
    fn suggested_combat_mode_uses_wield_location_over_item_type_noise() {
        let player_guid = Guid(0x5000_0001);
        let sword_guid = Guid(0x8000_0001);

        let mut world = TestWorld {
            player_guid: Some(player_guid),
            equipment: HashSet::from([sword_guid]),
            ..Default::default()
        };

        let mut sword = entity(sword_guid, "Noisy Sword");
        sword.properties.ints.insert(
            PropertyInt::ItemType,
            (ItemType::MELEE_WEAPON | ItemType::MISSILE_WEAPON).bits() as i32,
        );
        sword.properties.ints.insert(
            PropertyInt::CurrentWieldedLocation,
            EquipMask::MELEE_WEAPON.bits() as i32,
        );
        world.entities.insert(sword_guid, sword);

        assert_eq!(world.get_suggested_combat_mode(), CombatMode::Melee);
    }

    #[test]
    fn player_slot_counts_split_main_pack_items_from_container_slots() {
        let player_guid = Guid(0x5000_0001);
        let sword_guid = Guid(0x8000_0001);
        let side_pack_guid = Guid(0x8000_0002);
        let focus_guid = Guid(0x8000_0003);
        let nested_item_guid = Guid(0x8000_0004);

        let mut world = TestWorld {
            player_guid: Some(player_guid),
            inventory: HashSet::from([sword_guid, side_pack_guid, focus_guid, nested_item_guid]),
            ..Default::default()
        };

        let mut player = entity(player_guid, "Player");
        player
            .properties
            .ints
            .insert(PropertyInt::ItemsCapacity, 10);
        player
            .properties
            .ints
            .insert(PropertyInt::ContainersCapacity, 3);
        world.entities.insert(player_guid, player);

        world.entities.insert(
            sword_guid,
            item_in_container(sword_guid, player_guid, "Sword"),
        );

        let mut side_pack = item_in_container(side_pack_guid, player_guid, "Side Pack");
        side_pack
            .properties
            .ints
            .insert(PropertyInt::ItemsCapacity, 24);
        world.entities.insert(side_pack_guid, side_pack);

        let mut focus = item_in_container(focus_guid, player_guid, "Focus");
        focus
            .properties
            .bools
            .insert(PropertyBool::RequiresBackpackSlot, true);
        world.entities.insert(focus_guid, focus);

        world.entities.insert(
            nested_item_guid,
            item_in_container(nested_item_guid, side_pack_guid, "Apple"),
        );

        assert_eq!(world.get_container_count(player_guid), 3);
        let usage = world
            .storage_usage(player_guid)
            .expect("player should have storage usage");
        assert_eq!(usage.item_used, 1);
        assert_eq!(usage.container_used, 2);
        assert_eq!(usage.item_space_left(), 9);
        assert_eq!(usage.container_space_left(), 1);
    }

    #[test]
    fn find_non_full_pack_uses_player_slot_type_for_item() {
        let player_guid = Guid(0x5000_0001);
        let regular_item_guid = Guid(0x8000_0001);
        let container_item_guid = Guid(0x8000_0002);
        let side_pack_guid = Guid(0x8000_0003);

        let mut world = TestWorld {
            player_guid: Some(player_guid),
            inventory: HashSet::from([regular_item_guid, container_item_guid, side_pack_guid]),
            ..Default::default()
        };

        let mut player = entity(player_guid, "Player");
        player.properties.ints.insert(PropertyInt::ItemsCapacity, 0);
        player
            .properties
            .ints
            .insert(PropertyInt::ContainersCapacity, 2);
        world.entities.insert(player_guid, player);

        world.entities.insert(
            regular_item_guid,
            item_in_container(regular_item_guid, Guid::NULL, "Sword"),
        );

        let mut container_item = item_in_container(container_item_guid, Guid::NULL, "Pack");
        container_item
            .properties
            .bools
            .insert(PropertyBool::RequiresBackpackSlot, true);
        world.entities.insert(container_item_guid, container_item);

        let mut side_pack = item_in_container(side_pack_guid, player_guid, "Side Pack");
        side_pack
            .properties
            .ints
            .insert(PropertyInt::ItemsCapacity, 24);
        world.entities.insert(side_pack_guid, side_pack);

        assert_eq!(
            world.find_non_full_pack(regular_item_guid, None),
            Some(side_pack_guid)
        );
        assert_eq!(
            world.find_non_full_pack(container_item_guid, None),
            Some(player_guid)
        );
    }

    #[test]
    fn suggested_combat_mode_detects_missile_and_caster_by_wield_slot() {
        let player_guid = Guid(0x5000_0001);
        let bow_guid = Guid(0x8000_0001);
        let wand_guid = Guid(0x8000_0002);

        let mut world = TestWorld {
            player_guid: Some(player_guid),
            equipment: HashSet::from([bow_guid]),
            ..Default::default()
        };

        let mut bow = entity(bow_guid, "Bow");
        bow.properties.ints.insert(
            PropertyInt::CurrentWieldedLocation,
            EquipMask::MISSILE_WEAPON.bits() as i32,
        );
        world.entities.insert(bow_guid, bow);

        assert_eq!(world.get_suggested_combat_mode(), CombatMode::Missile);

        let mut wand = entity(wand_guid, "Wand");
        wand.properties.ints.insert(
            PropertyInt::CurrentWieldedLocation,
            EquipMask::CASTER.bits() as i32,
        );
        world.entities.insert(wand_guid, wand);
        world.equipment.insert(wand_guid);

        assert_eq!(world.get_suggested_combat_mode(), CombatMode::Magic);
    }

    #[test]
    fn nearby_use_requires_matching_source_location() {
        let player_guid = Guid(0x5000_0001);
        let item_guid = Guid(0x8000_0001);

        let mut world = TestWorld {
            player_guid: Some(player_guid),
            ..Default::default()
        };

        let mut ground_item = entity(item_guid, "Ground Item");
        ground_item.position.landblock_id = Guid(0x1234_0001);
        ground_item
            .properties
            .ints
            .insert(PropertyInt::ItemUseable, Usable::CONTAINED.bits() as i32);
        world.entities.insert(item_guid, ground_item.clone());

        assert!(!world.can_use(item_guid));

        world
            .entities
            .get_mut(&item_guid)
            .unwrap()
            .properties
            .ints
            .insert(PropertyInt::ItemUseable, Usable::REMOTE.bits() as i32);

        assert!(world.can_use(item_guid));
    }

    #[test]
    fn combat_target_status_reports_available_creature_targets() {
        let player_guid = Guid(0x5000_0001);
        let target_guid = Guid(0x8000_0001);

        let mut world = TestWorld {
            player_guid: Some(player_guid),
            ..Default::default()
        };

        let mut target = entity(target_guid, "Drudge");
        target.position.landblock_id = Guid(0x0100_0001);
        target
            .properties
            .ints
            .insert(PropertyInt::ItemType, ItemType::CREATURE.bits() as i32);
        world.entities.insert(target_guid, target);

        assert_eq!(
            world.combat_target_status(target_guid),
            CombatTargetStatus::Available
        );
        assert!(world.combat_target_status(target_guid).is_available());
    }

    #[test]
    fn combat_target_status_reports_death_motion_observed() {
        let player_guid = Guid(0x5000_0001);
        let target_guid = Guid(0x8000_0001);

        let mut world = TestWorld {
            player_guid: Some(player_guid),
            ..Default::default()
        };

        let mut target = entity(target_guid, "Drudge");
        target.position.landblock_id = Guid(0x0100_0001);
        target
            .properties
            .ints
            .insert(PropertyInt::ItemType, ItemType::CREATURE.bits() as i32);
        target.motion_snapshot = Some(EntityMotionSnapshot {
            current_style: Some(MotionStance::NonCombat),
            forward_command: Some(InterpretedMotionCommand::DEAD),
            sidestep_command: None,
            turn_command: None,
            ..Default::default()
        });
        world.entities.insert(target_guid, target);

        assert_eq!(
            world.combat_target_status(target_guid),
            CombatTargetStatus::DeathMotionObserved
        );
        assert!(!world.combat_target_status(target_guid).is_available());
    }

    #[test]
    fn physics_parent_alone_does_not_make_item_remote() {
        let player_guid = Guid(0x5000_0001);
        let item_guid = Guid(0x8000_0001);

        let mut world = TestWorld {
            player_guid: Some(player_guid),
            ..Default::default()
        };

        let mut attached_item = entity(item_guid, "Attached Item");
        attached_item.physics_parent_id = Some(Guid(0x7000_0001));
        attached_item
            .properties
            .ints
            .insert(PropertyInt::ItemUseable, Usable::REMOTE.bits() as i32);
        world.entities.insert(item_guid, attached_item);

        assert!(!world.can_use(item_guid));
        assert_eq!(
            world.current_usable_location_flags(item_guid, None),
            Usable::empty()
        );
    }

    #[test]
    fn combine_requires_non_empty_target_location_bits() {
        let player_guid = Guid(0x5000_0001);
        let item_guid = Guid(0x8000_0001);

        let mut world = TestWorld {
            player_guid: Some(player_guid),
            inventory: HashSet::from([item_guid]),
            ..Default::default()
        };

        let mut inventory_item = entity(item_guid, "Tool");
        inventory_item
            .properties
            .ints
            .insert(PropertyInt::TargetType, ItemType::MISC.bits() as i32);
        inventory_item
            .properties
            .ints
            .insert(PropertyInt::ItemUseable, Usable::CONTAINED.bits() as i32);
        world.entities.insert(item_guid, inventory_item);

        assert!(!world.can_begin_use_with(item_guid));

        world
            .entities
            .get_mut(&item_guid)
            .unwrap()
            .properties
            .ints
            .insert(
                PropertyInt::ItemUseable,
                Usable::SOURCE_CONTAINED_TARGET_REMOTE.bits() as i32,
            );

        assert!(world.can_begin_use_with(item_guid));
    }

    #[test]
    fn combine_respects_target_viewed_location() {
        let player_guid = Guid(0x5000_0001);
        let source_guid = Guid(0x8000_0001);
        let container_guid = Guid(0x8000_0002);
        let target_guid = Guid(0x8000_0003);

        let mut world = TestWorld {
            player_guid: Some(player_guid),
            inventory: HashSet::from([source_guid]),
            open_containers: HashSet::from([container_guid]),
            ..Default::default()
        };

        let mut source = entity(source_guid, "Salve");
        source
            .properties
            .ints
            .insert(PropertyInt::TargetType, ItemType::MISC.bits() as i32);
        source.properties.ints.insert(
            PropertyInt::ItemUseable,
            Usable::SOURCE_CONTAINED_TARGET_VIEWED.bits() as i32,
        );
        world.entities.insert(source_guid, source);

        let mut container = entity(container_guid, "Chest");
        container.position.landblock_id = Guid(0x1234_0001);
        world.entities.insert(container_guid, container);

        let mut target = entity(target_guid, "Target");
        target
            .properties
            .ints
            .insert(PropertyInt::ItemType, ItemType::MISC.bits() as i32);
        target
            .properties
            .iids
            .insert(PropertyInstanceId::Container, container_guid);
        world.entities.insert(target_guid, target);

        assert!(world.can_use_with(source_guid, target_guid));

        world.open_containers.clear();
        assert!(!world.can_use_with(source_guid, target_guid));
    }

    #[test]
    fn player_owned_helper_includes_inventory_and_equipment() {
        let player_guid = Guid(0x5000_0001);
        let inventory_guid = Guid(0x8000_0001);
        let equipped_guid = Guid(0x8000_0002);
        let other_guid = Guid(0x8000_0003);

        let world = TestWorld {
            player_guid: Some(player_guid),
            inventory: HashSet::from([inventory_guid]),
            equipment: HashSet::from([equipped_guid]),
            ..Default::default()
        };

        assert!(world.is_owned_by_player(inventory_guid));
        assert!(world.is_owned_by_player(equipped_guid));
        assert!(!world.is_owned_by_player(other_guid));
    }

    #[test]
    fn get_player_monarch_guid_returns_player_monarch() {
        let player_guid = Guid(0x5000_0001);
        let monarch_guid = Guid(0x8000_0001);

        let mut world = TestWorld {
            player_guid: Some(player_guid),
            ..Default::default()
        };

        let mut player = entity(player_guid, "Player");
        player
            .properties
            .iids
            .insert(PropertyInstanceId::Monarch, monarch_guid);
        world.entities.insert(player_guid, player);

        assert_eq!(world.get_player_monarch_guid(), Some(monarch_guid));
    }

    #[test]
    fn resolve_player_guid_by_name_ignores_whitespace_and_case() {
        let target_guid = Guid(0x8000_0001);
        let mut world = TestWorld::default();
        world
            .entities
            .insert(target_guid, entity(target_guid, "Sir   Loin"));

        assert_eq!(
            world.resolve_player_guid_by_name("sirloin"),
            Some(target_guid)
        );
        assert_eq!(
            world.resolve_player_guid_by_name(" S I R   L O I N "),
            Some(target_guid)
        );
        assert_eq!(world.resolve_player_guid_by_name("   \t  "), None);
    }
}
