use crate::book::BookData;
use crate::entity::{Entity, EntityMotionSnapshot};
use crate::spatial::{RuntimeBodyResetCause, SpatialBodyId};
use crate::state;
use crate::stats;
use crate::vendor;
use holtburger_common::Guid;
use holtburger_common::position::WorldPosition;
use holtburger_common::properties::PropertyUpdate;
use holtburger_protocol::errors::WeenieError;
use holtburger_protocol::messages::MovementEventData;
use holtburger_protocol::messages::magic::Enchantment;

/// Phase 6 step E: client-facing door open/closed flag derived from
/// the entity's `PhysicsState::ETHEREAL` bit. ACE's `Door.cs` sets
/// `Ethereal = true` on `Open()` and `false` on `Close()`, broadcasting
/// the new state via `GameMessageSetState` (mirrored here on
/// [`WorldEvent::EntityStateUpdated`]). A door with the `DOOR`
/// `ObjectDescriptionFlag` and ETHEREAL set is open; without ETHEREAL,
/// closed. ACE's `Locked` semantics collapse to `Closed` for the
/// client's purposes — locked doors are still solid.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DoorState {
    Closed,
    Open,
}

#[derive(Debug, Clone)]
pub struct PlayerInfoData {
    /// Authoritative world/entity snapshot for the local player.
    pub entity: Box<Entity>,
    pub attributes: Vec<stats::Attribute>,
    pub vitals: Vec<stats::Vital>,
    pub skills: Vec<stats::Skill>,
    pub enchantments: Vec<Enchantment>,
    pub spells: Vec<u32>,
    pub level_info: stats::CharacterLevelInfo,
    pub resistances: stats::Resistances,
    pub armor: i32,
    pub vitae: f32,
    pub inventory: std::collections::HashSet<Guid>,
    pub equipment: std::collections::HashMap<Guid, holtburger_protocol::messages::EquipMask>,
}

#[derive(Debug, Clone)]
pub struct DerivedStatsData {
    pub attributes: Vec<stats::Attribute>,
    pub vitals: Vec<stats::Vital>,
    pub skills: Vec<stats::Skill>,
    pub resistances: stats::Resistances,
    pub armor: i32,
    pub vitae: f32,
}

#[derive(Debug, Clone)]
pub enum FellowshipActivity {
    YouJoined { fellowship_name: String },
    MemberJoined { member_name: String },
    YouLeft,
    MemberLeft { member_name: String },
    YouWereDismissed,
    MemberWasDismissed { member_name: String },
    FellowshipDisbanded { fellowship_name: Option<String> },
}

