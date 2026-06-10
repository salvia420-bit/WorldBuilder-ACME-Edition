use holtburger_common::Guid;
use holtburger_common::properties::{
    EnchantmentTypeFlags, EquipMask, PropertyFloat, PropertyInt, PropertyInt64, PropertyString,
    WorldObjectExt as _, WorldObjectPropertyAccessors, WorldObjectPropertyAccessorsMut,
};
use holtburger_content::SoulEmoteCatalog;
use holtburger_dat::file_type::{MotionKinematics, SkillTable, XpTable};
use holtburger_protocol::messages::GameMessage;
use holtburger_protocol::messages::combat::CombatMode;
use std::sync::Arc;

use crate::entity::{Entity, EntityManager};
use crate::player::PlayerState;
use crate::spatial::{BasicSpatialPhysics, SpatialPhysics, SpatialScene};
use crate::spell::{SpellCatalog, SpellInfo};
use crate::state::fellowship::FellowshipState;
use crate::state::liveness::EntityLifecycleStore;
use crate::state::self_movement::SelfMovementCapabilities;
use crate::state::trade::TradeState;
use crate::stats;
use crate::vendor::VendorState;
use crate::{WorldBootstrap, WorldEvent};

pub struct ServerTimeSync {
    pub server_time: f64,
    pub local_time: web_time::Instant,
}

/// F4-4 (bughunt 2026-06-09) — true for a `CellLandblock` terrain TYPE code
/// (5-bit, 0..31) that is water. Matches the renderer's `TERRAIN_WATER_CODES`
/// {16,17,18,19,20,22,23} (the `Water*` / `FauxWater*` terrain types; code 21
/// is excluded). Used to classify per-vertex water for the EntirelyWater
/// walk-block.
fn is_water_terrain_code(code: u8) -> bool {
    matches!(code & 0x1f, 16 | 17 | 18 | 19 | 20 | 22 | 23)
}

/// The authoritative state of the game world.
///
/// `WorldState` owns entity/spatial/trade/vendor state plus the invariants that tie those systems
/// together. Protocol routing itself lives in `crate::handlers`; `WorldState::handle_message()` is
/// just the stable facade used by callers such as `holtburger-core`.
///
/// NOTE: The player `Entity` is the authoritative holder of player world/object state.
/// `self.player` only owns local-player/session overlays such as sequencing, stat caches,
/// enchantments, inventory/equipment indices, and related derived-state bookkeeping.
/// Live local runtime motion is world-owned through `SpatialScene`, which composes
/// shared body-sampling state without exposing it as an app-facing projection surface.
///
/// !!! CRITICAL !!!
/// Use `set_player_*` and related authoritative world mutation helpers for server-confirmed
/// player updates and reconciliation. Use the runtime-body helpers for routine local simulation.
/// Hand-writing to `self.entities` or scene body state directly will break the
/// authority/runtime split and is not allowed.
pub struct WorldState {
    pub entities: EntityManager,
    pub player: PlayerState,
    pub server_time: Option<ServerTimeSync>,
    pub xp_table: Arc<XpTable>,
    pub skill_table: Arc<SkillTable>,
    pub spell_catalog: Arc<SpellCatalog>,
    pub soul_emote_catalog: Arc<SoulEmoteCatalog>,
    pub motion_kinematics: Arc<MotionKinematics>,
    pub scene: SpatialScene,
    pub vendor: Option<VendorState>,
    pub fellowship: Option<FellowshipState>,
    pub trade: Option<TradeState>,
    pub open_containers: std::collections::HashSet<Guid>,
    /// Per-landblock terrain heightmap cache (9×9 vertex grid per
    /// landblock, 24 m vertex spacing, value in metres). Keyed by
    /// landblock id (the high 16 bits of `cell_id`, e.g. `0xA9B40000`
    /// for Holtburg). Populated lazily by the wasm bundle as the
    /// player enters new landblocks; consulted by the manual-drive
    /// integrator (`MovementSystem::advance_local_pose_for_manual_drive`)
    /// to snap pose Z to terrain — without this, the integrator's
    /// constant-Z output causes ACE physics (FastTick) to apply false
    /// gravity, simulating the player as floating above terrain and
    /// applying impact damage on landing.
    ///
    /// Storage is `[f32; 81]` indexed by `vx * 9 + vy` mirroring
    /// `holtburger_dat::landblock::CellLandblock::get_height` —
    /// values are already in metres (the dat-side `* 2.0` is applied
    /// at populate time, not at lookup).
    pub(crate) terrain_heights: std::collections::HashMap<u32, [f32; 81]>,
    /// F4-4 (bughunt 2026-06-09) — per-vertex "is water terrain" flag for the
    /// outdoor walkable solver, keyed by landblock id. Same `[_; 81]` layout
    /// (`vx * 9 + vy`) as `terrain_heights`; derived at populate time from the
    /// `CellLandblock` per-vertex terrain TYPE codes (water types 16-20/22/23,
    /// matching the renderer's `TERRAIN_WATER_CODES`). Read by
    /// [`WorldState::is_entirely_water_cell_at`] so the integrator can refuse
    /// to walk into a fully-water 24 m cell (ACE `LandCell.FindEnvCollisions`
    /// EntirelyWater => Collided). Empty for LBs whose codes weren't sent.
    pub(crate) terrain_water: std::collections::HashMap<u32, [bool; 81]>,
    /// Cylsphere radius for each loaded SetupModel id (`0x02xxxxxx`),
    /// in metres. Populated by the wasm bundle via
    /// [`WorldState::register_setup_radius`] as the renderer loads
    /// SetupModel DAT records (`apps/holtburger-web/src/lib.rs` →
    /// `SetupModel::unpack`). Read by the manual-drive integrator
    /// when building [`crate::spatial::EntityCollider`] records to
    /// size each entity's collision cylinder. ACE's analog is
    /// `PhysicsObj.GetPhysicsRadius` in `ACE.Server/Physics/PhysicsObj.cs`
    /// which pulls `PartArray.GetCylSphere()[0].Radius * Scale`.
    ///
    /// We use the first cyl-sphere radius when available, falling
    /// back to the SetupModel `.radius` field. Misses fall back to
    /// the player capsule radius (a reasonable default for unknown
    /// humanoid-scale entities).
    pub(crate) setup_radii: std::collections::HashMap<u32, f32>,
    pub(crate) entity_lifecycle: EntityLifecycleStore,
    pub(crate) self_movement_capabilities_override: Option<SelfMovementCapabilities>,
    /// Wave A / PR1 (2026-06-06): item GUID → prior wielder GUID. Used
    /// by `apply_instance_id_side_effect` to detect `Wielder` transitions
    /// from non-NULL to NULL and emit `WorldEvent::EntityDetached` with
    /// the prior wielder. Populated when a non-NULL Wielder is observed;
    /// pruned when the entry's Wielder is observed transitioning to NULL
    /// OR when the entity is deleted (inventory.rs ObjectDelete handler).
    /// No explicit cap — entries are bounded by the entities map size
    /// because each entry corresponds to exactly one live entity and is
    /// pruned on entity delete.
    pub(crate) prior_wielders: std::collections::HashMap<u32, u32>,
}

