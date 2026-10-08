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

/// A fellowship join/leave/dismiss/disband notice. fellowship-2 (2026-10-08
/// follow-ups): each variant carries the context retail's client-side
/// `gmFellowshipUI` strings need, captured BEFORE the state change (the
/// leader, who is leader, the fellowship name) — see [`Self::retail_text`].
#[derive(Debug, Clone)]
pub enum FellowshipActivity {
    YouJoined {
        fellowship_name: String,
        /// The leader's name (`None` when the leader is not a known member).
        leader_name: Option<String>,
        self_is_leader: bool,
        open: bool,
    },
    MemberJoined {
        member_name: String,
    },
    YouLeft {
        /// The fellowship you left (`None` when none was known).
        fellowship_name: Option<String>,
    },
    MemberLeft {
        member_name: String,
    },
    YouWereDismissed {
        leader_name: Option<String>,
    },
    MemberWasDismissed {
        member_name: String,
        self_is_leader: bool,
    },
    FellowshipDisbanded {
        fellowship_name: Option<String>,
        leader_name: Option<String>,
        self_is_leader: bool,
    },
}

impl FellowshipActivity {
    /// fellowship-2 (2026-10-08 follow-ups): retail's client-side chat line
    /// for this notice (`gmFellowshipUI`, acclient.c:203000-203223 and
    /// `RecvNotice_FellowshipUpdate` :203573-203648), without the trailing
    /// newline. `None` where retail prints nothing (a disband / your own
    /// quit with no fellowship known — `if ( m_pFellowship )` guards).
    ///
    /// The recruit line is `L"... %hs fellowship, %hs fellowship led by
    /// %hs.\n"` with `L"an open"` / `L"a closed"` passed to the middle `%hs`
    /// slot (:203636-203644). `PStringBase<unsigned short>`'s formatted ctor
    /// is `__vsnwprintf` (:188655-188664), where `%hs` reads a NARROW string,
    /// so the wide literal stops after its first byte: retail displayed
    /// "a fellowship led by". That is what we print.
    ///
    /// Non-retail fallbacks (retail would dereference a missing fellow):
    /// a recruit line or a dismissal / disband with no known leader.
    pub fn retail_text(&self) -> Option<String> {
        let leader = |name: &Option<String>| name.clone().filter(|n| !n.is_empty());
        Some(match self {
            Self::YouJoined {
                fellowship_name,
                leader_name,
                self_is_leader,
                ..
            } => {
                if *self_is_leader {
                    format!("You have created the Fellowship of {fellowship_name}.")
                } else if let Some(leader_name) = leader(leader_name) {
                    format!(
                        "You have been recruited into the {fellowship_name} fellowship, a fellowship led by {leader_name}."
                    )
                } else {
                    format!("You have been recruited into the {fellowship_name} fellowship.")
                }
            }
            Self::MemberJoined { member_name } => {
                format!("{member_name} is now a member of your Fellowship.")
            }
            Self::YouLeft { fellowship_name } => {
                let fellowship_name = fellowship_name.as_ref()?;
                format!("You are no longer a member of the {fellowship_name} Fellowship.")
            }
            Self::MemberLeft { member_name } => format!("{member_name} has left your Fellowship."),
            Self::YouWereDismissed { leader_name } => match leader(leader_name) {
                Some(leader_name) => format!("{leader_name} has dismissed you from the Fellowship."),
                None => "You have been dismissed from the Fellowship.".to_string(),
            },
            Self::MemberWasDismissed {
                member_name,
                self_is_leader,
            } => {
                if *self_is_leader {
                    format!("You dismiss {member_name} from your Fellowship.")
                } else {
                    format!("{member_name} has been dismissed from the Fellowship.")
                }
            }
            Self::FellowshipDisbanded {
                fellowship_name,
                leader_name,
                self_is_leader,
            } => {
                fellowship_name.as_ref()?;
                if *self_is_leader {
                    "You have disbanded your Fellowship.".to_string()
                } else if let Some(leader_name) = leader(leader_name) {
                    format!("{leader_name} has disbanded your Fellowship.")
                } else {
                    "Your Fellowship has been disbanded.".to_string()
                }
            }
        })
    }
}

#[cfg(test)]
mod fellowship_retail_text_tests {
    use super::FellowshipActivity as FA;

    fn text(activity: FA) -> Option<String> {
        activity.retail_text()
    }

    /// acclient.c:203618 / :203642 (`RecvNotice_FellowshipUpdate`).
    #[test]
    fn join_lines_follow_who_leads() {
        assert_eq!(
            text(FA::YouJoined {
                fellowship_name: "Raid Bus".into(),
                leader_name: Some("Player".into()),
                self_is_leader: true,
                open: true,
            })
            .as_deref(),
            Some("You have created the Fellowship of Raid Bus.")
        );
        assert_eq!(
            text(FA::YouJoined {
                fellowship_name: "Raid Bus".into(),
                leader_name: Some("Bravo".into()),
                self_is_leader: false,
                open: false,
            })
            .as_deref(),
            Some("You have been recruited into the Raid Bus fellowship, a fellowship led by Bravo.")
        );
        assert_eq!(
            text(FA::MemberJoined {
                member_name: "Bravo".into()
            })
            .as_deref(),
            Some("Bravo is now a member of your Fellowship.")
        );
    }