#[derive(Debug, Clone)]
pub enum WorldEvent {
    EntitySpawned(Box<Entity>),
    EntityReplaced(Box<Entity>),
    EntityHealthUpdated {
        guid: Guid,
        health_fraction: f32,
    },
    EntityBookUpdated {
        guid: Guid,
        book: Box<BookData>,
    },
    EntityMoved {
        guid: Guid,
        pos: WorldPosition,
    },
    EntityIdentified(Box<Entity>),
    EntityVectorUpdated {
        guid: Guid,
        velocity: holtburger_common::math::Vector3,
        omega: holtburger_common::math::Vector3,
    },
    EntityMotionUpdated {
        guid: Guid,
        snapshot: Option<EntityMotionSnapshot>,
    },
    RuntimeBodyChanged {
        body_id: SpatialBodyId,
    },
    RuntimeBodyRemoved {
        body_id: SpatialBodyId,
    },
    RuntimeBodiesReset {
        cause: RuntimeBodyResetCause,
    },
    EntityDespawned(Guid),
    /// === Wave 6 polish — vitalChanged oldValue (2026-05-28) ===
    ///
    /// `prev_current` carries the vital's `current` value BEFORE the
    /// mutation, when the emit site is able to capture it. ACPlugin's
    /// `Character.OnVitalChanged` (Character.cs:125-129 + the
    /// `VitalChangedEventArgs` carrier at `VitalChangedEventArgs.cs:13-35`)
    /// surfaces `int OldValue` to consumers — combat heuristics
    /// (dodge-incoming-blow telemetry, regen-rate tracking) depend on
    /// the delta, not just the new value. Pre-Wave-6-polish the recv
    /// loop discarded the old value because the mutation site overwrites
    /// the vital cache before lib.rs's per-event scan sees it.
    ///
    /// `None` when the emit site doesn't have a pre-mutation snapshot
    /// (e.g. initial-spawn vital hydrate before `vitals` is populated,
    /// or paths that synthesise a full Vital without going through the
    /// in-place mutation). JS consumers must treat `None` as "delta
    /// unavailable" — the legacy single-value path is still correct.
    VitalUpdated {
        vital: stats::Vital,
        prev_current: Option<u32>,
    },
    AttributeUpdated(stats::Attribute),
    SkillUpdated(stats::Skill),
    LevelInfoUpdated(stats::CharacterLevelInfo),
    PropertiesUpdated {
        guid: Guid,
        updates: Vec<PropertyUpdate>,
    },
    PlayerInfo(Box<PlayerInfoData>),
    PlayerEnchantmentsUpdated {
        enchantments: Vec<Enchantment>,
    },
    PlayerGroundedUpdated {
        grounded: bool,
    },
    SelfUpdatePosition {
        teleport_sequence: u16,
        force_position_sequence: u16,
    },
    SelfAutonomousPosition {
        teleport_sequence: u16,
        force_position_sequence: u16,
        server_control_sequence: u16,
    },
    SpellUpdated {
        spell_id: u32,
        name: Option<String>,
        spell_ids: Vec<u32>,
    },
    SpellRemoved {
        spell_id: u32,
        spell_ids: Vec<u32>,
    },
    CombatModeUpdated(holtburger_protocol::messages::combat::CombatMode),
    ServerTimeUpdate(f64),
    TeleportStarted {
        sequence: u16,
    },
    DerivedStatsUpdated(Box<DerivedStatsData>),
    EntityStateUpdated {
        guid: Guid,
        physics_state: holtburger_common::properties::PhysicsState,
    },
    /// Phase 6 step E: an entity flagged as a door
    /// (`ObjectDescriptionFlag::DOOR`) flipped its open/closed state.
    /// Derived from the ETHEREAL bit on a `SetStateData` update — open
    /// doors are ethereal, closed doors are not. Emitted alongside
    /// `EntityStateUpdated` rather than replacing it; the recv loop
    /// uses this event to forward a kind=15 ClientEvent to JS, which
    /// rotates the door GfxObj sprite around its hinge frame and
    /// toggles the door's AABB entry between active/inactive in the
    /// `building_aabb_index`.
    DoorStateChanged {
        guid: Guid,
        state: crate::events::DoorState,
    },
    /// An entity's draw-gate flipped: `Entity::should_draw()` returned
    /// a different value than the previous tick. Derived from changes
    /// to `PhysicsState::HIDDEN`, `NO_DRAW`, or `CLOAKED` — see
    /// `acclient.h` enum `PhysicsState` and the gates ACE applies in
    /// `Source/ACE.Server/Physics/PhysicsObj.cs` (17 references to
    /// `Hidden`, 11 to `NoDraw`, 8 to `Cloaked`).
    ///
    /// Emitted from `apply_set_state_update` on every transition AND
    /// from `upsert_entity_from_create` for any entity whose initial
    /// state has `should_draw() == false` (so the render path is told
    /// to hide it before the first frame). JS-side handler in
    /// `apps/holtburger-web/index.html` toggles
    /// `EntityInstance.root.visible`.
    EntityVisibilityChanged {
        guid: Guid,
        visible: bool,
    },
    // Keep the full protocol payload for now: a future 3D client will likely need
    // richer server-authored movement detail than the current core/TUI consumer.
    SelfServerControlledMotion(Box<MovementEventData>),
    ForcedReposition {
        guid: Guid,
        pos: WorldPosition,
        sequence: u16,
    },
    WeenieError {
        error: WeenieError,
    },
    WeenieErrorWithString {
        error: WeenieError,
        parameter: String,
    },
    UseDone {
        error: WeenieError,
    },
    ContainerOpened(Guid),
    ContainerClosed(Guid),
    VendorStateUpdated(Option<vendor::VendorState>),
    VendorItemIdentified(Box<vendor::CoreVendorItem>),
    FellowshipStateUpdated(Option<state::FellowshipState>),
    FellowshipActivity(FellowshipActivity),
    TradeStateUpdated(Option<state::TradeState>),
    /// CMT Wave 10 / Phase 31 (2026-05-26): ACE broadcast a
    /// `GameMessageScript` (`PlayEffect = 0xF755`, constructor at
    /// `ACE.Server/Network/GameMessages/Messages/GameMessageScript.cs:9`)
    /// — a server-authored visual script (PlayScript::Launch /
    /// PlayScript::Explode / etc.) intended for the client's particle /
    /// overlay pipeline. Payload mirrors `PlayEffectData` 1:1
    /// (`target` GUID, `script_id` u32 = PlayScript enum, `speed` f32).
    ///
    /// **Wave 10 is wire-decode infrastructure only.** Wave 11 will wire
    /// the JS-side visual launch / explode VFX consumer (the recv loop
    /// will forward this `WorldEvent` to JS as a kind=? `ClientEvent`).
    /// Today the only consumer is the diag log in
    /// `handlers::system::handle_message` (`"PlayScript received: ..."`).
    /// PlayScript enum lives at `ACE.Entity/Enum/PlayScript.cs` — no JS
    /// mirror needed yet; JS will look up names by ID in Wave 11.
    PlayEffect {
        target: Guid,
        script_id: u32,
        speed: f32,
    },
    /// Wave A / PR1 (2026-06-06): a previously-wielded entity's
    /// `PropertyInstanceId::Wielder` transitioned from non-NULL to
    /// NULL. Emitted by `state::mutations::apply_instance_id_side_effect`
    /// when it observes the transition. `prior_wielder_guid` is the
    /// non-NULL wielder GUID observed before the mutation, pulled from
    /// `WorldState.prior_wielders`. PR8 will use this for symmetric
    /// local/remote dequip detach in the paperdoll UI without forcing
    /// the JS side to track prior wielders itself.
    EntityDetached {
        entity_guid: u32,
        prior_wielder_guid: u32,
    },
    /// Wave A / PR1 (2026-06-06): server-confirmed inventory-action
    /// rejection. Surfaces a `WeenieError` whose context is an
    /// inventory mutation (move / split / merge / wield). PR13 will
    /// consume this to display a transient error toast tied to the
    /// originating item GUID so the inventory panel can roll back any
    /// optimistic UI state. `item_guid` is 0 when the rejection cannot
    /// be tied back to a specific entity.
    InventoryActionFailed {
        item_guid: u32,
        weenie_error_code: u32,
    },
}