impl WorldState {
    pub fn player_entity(&self) -> Option<&Entity> {
        let guid = self.player.guid;
        (guid != Guid::NULL)
            .then(|| self.entities.get(guid))
            .flatten()
    }

    pub fn player_entity_mut(&mut self) -> Option<&mut Entity> {
        let guid = self.player.guid;
        (guid != Guid::NULL)
            .then(|| self.entities.get_mut(guid))
            .flatten()
    }

    pub fn player_position(&self) -> Option<holtburger_common::position::WorldPosition> {
        self.player_entity().map(|entity| entity.position)
    }

    pub fn player_landblock(&self) -> Option<Guid> {
        self.player_position()
            .map(|position| position.landblock_id)
            .filter(|landblock| *landblock != Guid::NULL)
    }

    pub fn player_properties(
        &self,
    ) -> Option<&holtburger_common::properties::WorldObjectProperties> {
        self.player_entity().map(|entity| &entity.properties)
    }

    #[cfg(any(test, feature = "test-support"))]
    pub fn seed_local_player_entity(
        &mut self,
        guid: Guid,
        name: impl Into<String>,
        position: holtburger_common::position::WorldPosition,
    ) {
        self.player.guid = guid;
        self.add_entity(Entity::new(guid, name.into(), position));
    }

    pub fn player_int_property(&self, property: PropertyInt) -> Option<i32> {
        self.player_properties()
            .and_then(|properties| properties.get_int_prop(property))
    }

    pub fn player_int64_property(&self, property: PropertyInt64) -> Option<i64> {
        self.player_properties()
            .and_then(|properties| properties.get_int64_prop(property))
    }

    pub fn player_float_property(&self, property: PropertyFloat) -> Option<f64> {
        self.player_properties()
            .and_then(|properties| properties.get_float_prop(property))
    }

    pub fn player_string_property(&self, property: PropertyString) -> Option<&str> {
        self.player_properties()
            .and_then(|properties| properties.get_string_prop(property))
    }