    /// acclient.c:203165 / :203187 (`FellowQuit`), :203084 / :203115 /
    /// :203121 (`FellowDismissed`), :203025 / :203033 (`FellowshipDisbanded`).
    #[test]
    fn departure_lines_match_retail() {
        assert_eq!(
            text(FA::YouLeft {
                fellowship_name: Some("Raid Bus".into())
            })
            .as_deref(),
            Some("You are no longer a member of the Raid Bus Fellowship.")
        );
        assert_eq!(
            text(FA::MemberLeft {
                member_name: "Bravo".into()
            })
            .as_deref(),
            Some("Bravo has left your Fellowship.")
        );
        assert_eq!(
            text(FA::YouWereDismissed {
                leader_name: Some("Alpha".into())
            })
            .as_deref(),
            Some("Alpha has dismissed you from the Fellowship.")
        );
        assert_eq!(
            text(FA::MemberWasDismissed {
                member_name: "Bravo".into(),
                self_is_leader: true
            })
            .as_deref(),
            Some("You dismiss Bravo from your Fellowship.")
        );
        assert_eq!(
            text(FA::MemberWasDismissed {
                member_name: "Bravo".into(),
                self_is_leader: false
            })
            .as_deref(),
            Some("Bravo has been dismissed from the Fellowship.")
        );
        assert_eq!(
            text(FA::FellowshipDisbanded {
                fellowship_name: Some("Raid Bus".into()),
                leader_name: Some("Player".into()),
                self_is_leader: true
            })
            .as_deref(),
            Some("You have disbanded your Fellowship.")
        );
        assert_eq!(
            text(FA::FellowshipDisbanded {
                fellowship_name: Some("Raid Bus".into()),
                leader_name: Some("Alpha".into()),
                self_is_leader: false
            })
            .as_deref(),
            Some("Alpha has disbanded your Fellowship.")
        );
    }

    /// Retail prints nothing without a fellowship (`if ( m_pFellowship )`).
    #[test]
    fn no_fellowship_no_line() {
        assert_eq!(
            text(FA::YouLeft {
                fellowship_name: None
            }),
            None
        );
        assert_eq!(
            text(FA::FellowshipDisbanded {
                fellowship_name: None,
                leader_name: None,
                self_is_leader: false
            }),
            None
        );
    }
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
    /// A3-D3 (2026-06-12, unified movement pipeline STAGE 3): the FULL
    /// decoded movement event for a REMOTE entity's `UpdateMotion` /
    /// `PositionAndMovementEvent`, emitted UNCONDITIONALLY per message —
    /// retail's `MovementManager::unpack_movement` preamble
    /// (cancel_moveto + unstick, acclient.c:339518-339519) is per-unpack,
    /// not change-gated, so the change-gated
    /// [`WorldEvent::EntityMotionUpdated`] above is deliberately NOT the
    /// vehicle. The local player's lane stays
    /// [`WorldEvent::SelfServerControlledMotion`] (its
    /// accepted-&&-!autonomous gate is load-bearing — ACE echoes the
    /// originator on every accepted move, Player_Networking.cs:365; an
    /// unconditional preamble would cancel-moveto/unstick the local
    /// player on every echo), so the emit sites skip the local guid.
    /// Consumer: `MovementSystem::apply_movement_world_events`, gated by
    /// the default-off `USE_UNPACK_MOVEMENT_SEMANTICS` const.
    ///
    /// `target_exists` is computed at emit time (`state.entities` lookup
    /// for the MoveToObject / TurnToObject target — core cannot see
    /// world entities at the consumer layer). A3-D3 driver (M4.3):
    /// `object_radius`/`object_height` are the case-6 target physics
    /// dims, resolved at the SAME emit site (retail
    /// `CPhysicsObj::MoveToObject` reads
    /// `CPartArray::GetRadius/GetHeight` with 0.0 fallback,
    /// acclient.c:319808-319817) — additive fields, 0.0-safe.
    EntityMovementEvent {
        guid: Guid,
        data: Box<MovementEventData>,
        target_exists: bool,
        object_radius: f32,
        object_height: f32,
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
    // A3-D3 driver (M4.3): the local lane now carries a REAL
    // `target_exists` + the case-6 target dims (closing the documented
    // `false` placeholder the registry consumer used to substitute),
    // resolved at the emit site exactly like `EntityMovementEvent`'s.
    SelfServerControlledMotion {
        data: Box<MovementEventData>,
        target_exists: bool,
        object_radius: f32,
        object_height: f32,
    },
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
    /// Wave C / PR8 (2026-06-06): a wielded entity's
    /// `PropertyInstanceId::Wielder` transitioned from NULL (or a
    /// different wielder) to a non-NULL wielder. Emitted by
    /// `state::mutations::apply_instance_id_side_effect` when it
    /// observes the transition. `new_wielder_guid` is the wielder GUID
    /// the item was just bound to. JS consumes this as ClientEvent
    /// kind=49 to drive PaperdollViewport + the 3D world rig wielded-
    /// children attach pass without re-scanning property state.
    EntityAttached {
        entity_guid: u32,
        new_wielder_guid: u32,
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
