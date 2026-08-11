use crate::entity::Entity;
use crate::state::WorldState;
use crate::stats::{AttributeType, SkillType, VitalType};
use crate::vendor::VendorState;
use holtburger_common::Guid;
use holtburger_common::properties::{
    EquipMask, ItemType, PropertyFloat, PropertyInt, Usable, WorldObjectExt,
    WorldObjectPropertyAccessors,
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

/// Which `GetRunRate` special-case arm to use. Retail
/// `MovementSystem::GetRunRate` (acclient.c:713790) fires the
/// `18.0/4.0 = 4.5` arm at `runskill == 800` EXACTLY — a discontinuous
/// spike; skill 801+ falls back to the formula (≈3.20 at 801, →3.75 as
/// s→∞). ACE inherited `>= 800` (ACE `MovementSystem.cs:24`), plateauing
/// everything above 800 at 4.5. Default `false` keeps the ACE arm — the
/// live server re-derives movement ACE-side, so matching ACE avoids a
/// client/server speed skew above 800; flip only for retail-trace
/// parity work (dossier row 36).
pub const RETAIL_RUNRATE_EDGE: bool = false;

/// Retail PK arm of the jump stamina cost — the `bPK` input to
/// `MovementSystem::JumpStaminaCost` (acclient.c:713830), computed by
/// `CACQualities::JumpStaminaCost` (acclient.c:442887-442905):
/// `PlayerKillerStatus` (int 0x86, pre-init 8 when the inquiry fails)
/// must be 4 (PK) or 64 (PKLite), AND `LastPkAttackTimestamp`
/// (float 0x91) must be present with `timestamp + 20.0 > now`.
/// `now` must be in the SAME clock domain the server writes the
/// timestamp in — for ACE that is UNIX seconds (Player_Combat.cs:998,
/// `Time.GetUnixTime()`). Do NOT pass `WorldState::current_server_time`:
/// once TimeSync is delivered (P4.2) that is the PACKET clock — ACE
/// `Timers.PortalYearTicks`, seconds since 2017-01-31 (≈ 3.0e8), 47
/// years behind Unix — and the predicate degrades to "always armed".
/// Callers pin a Unix wall clock explicitly (see the movement-system
/// callsite, P4.2 follow-up F3).
pub fn pk_jump_stamina_arm(
    pk_status: Option<i32>,
    time_last_pk_attack: Option<f64>,
    now_seconds: f64,
) -> bool {
    let status = pk_status.unwrap_or(8);
    if status != 4 && status != 64 {
        return false;
    }
    match time_last_pk_attack {
        Some(timestamp) => timestamp + 20.0 > now_seconds,
        None => false,
    }
}

pub fn run_rate_from_skill_and_burden(run_skill: f32, burden: f32) -> f32 {
    run_rate_from_skill_and_burden_with_edge(run_skill, burden, RETAIL_RUNRATE_EDGE)
}

/// [`run_rate_from_skill_and_burden`] with the special-case arm made
/// explicit (`retail_edge` — see [`RETAIL_RUNRATE_EDGE`]): `true` =
/// retail `== 800` spike, `false` = ACE `>= 800` plateau.
pub fn run_rate_from_skill_and_burden_with_edge(
    run_skill: f32,
    burden: f32,
    retail_edge: bool,
) -> f32 {
    let spike = if retail_edge {
        run_skill == 800.0
    } else {
        run_skill >= 800.0
    };
    if spike {
        18.0 / 4.0
    } else {
        let load_mod = burden_load_modifier(burden);
        (load_mod * (run_skill / (run_skill + 200.0) * 11.0) + 4.0) / 4.0
    }
}

/// MOVE-RUNRATE-105 fix B (2026-08-11) — the augmentation terms retail's
/// `CACQualities::InqRunRate` folds into its run-skill composition
/// (acclient.c:443696-443770, the `runskill` local), and ACE folds into
/// `CreatureSkill.Current` via `GetAugBonus_Base`/`GetAugBonus_Current`
/// (`CreatureSkill.cs:197-243`):
///
/// | term | retail | ACE |
/// |---|---|---|
/// | `LumAugAllSkills` (int 0x16D/365) | `if v>0 { runskill += v }` | `GetAugBonus_Base` |
/// | `AugmentationJackOfAllTrades` (int 0x146/326) | `if v>0 { runskill += 5 }` | `GetAugBonus_Current`, `v * 5` |
/// | `LumAugSkilledSpec` (int 0x158/344) | `if v>0 && sac==3 { runskill += 2*v }` | `GetAugBonus_Current`, Specialized only |
///
/// Retail's JoAT arm adds a FLAT 5 where ACE multiplies; the two agree for
/// every legal value (JackOfAllTrades is a one-shot augmentation: 0 or 1).
/// We take ACE's multiplicative form because the ACE server is the position
/// authority — matching it is what removes the snapback the stage-1 fix
/// targeted.
///
/// WHY THIS EXISTS: the stage-1 spec said "wire Run skill `Current` exactly
/// as ACE composes it (formula base + init + ranks)" — that parenthetical is
/// short by exactly these three terms, and
/// `holtburger_world::player::stats_calc::derive_skill_value` implements the
/// parenthetical. Measured consequence on the oracle rig (2026-08-11):
/// `AugmentationJackOfAllTrades = 1` on both agent characters, so ACE read
/// Run 110 where we read 105 — the entire `run-hold-long` −1.0% steady-speed
/// FAIL. (`holtburger-core`'s OTHER skill implementation,
/// `client::skill_info::SkillInfo::current`, has had all three terms since it
/// was ported from retail's `SkillInfo.cs`; only the world copy drifted.)
pub fn run_skill_augmentation_bonus(
    lum_aug_all_skills: i32,
    jack_of_all_trades: i32,
    lum_aug_skilled_spec: i32,
    specialized: bool,
) -> f32 {
    let mut bonus = 0i32;
    if lum_aug_all_skills > 0 {
        bonus += lum_aug_all_skills;
    }
    if jack_of_all_trades > 0 {
        bonus += jack_of_all_trades * 5;
    }
    if specialized && lum_aug_skilled_spec > 0 {
        bonus += lum_aug_skilled_spec * 2;
    }
    bonus as f32
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
    /// MOVE-RUNRATE-105 fix A (2026-08-11): no skill was composed at all —
    /// the rate came straight off the wire as the server's own
    /// `my_run_rate` (`PlayerState::server_run_rate`). The default lane.
    ServerRunRate,
}

impl RunSkillSource {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Unavailable => "unavailable",
            Self::WireRunSkill => "wire_run_skill",
            Self::QuicknessFallback => "quickness_fallback",
            Self::ServerRunRate => "server_run_rate",
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
    /// MOVE-RUNRATE-105 fix A: the server's own `my_run_rate` as last seen
    /// on the wire (`PlayerState::server_run_rate`), independent of whether
    /// it won. `None` = never observed, or the `?serverRunRate=off` escape
    /// is engaged.
    pub server_run_rate: Option<f32>,
    /// MOVE-RUNRATE-105 fix B: the augmentation bonus folded into the
    /// composed run skill ([`run_skill_augmentation_bonus`]). Reported so a
    /// capture can tell "we and ACE agree" from "we and ACE agree by luck".
    pub run_skill_aug_bonus: f32,
    /// ORACLE open defect #1 (2026-08-11): the RAW
    /// `AugmentationJackOfAllTrades` read, `None` when the property is not in
    /// the bag. Session 3 measured `composed` at exactly the Run-105 rate on
    /// all 233 ticks (1.9467213 — arithmetically `run_skill 105.000` with
    /// `load_mod 1.0`) while the login-time snapshot of THIS SAME struct
    /// reported `run_skill_aug_bonus: 5`. Same helper, same reads, two
    /// answers, so something under the read changed — and
    /// `run_skill_aug_bonus: 0` alone cannot say what. This does.
    pub aug_joat: Option<i32>,
    /// ORACLE open defect #1: whether the local player ENTITY exists at all.
    /// This is the discriminator the last capture lacked. EVERY
    /// `get_player_int_property` read goes through
    /// `player_entity().properties`, while skills and attributes live on
    /// `PlayerState` and survive independently — so an absent entity reads as
    /// "no augmentations" while the Run skill keeps composing perfectly.
    ///
    /// * `false` ⇒ the entity is gone (the `@teleloc` remove-without-recreate
    ///   shape; `upsert_entity_from_create` re-seeds from
    ///   `player_description_properties` on a CREATE, but nothing re-seeds a
    ///   delete that is never followed by one);
    /// * `true` with `aug_joat: null` ⇒ the entity is live and the property
    ///   itself is missing (never delivered, or removed by an update);
    /// * `aug_joat: Some(n>0)` with `run_skill_aug_bonus: 0` ⇒ the helper is
    ///   at fault, which nothing currently suggests.
    pub player_entity_present: bool,
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
        fn oi(v: Option<i32>) -> String {
            v.map_or_else(|| "null".to_string(), |x| x.to_string())
        }
        format!(
            "{{\"run_rate\":{},\"run_skill_used\":{},\"run_skill_source\":\"{}\",\
             \"run_skill_wire\":{},\"quickness\":{},\"burden\":{},\"load_mod\":{},\
             \"encumbrance\":{},\"capacity\":{},\"strength\":{},\"num_augs\":{},\
             \"server_run_rate\":{},\"run_skill_aug_bonus\":{},\
             \"aug_joat\":{},\"player_entity_present\":{}}}",
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
            of(self.server_run_rate),
            self.run_skill_aug_bonus,
            oi(self.aug_joat),
            self.player_entity_present,
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

    /// Retail `Skill::_sac == 3` (`CACQualities::InqRunRate`,
    /// acclient.c:443750-443757) / ACE
    /// `SkillAdvancementClass.Specialized` — gates the `LumAugSkilledSpec`
    /// term of [`run_skill_augmentation_bonus`].
    fn get_player_skill_is_specialized(&self, _skill: SkillType) -> bool {
        false
    }

    fn get_player_vital_current(&self, _vital: VitalType) -> Option<u32> {
        None
    }

    /// MOVE-RUNRATE-105 fix A (2026-08-11): the run rate the SERVER last
    /// published for the local player, or `None` when none has been seen
    /// (or the `?serverRunRate=off` escape is engaged). See
    /// [`WorldContextExt::player_run_rate`] for the whole decision.
    fn get_player_server_run_rate(&self) -> Option<f32> {
        None
    }

    fn get_player_int_property(&self, _prop: PropertyInt) -> Option<i32> {
        None
    }

    fn get_player_float_property(&self, _prop: PropertyFloat) -> Option<f64> {
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

    fn get_player_skill_is_specialized(&self, skill: SkillType) -> bool {
        self.player
            .skills
            .get(&skill)
            .is_some_and(|skill| skill.training == crate::stats::TrainingLevel::Specialized)
    }

    fn get_player_server_run_rate(&self) -> Option<f32> {
        self.server_run_rate_enabled
            .then(|| self.player.server_run_rate)
            .flatten()
    }

    fn get_player_vital_current(&self, vital: VitalType) -> Option<u32> {
        self.player.vitals.get(&vital).map(|vital| vital.current)
    }

    fn get_player_int_property(&self, prop: PropertyInt) -> Option<i32> {
        self.player_int_property(prop)
    }

    fn get_player_float_property(&self, prop: PropertyFloat) -> Option<f64> {
        self.player_float_property(prop)
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

    /// MOVE-RUNRATE-105 fix A (2026-08-11) — the local player's run rate,
    /// SERVER FIRST.
    ///
    /// Order: the server's published `my_run_rate`
    /// ([`WorldContext::get_player_server_run_rate`]) when it has been seen,
    /// else the local composition below. Owner directive 2026-08-11: "adopt
    /// the server-provided run rate for the local player — retail-faithful",
    /// reversing the stage-1 local-recompute decision (DESIGN.md §2 defect 1,
    /// which now carries the DEVIATION block). `?serverRunRate=off` restores
    /// the stage-1 order (composition only) without a rebuild.
    ///
    /// With fix B (the augmentation terms, [`run_skill_augmentation_bonus`])
    /// the two arms AGREE on the oracle rig — both land on 1.9758065. That is
    /// the point: the fallback is no longer a different answer, it is the same
    /// answer derived without the wire.
    fn player_run_rate(&self) -> Option<f32> {
        if let Some(server_rate) = self.get_player_server_run_rate() {
            return Some(server_rate);
        }
        self.player_composed_run_rate()
    }

    /// The local composition — the stage-1 lane, now the FALLBACK for
    /// [`Self::player_run_rate`] (and the whole answer under
    /// `?serverRunRate=off`).
    fn player_composed_run_rate(&self) -> Option<f32> {
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
        let run_skill = self.player_composed_run_skill()?;
        let burden = self.player_burden().unwrap_or(3.0);
        Some(run_rate_from_skill_and_burden(run_skill, burden))
    }

    /// The run-SKILL value the composition feeds to the formula: the wire
    /// `Current` plus [`run_skill_augmentation_bonus`] (MOVE-RUNRATE-105
    /// fix B), folded through the gated exhaustion arm.
    ///
    /// The augmentation terms are added AFTER the wire `current` — which
    /// already carries `derive_skill_value`'s enchantment multiplier — so
    /// this reproduces ACE's `CreatureSkill.Current` ordering exactly for
    /// the JackOfAllTrades and SkilledSpec terms (ACE adds both after the
    /// multiplier too, `CreatureSkill.cs:180-185`). `LumAugAllSkills` is
    /// ACE's `GetAugBonus_Base`, i.e. INSIDE the multiplier; we add it
    /// outside, which differs only for a player who both holds that
    /// luminance aug AND is under a multiplicative Run enchantment. Noted,
    /// not modelled — nothing in the movement suite exercises it, and the
    /// server-first lane above makes it moot whenever the wire is live.
    fn player_composed_run_skill(&self) -> Option<f32> {
        let run_skill = self.get_player_skill_current(SkillType::Run)? as f32
            + run_skill_augmentation_bonus(
                self.get_player_int_property(PropertyInt::LumAugAllSkills)
                    .unwrap_or(0),
                self.get_player_int_property(PropertyInt::AugmentationJackOfAllTrades)
                    .unwrap_or(0),
                self.get_player_int_property(PropertyInt::LumAugSkilledSpec)
                    .unwrap_or(0),
                self.get_player_skill_is_specialized(SkillType::Run),
            );
        // A3-D2(a) exhaustion lane (2026-06-12): wire Stamina 0 →
        // exhausted rate 1.0, matching ACE's stamina==0 → runskill 0
        // chain (see [`USE_EXHAUSTION_RUN_RATE`]). Default-off.
        Some(if USE_EXHAUSTION_RUN_RATE {
            exhausted_run_skill(run_skill, self.get_player_vital_current(VitalType::Stamina))
        } else {
            run_skill
        })
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

        // MOVE-RUNRATE-105 (2026-08-11): mirrors `player_run_rate()`'s order —
        // server rate first, then the composition ([`player_composed_run_skill`],
        // which folds the augmentation terms and the gated exhaustion arm).
        // Quickness is still REPORTED for the capture diff, never consumed.
        let server_run_rate = self.get_player_server_run_rate();
        let run_skill_used = self.player_composed_run_skill();
        // ORACLE open defect #1 — the two fields that make the NEXT capture
        // decisive instead of suggestive. See the struct docs.
        let aug_joat = self.get_player_int_property(PropertyInt::AugmentationJackOfAllTrades);
        let player_entity_present = self
            .get_player_guid()
            .and_then(|guid| self.get_entity(guid))
            .is_some();
        let run_skill_source = match (server_run_rate, run_skill_used) {
            (Some(_), _) => RunSkillSource::ServerRunRate,
            (None, Some(_)) => RunSkillSource::WireRunSkill,
            (None, None) => RunSkillSource::Unavailable,
        };

        let burden = self.player_burden().unwrap_or(3.0);
        RunRateInputs {
            run_rate: server_run_rate
                .or_else(|| run_skill_used.map(|s| run_rate_from_skill_and_burden(s, burden))),
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
            server_run_rate,
            run_skill_aug_bonus: run_skill_augmentation_bonus(
                self.get_player_int_property(PropertyInt::LumAugAllSkills)
                    .unwrap_or(0),
                self.get_player_int_property(PropertyInt::AugmentationJackOfAllTrades)
                    .unwrap_or(0),
                self.get_player_int_property(PropertyInt::LumAugSkilledSpec)
                    .unwrap_or(0),
                self.get_player_skill_is_specialized(SkillType::Run),
            ),
            aug_joat,
            player_entity_present,
        }
    }

    /// The `bPK` input for `PlayerState::jump_stamina_cost` — retail
    /// `CACQualities::JumpStaminaCost`'s predicate over the local
    /// player's wire properties (acclient.c:442887-442905; see
    /// [`pk_jump_stamina_arm`]). `now_seconds` must be UNIX seconds —
    /// the domain ACE writes `LastPkAttackTimestamp` in
    /// (Player_Combat.cs:998) — NOT `WorldState::current_server_time`,
    /// which is the PortalYearTicks packet clock once TimeSync is
    /// delivered (P4.2 F3). Both properties ride
    /// the ordinary property-update lane onto the player entity;
    /// absence resolves non-PK exactly like retail's failed inquiry.
    fn player_pk_jump_stamina_arm(&self, now_seconds: f64) -> bool {
        pk_jump_stamina_arm(
            self.get_player_int_property(PropertyInt::PlayerKillerStatus),
            self.get_player_float_property(PropertyFloat::LastPkAttackTimestamp),
            now_seconds,
        )
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

    /// True when the equipped missile weapon is an ammo launcher (bow /
    /// crossbow / atlatl — non-zero `PublicWeenieDesc.ammo_type`, the
    /// wire mirror of ACE `WorldObject.IsAmmoLauncher`) and nothing is
    /// equipped in the MISSILE_AMMO slot. Thrown weapons carry
    /// `ammo_type == 0` (self-launched) and never trip this.
    ///
    /// Mirrors the server gate in ACE
    /// `Player_Combat.cs::HandleActionChangeCombatMode_Inner` (Missile
    /// arm): launcher + no equipped ammo → ACE briefly enters the
    /// missile stance, then bounces to NonCombat with the transient
    /// string "You are out of ammunition!". Checking locally lets the
    /// client refuse the doomed round-trip with immediate feedback,
    /// like retail's client-side combat-readiness checks
    /// (`ClientCombatSystem::PlayerInReadyPosition` family).
    fn is_missing_missile_ammo(&self) -> bool {
        let mut launcher_needs_ammo = false;
        let mut has_ammo = false;
        for guid in self.iter_equipment() {
            if let Some(entity) = self.get_entity(guid) {
                let loc = entity.wield_location();
                if loc.intersects(EquipMask::MISSILE_WEAPON)
                    && entity.ammo_type().unwrap_or(0) != 0
                {
                    launcher_needs_ammo = true;
                }
                if loc.intersects(EquipMask::MISSILE_AMMO) {
                    has_ammo = true;
                }
            }
        }
        launcher_needs_ammo && !has_ammo
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
        exhausted_run_skill, pk_jump_stamina_arm, run_rate_from_skill_and_burden,
        run_rate_from_skill_and_burden_with_edge,
    };
    use crate::entity::{Entity, EntityMotionSnapshot};
    use crate::stats::{AttributeType, SkillType, VitalType};
    use holtburger_common::Guid;
    use holtburger_common::position::WorldPosition;
    use holtburger_common::properties::EquipMask;
    use holtburger_common::properties::{
        ItemType, PropertyBool, PropertyFloat, PropertyInstanceId, PropertyInt, Usable,
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
        player_float_properties: Vec<(PropertyFloat, f64)>,
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

        fn get_player_float_property(&self, prop: PropertyFloat) -> Option<f64> {
            self.player_float_properties
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

    /// Dossier row 36 — the 800-skill special case differs per source:
    /// retail `MovementSystem::GetRunRate` (acclient.c:713790) spikes at
    /// `== 800` EXACTLY and 801+ returns to the formula; ACE
    /// (`MovementSystem.cs:24`) plateaus `>= 800`. Both arms locked at
    /// 799/800/801; the default wrapper follows [`RETAIL_RUNRATE_EDGE`]
    /// (false = ACE).
    #[test]
    fn run_rate_800_edge_ace_plateau_vs_retail_spike() {
        let formula = |skill: f32| (1.0 * (skill / (skill + 200.0) * 11.0) + 4.0) / 4.0;

        // ACE arm (retail_edge = false): plateau from 800 up.
        assert_eq!(
            run_rate_from_skill_and_burden_with_edge(799.0, 0.0, false),
            formula(799.0)
        );
        assert_eq!(
            run_rate_from_skill_and_burden_with_edge(800.0, 0.0, false),
            4.5
        );
        assert_eq!(
            run_rate_from_skill_and_burden_with_edge(801.0, 0.0, false),
            4.5
        );

        // Retail arm (retail_edge = true): discontinuous == 800 spike,
        // 801 back on the formula (≈3.2005, nowhere near 4.5).
        assert_eq!(
            run_rate_from_skill_and_burden_with_edge(799.0, 0.0, true),
            formula(799.0)
        );
        assert_eq!(
            run_rate_from_skill_and_burden_with_edge(800.0, 0.0, true),
            4.5
        );
        let retail_801 = run_rate_from_skill_and_burden_with_edge(801.0, 0.0, true);
        assert_eq!(retail_801, formula(801.0));
        assert!(retail_801 < 3.3, "801 must NOT plateau: {retail_801}");

        // The default wrapper follows the shipped const (ACE arm).
        assert_eq!(
            run_rate_from_skill_and_burden(801.0, 0.0),
            run_rate_from_skill_and_burden_with_edge(801.0, 0.0, super::RETAIL_RUNRATE_EDGE)
        );
    }

    /// Dossier row 39 — the retail PK predicate for the jump stamina
    /// cost (acclient.c:442887-442905): PlayerKillerStatus ∈ {4, 64}
    /// AND `timeLastPKAttack + 20.0 > now`, with retail's failure
    /// defaults (status inquiry fail → pre-init 8; timestamp inquiry
    /// fail → non-PK).
    #[test]
    fn pk_jump_stamina_arm_matches_retail_predicate() {
        // Status gate: only 4 (PK) and 64 (PKLite) qualify.
        assert!(pk_jump_stamina_arm(Some(4), Some(100.0), 110.0));
        assert!(pk_jump_stamina_arm(Some(64), Some(100.0), 110.0));
        assert!(!pk_jump_stamina_arm(Some(8), Some(100.0), 110.0));
        assert!(!pk_jump_stamina_arm(Some(2), Some(100.0), 110.0));
        // Inquiry failures → retail defaults (status pre-init 8 /
        // timestamp arm skipped).
        assert!(!pk_jump_stamina_arm(None, Some(100.0), 110.0));
        assert!(!pk_jump_stamina_arm(Some(4), None, 110.0));
        // 20-second window is STRICT `>`: expires at exactly +20.
        assert!(pk_jump_stamina_arm(Some(4), Some(100.0), 119.999));
        assert!(!pk_jump_stamina_arm(Some(4), Some(100.0), 120.0));
        assert!(!pk_jump_stamina_arm(Some(4), Some(100.0), 200.0));
    }

    /// [`WorldContextExt::player_pk_jump_stamina_arm`] reads
    /// PlayerKillerStatus (int 134) + LastPkAttackTimestamp (float 145)
    /// off the player context — the caller-side composition of the
    /// row-39 predicate.
    #[test]
    fn player_pk_jump_stamina_arm_reads_wire_properties() {
        let mut world = TestWorld {
            player_guid: Some(Guid(1)),
            ..TestWorld::default()
        };
        assert!(
            !world.player_pk_jump_stamina_arm(100.0),
            "no properties → non-PK"
        );

        world
            .player_int_properties
            .push((PropertyInt::PlayerKillerStatus, 4));
        assert!(
            !world.player_pk_jump_stamina_arm(100.0),
            "PK status without a recent attack timestamp → non-PK"
        );

        world
            .player_float_properties
            .push((PropertyFloat::LastPkAttackTimestamp, 90.0));
        assert!(world.player_pk_jump_stamina_arm(100.0));
        assert!(!world.player_pk_jump_stamina_arm(115.0), "window expired");
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

    /// ORACLE open defect #1 (2026-08-11) — the two fields that make the next
    /// capture decisive.
    ///
    /// Session 3's per-tick provenance read `composed 1.9467213` on all 233
    /// ticks of `run-hold-long` while the login-time snapshot of the same
    /// `RunRateInputs` reported `run_skill_aug_bonus: 5`. 1.9467213 is
    /// arithmetically `run_skill == 105.000` at `load_mod 1.0`
    /// (`(1·(105/305·11)+4)/4`), so the augmentation term was EXACTLY zero at
    /// run time — but four scalars could not say whether the property had gone
    /// or the whole player entity had.
    ///
    /// The split that makes those different failures: skills and attributes
    /// live on `PlayerState`, int properties live on the player ENTITY. An
    /// entity that disappears therefore reads as "no augmentations" while the
    /// Run skill keeps composing perfectly — the exact observed shape.
    #[test]
    fn run_rate_inputs_discriminate_absent_entity_from_absent_augmentation() {
        let player_guid = Guid(0x5000_0001);
        // Run 105 + Strength 100 + empty inventory = the oracle rig's char.
        let rig = || TestWorld {
            player_guid: Some(player_guid),
            player_attributes: HashMap::from([(AttributeType::StrengthAttr, 100)]),
            player_skills: HashMap::from([(SkillType::Run, 105)]),
            ..Default::default()
        };

        // (a) The MEASURED state: no augmentation reaches the movement lane.
        // Reproduces `composed` to the f32 bit.
        let bare = rig();
        let i = bare.player_run_rate_inputs();
        assert_eq!(i.run_skill_used, Some(105.0));
        assert_eq!(i.run_skill_aug_bonus, 0.0);
        assert_eq!(i.aug_joat, None, "raw read says the property is ABSENT");
        assert_eq!(
            bare.player_composed_run_rate(),
            Some(1.946_721_3),
            "the exact number session 3 saw on all 233 ticks"
        );

        // (b) Property present on a live entity — what login measured.
        let mut augmented = rig();
        augmented.entities.insert(player_guid, entity(player_guid, "agentp09"));
        augmented
            .player_int_properties
            .push((PropertyInt::AugmentationJackOfAllTrades, 1));
        let i = augmented.player_run_rate_inputs();
        assert_eq!(i.aug_joat, Some(1));
        assert_eq!(i.run_skill_aug_bonus, 5.0);
        assert_eq!(i.run_skill_used, Some(110.0));
        assert!(i.player_entity_present);
        assert!(i.to_json().contains("\"aug_joat\":1"));
        assert!(i.to_json().contains("\"player_entity_present\":true"));

        // (c) The two failure shapes are now TELLABLE APART. Both compose 105
        // and both report `run_skill_aug_bonus: 0`; only these fields differ.
        //   entity gone      → player_entity_present false
        let gone = rig(); // no entity inserted
        let i_gone = gone.player_run_rate_inputs();
        assert!(!i_gone.player_entity_present);
        assert_eq!(i_gone.aug_joat, None);
        //   entity live, property not in the bag → present true, aug_joat null
        let mut live_no_prop = rig();
        live_no_prop
            .entities
            .insert(player_guid, entity(player_guid, "agentp09"));
        let i_live = live_no_prop.player_run_rate_inputs();
        assert!(i_live.player_entity_present);
        assert_eq!(i_live.aug_joat, None);
        assert!(i_live.to_json().contains("\"player_entity_present\":true"));
        assert!(i_live.to_json().contains("\"aug_joat\":null"));
        // ... and the thing they have in common is exactly what the last
        // capture could see, which is why it could not choose between them.
        assert_eq!(i_gone.run_skill_used, i_live.run_skill_used);
        assert_eq!(i_gone.run_skill_aug_bonus, i_live.run_skill_aug_bonus);
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