    pub fn player_level(&self) -> u32 {
        self.player_int_property(PropertyInt::Level).unwrap_or(0) as u32
    }

    pub fn player_total_experience(&self) -> u64 {
        self.player_int64_property(PropertyInt64::TotalExperience)
            .unwrap_or(0) as u64
    }

    pub fn player_available_experience(&self) -> u64 {
        self.player_int64_property(PropertyInt64::AvailableExperience)
            .unwrap_or(0) as u64
    }

    pub fn player_unspent_skill_points(&self) -> u32 {
        self.player_int_property(PropertyInt::AvailableSkillCredits)
            .unwrap_or(0) as u32
    }

    pub fn player_available_luminance(&self) -> u64 {
        self.player_int64_property(PropertyInt64::AvailableLuminance)
            .unwrap_or(0) as u64
    }

    pub fn player_combat_mode(&self) -> CombatMode {
        // F11-6: ACE never persists/describes CombatMode — it only pushes
        // PropertyInt::CombatMode on a mode CHANGE, so it is absent at
        // login and after a relog-while-in-combat. Treat absent as
        // NonCombat (retail's resting state) rather than mapping the 0
        // fallback through `from_repr` to CombatMode::Undef, which leaks an
        // un-toggled Undef to any caller that gates on combat mode.
        match self.player_int_property(PropertyInt::CombatMode) {
            Some(value) => {
                CombatMode::from_repr(value as u32).unwrap_or(CombatMode::NonCombat)
            }
            None => CombatMode::NonCombat,
        }
    }

    pub fn player_name(&self) -> &str {
        self.player_string_property(PropertyString::Name)
            .unwrap_or("Unknown")
    }

    pub fn player_armor(&self) -> i32 {
        let base_armor = self
            .player_int_property(PropertyInt::ArmorLevel)
            .unwrap_or(0);
        i32::max(
            -400,
            crate::magic::get_enchanted_armor(base_armor, &self.player.enchantments),
        )
    }

    pub fn player_vitae(&self) -> f32 {
        self.player.vitae()
    }

    fn player_resistance_augmentation(&self, prop: PropertyFloat) -> i32 {
        let augmentation_prop = match prop {
            PropertyFloat::ResistSlash => PropertyInt::AugmentationResistanceSlash,
            PropertyFloat::ResistPierce => PropertyInt::AugmentationResistancePierce,
            PropertyFloat::ResistBludgeon => PropertyInt::AugmentationResistanceBlunt,
            PropertyFloat::ResistFire => PropertyInt::AugmentationResistanceFire,
            PropertyFloat::ResistCold => PropertyInt::AugmentationResistanceFrost,
            PropertyFloat::ResistAcid => PropertyInt::AugmentationResistanceAcid,
            PropertyFloat::ResistElectric => PropertyInt::AugmentationResistanceLightning,
            PropertyFloat::ResistNether => PropertyInt::AugmentationResistanceNether,
            _ => return 0,
        };

        self.player_int_property(augmentation_prop).unwrap_or(0)
    }

    pub fn player_resistance_current(&self, prop: PropertyFloat) -> f32 {
        let base = self.player_float_property(prop).unwrap_or(1.0) as f32;
        let strength_base = self
            .player
            .get_attribute_base(crate::stats::AttributeType::StrengthAttr);
        let endurance_base = self
            .player
            .get_attribute_base(crate::stats::AttributeType::EnduranceAttr);
        let augmentation_resistance = self.player_resistance_augmentation(prop);

        crate::magic::get_player_enchanted_resistance(
            base,
            &self.player.enchantments,
            prop as u32,
            strength_base,
            endurance_base,
            augmentation_resistance,
        )
    }

    pub fn player_resistances(&self) -> stats::Resistances {
        stats::Resistances {
            slash: self.player_resistance_current(PropertyFloat::ResistSlash),
            pierce: self.player_resistance_current(PropertyFloat::ResistPierce),
            bludgeon: self.player_resistance_current(PropertyFloat::ResistBludgeon),
            fire: self.player_resistance_current(PropertyFloat::ResistFire),
            cold: self.player_resistance_current(PropertyFloat::ResistCold),
            acid: self.player_resistance_current(PropertyFloat::ResistAcid),
            electric: self.player_resistance_current(PropertyFloat::ResistElectric),
            nether: self.player_resistance_current(PropertyFloat::ResistNether),
        }
    }

    /// Phase 4 step 3.7 — exposed `pub` so the wasm recv loop can call
    /// it after hydrating the player from PlayerDescription. Body is
    /// unchanged from the original `pub(crate)` version.
    pub fn emit_player_derived_stats(&mut self, events: &mut Vec<WorldEvent>) {
        self.player.refresh_cached_derived_stat_inputs();

        let current = crate::player::types::LastSentStats {
            attributes: self.player.attribute_snapshot(),
            vitals: self.player.vital_snapshot(),
            skills: self.player.skill_snapshot(),
            resistances: self.player_resistances(),
            armor: self.player_armor(),
            vitae: self.player_vitae(),
        };

        if self.player.last_emitted_derived_stats.as_ref() == Some(&current) {
            return;
        }

        self.player.last_emitted_derived_stats = Some(current.clone());
        events.push(WorldEvent::DerivedStatsUpdated(Box::new(
            crate::DerivedStatsData {
                attributes: current.attributes,
                vitals: current.vitals,
                skills: current.skills,
                resistances: current.resistances,
                armor: current.armor,
                vitae: current.vitae,
            },
        )));
    }

    /// Stable public entry point for applying a decoded game message to world state.
    ///
    /// Feature handlers own the orchestration order; this method preserves the external API while
    /// keeping routing separate from the state model itself.
    pub fn handle_message(&mut self, msg: &GameMessage) -> Vec<WorldEvent> {
        let mut events = Vec::new();
        crate::handlers::handle_message(self, msg, &mut events);
        events
    }

    pub fn set_server_time_sync(
        &mut self,
        server_time: f64,
        local_time: web_time::Instant,
    ) -> Vec<WorldEvent> {
        self.server_time = Some(ServerTimeSync {
            server_time,
            local_time,
        });
        vec![WorldEvent::ServerTimeUpdate(server_time)]
    }

    pub fn get_level_info(&self) -> stats::CharacterLevelInfo {
        let table = &self.xp_table;
        let level = self.player_level();
        let total_xp = self.player_total_experience();
        let unspent_xp = self.player_available_experience();

        let level_idx = level as usize;
        let next_level_idx = level_idx + 1;

        if next_level_idx >= table.character_level_xp_list.len() {
            // Already max level
            let level_xp = *table.character_level_xp_list.get(level_idx).unwrap_or(&0);
            return stats::CharacterLevelInfo {
                level,
                current_xp: total_xp,
                unspent_xp,
                unspent_skill_points: self.player_unspent_skill_points(),
                available_luminance: self.player_available_luminance(),
                next_level_xp: level_xp,
                xp_into_level: total_xp.saturating_sub(level_xp),
                xp_for_next_level: 0,
            };
        }

        let level_xp = table.character_level_xp_list[level_idx];
        let next_level_xp = table.character_level_xp_list[next_level_idx];

        stats::CharacterLevelInfo {
            level,
            current_xp: total_xp,
            unspent_xp,
            unspent_skill_points: self.player_unspent_skill_points(),
            available_luminance: self.player_available_luminance(),
            next_level_xp,
            xp_into_level: total_xp.saturating_sub(level_xp),
            xp_for_next_level: next_level_xp.saturating_sub(level_xp),
        }
    }

    pub fn resolve_spell_name(&self, spell_id: u32) -> Option<String> {
        self.spell_catalog
            .resolve_name(spell_id)
            .map(str::to_string)
    }

    pub fn resolve_spell_info(&self, spell_id: u32) -> Option<SpellInfo> {
        self.spell_catalog.get(spell_id).cloned()
    }

    pub fn get_player_enchanted_int(&self, key: PropertyInt) -> i32 {
        let base = self
            .player_entity()
            .and_then(|e| e.get_int_prop(key))
            .unwrap_or(0);

        if key == PropertyInt::ArmorLevel {
            crate::magic::get_enchanted_armor(base, &self.player.enchantments)
        } else {
            let mult = crate::magic::get_enchantment_multiplier(
                &self.player.enchantments,
                EnchantmentTypeFlags::INT.bits(),
                key as u32,
            );
            let add = crate::magic::get_enchantment_additive(
                &self.player.enchantments,
                EnchantmentTypeFlags::INT.bits(),
                key as u32,
            );
            ((base as f32 * mult) + add).round() as i32
        }
    }

    pub fn get_player_enchanted_float(&self, key: PropertyFloat) -> f32 {
        if matches!(
            key,
            PropertyFloat::ResistSlash
                | PropertyFloat::ResistPierce
                | PropertyFloat::ResistBludgeon
                | PropertyFloat::ResistFire
                | PropertyFloat::ResistCold
                | PropertyFloat::ResistAcid
                | PropertyFloat::ResistElectric
                | PropertyFloat::ResistNether
        ) {
            return self.player_resistance_current(key);
        }

        let base = self
            .player_entity()
            .and_then(|e| e.get_float_prop(key))
            .map(|f| f as f32)
            .unwrap_or(1.0);

        crate::magic::get_enchanted_resistance(base, &self.player.enchantments, key as u32)
    }

    pub fn new(bootstrap: Arc<WorldBootstrap>) -> Self {
        Self::new_with_spatial_physics(bootstrap, Arc::new(BasicSpatialPhysics))
    }

    pub fn new_with_spatial_physics(
        bootstrap: Arc<WorldBootstrap>,
        spatial_physics: Arc<dyn SpatialPhysics>,
    ) -> Self {
        Self {
            entities: EntityManager::new(),
            player: PlayerState::new(),
            server_time: None,
            xp_table: Arc::clone(&bootstrap.xp_table),
            skill_table: Arc::clone(&bootstrap.skill_table),
            spell_catalog: bootstrap.spell_catalog(),
            soul_emote_catalog: Arc::clone(&bootstrap.soul_emote_catalog),
            motion_kinematics: Arc::clone(&bootstrap.motion_kinematics),
            scene: SpatialScene::new_with_physics(spatial_physics),
            vendor: None,
            fellowship: None,
            trade: None,
            open_containers: std::collections::HashSet::new(),
            terrain_heights: std::collections::HashMap::new(),
            terrain_water: std::collections::HashMap::new(),
            setup_radii: std::collections::HashMap::new(),
            entity_lifecycle: EntityLifecycleStore::default(),
            self_movement_capabilities_override: None,
            prior_wielders: std::collections::HashMap::new(),
        }
    }

    /// Install a 9×9 height grid for the given landblock. Caller is
    /// responsible for converting raw u8 dat values to metres
    /// (multiply by 2.0). Idempotent — overwrites the previous entry
    /// for `landblock_id`. Layout matches
    /// `holtburger_dat::landblock::CellLandblock::get_height`:
    /// `idx = vx * 9 + vy` with vertex spacing 24 m.
    ///
    /// `landblock_id` is the high 16 bits of a cell id shifted up
    /// (e.g. `0xA9B40000` for Holtburg) — same convention as
    /// `WorldPosition::landblock_id` packs into.
    pub fn populate_terrain_heights(&mut self, landblock_id: u32, heights: [f32; 81]) {
        self.terrain_heights.insert(landblock_id, heights);
    }

    /// F4-4 (bughunt 2026-06-09) — cache the per-vertex water-terrain flags for
    /// a landblock from its `CellLandblock` terrain TYPE codes (one byte per
    /// 9×9 vertex, range 0..31). A code is water iff it is one of the renderer's
    /// `TERRAIN_WATER_CODES` {16,17,18,19,20,22,23} (ACE/retail terrain types
    /// `Water*` / `FauxWater*`). No-op when `codes.len() != 81` (fail-soft: the
    /// LB simply has no water data and never blocks).
    pub fn populate_terrain_water(&mut self, landblock_id: u32, codes: &[u8]) {
        if codes.len() != 81 {
            return;
        }
        let mut water = [false; 81];
        for (i, &c) in codes.iter().enumerate() {
            water[i] = is_water_terrain_code(c);
        }
        self.terrain_water.insert(landblock_id, water);
    }

    /// F4-4 — true when world-frame `(x, y)` sits inside a fully-water 24 m
    /// terrain cell (all four corner vertices are water terrain). Mirrors ACE
    /// `LandCell.get_block_water_type() == EntirelyWater`, which makes the cell
    /// a hard wall for walkers (`FindEnvCollisions` returns `Collided`). Returns
    /// `false` when the landblock's water grid isn't cached (don't block on
    /// missing data) and for partially-water cells (the wading-depth contact-
    /// plane raise is a documented follow-on).
    pub fn is_entirely_water_cell_at(&self, world_x: f32, world_y: f32) -> bool {
        const LB_M: f32 = 192.0;
        const VERT_M: f32 = 24.0;
        if !world_x.is_finite() || !world_y.is_finite() {
            return false;
        }
        let lb_x = (world_x / LB_M).floor() as i32;
        let lb_y = (world_y / LB_M).floor() as i32;
        if !(0..256).contains(&lb_x) || !(0..256).contains(&lb_y) {
            return false;
        }
        let landblock_id = ((lb_x as u32) << 24) | ((lb_y as u32) << 16);
        let Some(water) = self.terrain_water.get(&landblock_id) else {
            return false;
        };
        let local_x = world_x - lb_x as f32 * LB_M;
        let local_y = world_y - lb_y as f32 * LB_M;
        let cx0 = (local_x / VERT_M).clamp(0.0, 8.0).floor() as usize;
        let cy0 = (local_y / VERT_M).clamp(0.0, 8.0).floor() as usize;
        let cx1 = (cx0 + 1).min(8);
        let cy1 = (cy0 + 1).min(8);
        // EntirelyWater ⇔ all four corner vertices of the cell are water.
        water[cx0 * 9 + cy0]
            && water[cx1 * 9 + cy0]
            && water[cx0 * 9 + cy1]
            && water[cx1 * 9 + cy1]
    }

    /// Cache a SetupModel's collision radius. Called by the wasm
    /// bundle when it loads a `0x02xxxxxx` SetupModel — the first
    /// cyl-sphere's radius, or the SetupModel `.radius` field as a
    /// fallback. Read by the manual-drive integrator to size each
    /// entity's collision cylinder per ACE's
    /// `PhysicsObj.GetPhysicsRadius` pattern.
    pub fn register_setup_radius(&mut self, setup_id: u32, radius: f32) {
        if radius.is_finite() && radius > 0.0 {
            self.setup_radii.insert(setup_id, radius);
        }
    }

    /// Best-known collision cylinder radius for an entity, in metres.
    /// Returns the cached SetupModel cyl-sphere radius when the
    /// entity's `gfx_id` is a `0x02xxxxxx` SetupModel and has been
    /// loaded; otherwise falls back to
    /// [`crate::spatial::PLAYER_CAPSULE_RADIUS`].
    ///
    /// Mirrors ACE's `PhysicsObj.GetPhysicsRadius` at
    /// `Source/ACE.Server/Physics/PhysicsObj.cs:~590`. ACE returns
    /// `0.0` for `HasPhysicsBSP` entities (caller uses BSP path
    /// instead); we don't follow that today because the BSP path
    /// isn't wired — see the TODO in
    /// `crate::spatial::entity_collision`.
    pub fn entity_collision_radius(&self, entity: &Entity) -> f32 {
        const DEFAULT: f32 = crate::spatial::PLAYER_CAPSULE_RADIUS;
        let Some(gfx_id) = entity.gfx_id else {
            return DEFAULT;
        };
        // SetupModel ids are 0x02xxxxxx; GfxObj ids are 0x01xxxxxx.
        // Cylinder radii live in the SetupModel; raw GfxObj entities
        // don't expose a cylinder so they fall through to the
        // default.
        if (gfx_id >> 24) != 0x02 {
            return DEFAULT;
        }
        self.setup_radii.get(&gfx_id).copied().unwrap_or(DEFAULT)
    }

    /// Number of landblocks currently cached. Diagnostic only;
    /// used by the wasm bundle's `PopulateTerrain` recv arm to log
    /// progress as the spawn-area neighbourhood lands.
    pub fn terrain_height_cache_len(&self) -> usize {
        self.terrain_heights.len()
    }

    /// Workstream C (3D camera collision, 2026-05-11): clone the
    /// terrain heightmap cache for the camera-side shadow. Called by
    /// the wasm bundle's recv-loop on each TickMovement to refresh the
    /// JS-readable shadow `SessionHandle.terrain_heights_shadow` reads
    /// to back the `terrainHeightAt(x, y)` export. The HashMap is
    /// shallow-cloned (the value type is `[f32; 81]` which is Copy),
    /// so cost is O(num_loaded_landblocks) — for Holtburg's 9-LB ring
    /// that's effectively free.
    pub fn terrain_heights_snapshot(&self) -> std::collections::HashMap<u32, [f32; 81]> {
        self.terrain_heights.clone()
    }

    /// Bilinear-interpolate the terrain height at the given world-frame
    /// `(x, y)` against the cached 9×9 grid for the containing landblock.
    /// Returns `None` if the landblock isn't in the cache (caller falls
    /// back to "preserve current pose Z").
    ///
    /// World-frame: x is east, y is north, both in metres. Landblock
    /// origin is at `(lb_x_byte * 192, lb_y_byte * 192)`. Within an LB
    /// the 9×9 grid covers `[0, 192]` on each axis at 24 m spacing.
    pub fn terrain_height_at(&self, world_x: f32, world_y: f32) -> Option<f32> {
        const LB_M: f32 = 192.0;
        const VERT_M: f32 = 24.0;
        if !world_x.is_finite() || !world_y.is_finite() {
            return None;
        }
        // Identify landblock + intra-LB coords. `floor_div` semantics
        // so negative world coords (rare but possible at ocean/edge)
        // still resolve correctly.
        let lb_x = (world_x / LB_M).floor() as i32;
        let lb_y = (world_y / LB_M).floor() as i32;
        if !(0..256).contains(&lb_x) || !(0..256).contains(&lb_y) {
            return None;
        }
        let landblock_id = ((lb_x as u32) << 24) | ((lb_y as u32) << 16);
        let grid = self.terrain_heights.get(&landblock_id)?;

        let local_x = world_x - lb_x as f32 * LB_M;
        let local_y = world_y - lb_y as f32 * LB_M;
        let cell_x = (local_x / VERT_M).clamp(0.0, 8.0);
        let cell_y = (local_y / VERT_M).clamp(0.0, 8.0);
        let cx0 = cell_x.floor() as usize;
        let cy0 = cell_y.floor() as usize;
        let cx1 = (cx0 + 1).min(8);
        let cy1 = (cy0 + 1).min(8);
        let fx = cell_x - cx0 as f32;
        let fy = cell_y - cy0 as f32;
        // Layout matches CellLandblock: idx = vx * 9 + vy.
        let z00 = grid[cx0 * 9 + cy0];
        let z10 = grid[cx1 * 9 + cy0];
        let z01 = grid[cx0 * 9 + cy1];
        let z11 = grid[cx1 * 9 + cy1];
        let z = z00 * (1.0 - fx) * (1.0 - fy)
            + z10 * fx * (1.0 - fy)
            + z01 * (1.0 - fx) * fy
            + z11 * fx * fy;
        Some(z)
    }

    /// F4-2 (bughunt 2026-06-09) — terrain surface NORMAL (unit, AC z-up) at
    /// world-frame `(x, y)`, for the outdoor walkable-slope gate. `None` when
    /// the containing landblock isn't cached (caller falls back to "treat as
    /// walkable / preserve behaviour").
    ///
    /// Retail/ACE refuse to walk onto a terrain polygon whose plane normal
    /// `z < PhysicsGlobals.FloorZ` (`0.664174`, ~48.4° from horizontal) and
    /// slide instead (`LandCell.FindEnvCollisions` → `ObjectInfo.is_valid_walkable`).
    /// Our grounded outdoor path previously snapped Z onto ANY rise, so cliffs
    /// were freely climbable. This surfaces the local slope so the integrator
    /// can apply the cutoff.
    ///
    /// Derivation: the analytic gradient of the SAME bilinear height field
    /// [`Self::terrain_height_at`] samples (∂z/∂x, ∂z/∂y over the 24 m cell),
    /// giving `normal = normalize(-∂z/∂x, -∂z/∂y, 1)`. This matches the
    /// walkable cutoff exactly at the boundary (a 48.4° slope ⇒ |grad| =
    /// tan 48.4° = 1.126 ⇒ normal.z = 0.664 = FloorZ) and is monotonic with
    /// steepness, so the gate decision is faithful. The per-cell triangle
    /// SPLIT direction (which the gradient averages over) only shifts the
    /// classification within a hair of the boundary on mixed cells — a
    /// fidelity refinement, not the exploit; documented as a follow-on.
    pub fn terrain_normal_at(&self, world_x: f32, world_y: f32) -> Option<holtburger_common::Vector3> {
        const LB_M: f32 = 192.0;
        const VERT_M: f32 = 24.0;
        if !world_x.is_finite() || !world_y.is_finite() {
            return None;
        }
        let lb_x = (world_x / LB_M).floor() as i32;
        let lb_y = (world_y / LB_M).floor() as i32;
        if !(0..256).contains(&lb_x) || !(0..256).contains(&lb_y) {
            return None;
        }
        let landblock_id = ((lb_x as u32) << 24) | ((lb_y as u32) << 16);
        let grid = self.terrain_heights.get(&landblock_id)?;

        let local_x = world_x - lb_x as f32 * LB_M;
        let local_y = world_y - lb_y as f32 * LB_M;
        let cell_x = (local_x / VERT_M).clamp(0.0, 8.0);
        let cell_y = (local_y / VERT_M).clamp(0.0, 8.0);
        let cx0 = cell_x.floor() as usize;
        let cy0 = cell_y.floor() as usize;
        let cx1 = (cx0 + 1).min(8);
        let cy1 = (cy0 + 1).min(8);
        let fx = cell_x - cx0 as f32;
        let fy = cell_y - cy0 as f32;
        let z00 = grid[cx0 * 9 + cy0];
        let z10 = grid[cx1 * 9 + cy0];
        let z01 = grid[cx0 * 9 + cy1];
        let z11 = grid[cx1 * 9 + cy1];
        // Bilinear partials in cell units, converted to m/m (÷ VERT_M).
        let dzdx = ((z10 - z00) * (1.0 - fy) + (z11 - z01) * fy) / VERT_M;
        let dzdy = ((z01 - z00) * (1.0 - fx) + (z11 - z10) * fx) / VERT_M;
        let n = holtburger_common::Vector3::new(-dzdx, -dzdy, 1.0);
        let len = (n.x * n.x + n.y * n.y + n.z * n.z).sqrt();
        if !len.is_finite() || len <= f32::EPSILON {
            return Some(holtburger_common::Vector3::new(0.0, 0.0, 1.0));
        }
        Some(holtburger_common::Vector3::new(n.x / len, n.y / len, n.z / len))
    }

    #[cfg(any(test, feature = "test-support"))]
    pub fn synthetic() -> Self {
        Self::synthetic_with_spatial_physics(Arc::new(BasicSpatialPhysics))
    }

    #[cfg(any(test, feature = "test-support"))]
    pub fn synthetic_with_spatial_physics(spatial_physics: Arc<dyn SpatialPhysics>) -> Self {
        Self::new_with_spatial_physics(Arc::new(WorldBootstrap::synthetic()), spatial_physics)
    }

    #[cfg(any(test, feature = "test-support"))]
    pub fn set_motion_kinematics(&mut self, motion_kinematics: MotionKinematics) {
        self.motion_kinematics = Arc::new(motion_kinematics);
    }

    pub fn current_server_time(&self) -> f64 {
        match &self.server_time {
            Some(sync) => {
                let elapsed = sync.local_time.elapsed().as_secs_f64();
                sync.server_time + elapsed
            }
            None => {
                // Fallback to wall clock if no sync yet. `web_time` re-exports
                // `std::time` on native and falls through to `Date.now()` on
                // wasm32-unknown-unknown where `std::time::SystemTime::now()`
                // hard-panics with "time not implemented on this platform".
                // Callers can reach this branch before the first
                // ServerTimeUpdate arrives (e.g. an entity spawn during the
                // login → in-world window); panicking collapses the recv loop
                // and the player gets stuck unable to move.
                web_time::SystemTime::now()
                    .duration_since(web_time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs_f64()
            }
        }
    }

    pub fn add_entity(&mut self, entity: Entity) {
        let guid = entity.guid;
        let pos = entity.position;
        let velocity = entity.velocity;
        let omega = entity.omega;

        self.entities.insert(entity);
        self.scene.update_entity(guid, pos.landblock_id, pos);
        self.reconcile_authoritative_body(
            guid,
            pos,
            velocity,
            omega,
            crate::spatial::AuthoritativeBodySync::Snapshot,
        );
    }

    pub fn remove_entity<G: Into<Guid> + Copy>(&mut self, guid: G) -> Option<Entity> {
        let guid = guid.into();
        if let Some(entity) = self.entities.remove(guid) {
            self.scene.remove_entity(guid, entity.position.landblock_id);
            self.retire_authoritative_body_for_guid(guid);
            self.entity_lifecycle.clear(guid);

            let dependent_guids: Vec<_> = self
                .entities
                .iter()
                .filter(|dependent| {
                    dependent.container_id() == Some(guid)
                        || dependent.wielder_id() == Some(guid)
                        || dependent.physics_parent_id == Some(guid)
                })
                .map(|dependent| dependent.guid)
                .collect();

            for dependent_guid in dependent_guids {
                let mut detached = false;
                let mut detached_wielder = false;

                if let Some(dependent) = self.entities.get_mut(dependent_guid) {
                    if dependent.container_id() == Some(guid) {
                        dependent.set_container_id(None);
                        detached = true;
                    }

                    if dependent.wielder_id() == Some(guid) {
                        dependent.set_wielder_id(None);
                        dependent.set_int_prop(
                            PropertyInt::CurrentWieldedLocation,
                            EquipMask::NONE.bits() as i32,
                        );
                        detached = true;
                        detached_wielder = true;
                    }

                    if dependent.physics_parent_id == Some(guid) {
                        dependent.physics_parent_id = None;
                        detached = true;
                    }
                }

                if detached_wielder {
                    let _ = self.clear_entity_world_presence(dependent_guid);
                }

                if detached {
                    self.sync_player_ownership_for_entity(dependent_guid);
                    let _ = self
                        .mark_entity_immediately_eligible_for_pruning_if_unretained(dependent_guid);
                }
            }

            Some(entity)
        } else {
            None
        }
    }
}
