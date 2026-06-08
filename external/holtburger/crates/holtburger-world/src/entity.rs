use crate::book::BookData;
use crate::hydration::WorldObjectPropertiesHydrationExt;
use crate::identify::{self, IdentifyTarget};
use holtburger_common::position::WorldPosition;
use holtburger_common::properties::{
    HasProperties, HasPropertiesMut, ObjectDescriptionFlag, PhysicsState, PropertyInstanceId,
    PropertyInt, PropertyString, PropertyUpdate, WeenieHeaderFlag, WeenieHeaderFlag2,
    WorldObjectProperties, WorldObjectPropertyAccessorsMut,
};
use holtburger_common::sequence::is_newer_u16;
use holtburger_common::{Guid, Vector3};
use holtburger_protocol::messages::MovementType;
use holtburger_protocol::messages::movement::messages::motion::{
    MoveToObject, MoveToPosition, MovementInvalid, TurnToHeading, TurnToObject,
};
use holtburger_protocol::messages::movement::{
    InterpretedMotionCommand, MotionItem, MotionStance, MovementEventData, MovementTypeData,
};
use holtburger_protocol::messages::object::events::IdentifyObjectResponseEventData;
use holtburger_protocol::messages::object::messages::description::ObjectDescriptionData;
use holtburger_protocol::messages::object::types::{
    ArmorLevels, ArmorProfile, CreatureProfile, HookProfile, WeaponProfile,
};
use holtburger_protocol::traits::ProtocolUnpack;
use std::collections::HashMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct EntityMotionSnapshot {
    pub current_style: Option<MotionStance>,
    pub forward_command: Option<InterpretedMotionCommand>,
    pub sidestep_command: Option<InterpretedMotionCommand>,
    pub turn_command: Option<InterpretedMotionCommand>,
    pub forward_speed: Option<OrderedMotionSpeed>,
    pub sidestep_speed: Option<OrderedMotionSpeed>,
    pub turn_speed: Option<OrderedMotionSpeed>,
    pub directive: Option<EntityMotionDirective>,
    /// Wave 2 (2026-06-08) — the newest Action-class command from the
    /// `UpdateMotion` action `commands` list, **already expanded to its
    /// full 32-bit `MotionCommand`** via
    /// [`crate::player::expand_motion_command_low16`]. This is the swing
    /// (B10 creature attacks) / eat-drink (B6) one-shot that rides in the
    /// action command list, distinct from the forward/sidestep/turn
    /// locomotion axes. `None` when the movement event carries no Action-
    /// class command. The renderer routes this through its one-shot link
    /// overlay (LoopOnce), never as a locomotion cycle.
    pub action_command: Option<u32>,
    /// 15-bit per-object action sequence (`MotionItem::sequence()`) of
    /// [`Self::action_command`], for the renderer's stamp-dedup (a
    /// repeated `UpdateMotion` carrying the same swing must not replay).
    /// `None` when no action command is present.
    pub action_sequence: Option<u16>,
    /// Per-motion playback speed (`MotionItem::speed`) of
    /// [`Self::action_command`], so a hasted/slowed swing or eat plays at
    /// the right tempo. `None` when no action command is present.
    pub action_speed: Option<OrderedMotionSpeed>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct OrderedMotionSpeed(u32);

impl OrderedMotionSpeed {
    pub fn from_f32(value: f32) -> Option<Self> {
        value.is_finite().then_some(Self(value.to_bits()))
    }

    pub const fn to_f32(self) -> f32 {
        f32::from_bits(self.0)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EntityMotionDirective {
    TurnToHeading {
        desired_heading: OrderedMotionSpeed,
        speed: OrderedMotionSpeed,
    },
    TurnToObject {
        target: Guid,
        desired_heading: Option<OrderedMotionSpeed>,
        speed: OrderedMotionSpeed,
    },
}

impl EntityMotionSnapshot {
    pub fn motion_command(self) -> Option<InterpretedMotionCommand> {
        self.forward_command
            .or(self.sidestep_command)
            .or(self.turn_command)
    }

    /// Wave 2 (2026-06-08) — pull the NEWEST Action-class command out of
    /// an `UpdateMotion` action `commands` list and return it expanded to
    /// its full 32-bit `MotionCommand`, with its 15-bit sequence + speed.
    ///
    /// "Action class" means the expanded value carries the attack
    /// (`0x10000000`) or use/emote (`0x40000000`) class bit — i.e. a swing
    /// (B10), an eat/drink (B6), or a gesture, NOT a locomotion cycle.
    /// Locomotion commands (Walk/Run/Stop/Ready/turn/sidestep) ride the
    /// dedicated forward/sidestep/turn axes, so we deliberately ignore any
    /// non-Action entry here to avoid double-driving the gait.
    ///
    /// "Newest" = the item with the highest 15-bit sequence under the
    /// retail half-range wrap compare (`is_newer_u16`), matching the
    /// per-object `server_action_stamp` ordering the renderer dedups on.
    /// In practice vanilla ACE packs a single action per `UpdateMotion`,
    /// but picking the newest is correct if it ever packs more.
    fn newest_action_command(commands: &[MotionItem]) -> Option<(u32, u16, f32)> {
        let mut best: Option<&MotionItem> = None;
        for item in commands {
            // Expand the low-16 to its full 32-bit value and keep it only
            // if it lands in an Action class (attack / use-emote). A miss
            // (None) is a command we don't model — skip it rather than
            // mis-driving the rig with a half-formed key.
            let Some(full) = crate::player::expand_motion_command_low16(item.command.raw()) else {
                continue;
            };
            // Keep it ONLY if it is a GENUINE one-shot action — an attack
            // swing (class 0x10, e.g. SlashHigh 0x1000005B / B10) or a
            // narrow USE command (class 0x40, low-16 0x16..0x1D, e.g. Eat
            // 0x4000001A / B6). The 0x40 class ALSO carries non-action
            // STATE commands (Stop 0x40000004, Fallen 0x40000008, Dead
            // 0x40000011, Falling 0x40000015) and aim/magic-gesture
            // substates — surfacing those here would drive the LOCAL
            // player's predicted gait off `KIND_MOTION_ACTION` (which has
            // NO local-guid skip) = the C1/B9 regression. The shared
            // `is_action_motion_command` predicate is the SINGLE source of
            // truth for "is an action", reused by every surfacing path.
            if !crate::player::is_action_motion_command(full) {
                continue;
            }
            best = match best {
                Some(prev) if !is_newer_u16(item.sequence(), prev.sequence()) => Some(prev),
                _ => Some(item),
            };
        }
        let item = best?;
        let full = crate::player::expand_motion_command_low16(item.command.raw())?;
        Some((full, item.sequence(), item.speed))
    }

    pub fn from_movement_event(data: &MovementEventData) -> Option<Self> {
        let mut snapshot = Self {
            current_style: MotionStance::from_interpreted(data.current_style),
            ..Self::default()
        };

        if let MovementTypeData::Invalid(invalid) = &data.data {
            // Wave 2 (2026-06-08, C4): surface the Action-class command
            // list for EVERY movement-type variant that carries an
            // `InterpretedMotionState` on the wire — so a creature swinging
            // (B10) or a local eat (B6) is not dropped. In this fork's wire
            // model the action `commands` list lives ONLY in the
            // `InterpretedMotionState` body, which (per
            // `MovementEventData::unpack` / ACE
            // `MovementManager.unpack_movement` `case 0`) is carried solely
            // by `MovementType::Invalid`. The server-pathed `MoveToObject`
            // / `MoveToPosition` / `TurnTo*` envelopes carry no command
            // list, so there is nothing to surface for them; the "attack
            // while moving" case arrives as a separate `Invalid`
            // `UpdateMotion` whose `commands` we read here. If a future
            // wire revision attaches a command list to another variant,
            // extend this match alongside it.
            if let Some((full, seq, speed)) =
                Self::newest_action_command(&invalid.state.commands)
            {
                snapshot.action_command = Some(full);
                snapshot.action_sequence = Some(seq);
                snapshot.action_speed = OrderedMotionSpeed::from_f32(speed);
            } else if let Some(forward) = invalid.state.forward_command
                && let Some(full) = crate::player::expand_motion_command_low16(forward.raw())
                && crate::player::is_action_motion_command(full)
            {
                // Wave 2 (2026-06-08, review B6) — Eat 0x4000001A / Drink
                // 0x4000001B carry the `CommandMask.SubState` (0x40000000)
                // bit, NOT the Action (0x10000000) bit, so on a stock ACE
                // server the eat path (`Player_Use.ApplyConsumable` ->
                // `EnqueueMotion_Force(NonCombat, Eat)` ->
                // `BroadcastMovement` `SetForwardCommand`) lands the eat in
                // the wire `forward_command` slot, NOT the `commands`
                // action list. Surface it here as the one-shot action so
                // B6 (the local player eating) actually fires. The SAME
                // narrow `is_action_motion_command` predicate guarantees
                // only the genuine use range is picked up — locomotion
                // (RunForward/WalkForward), stance (Ready/Crouch/Sit/Sleep),
                // and state (Stop/Fallen/Dead/Falling) flow through the
                // locomotion axis below, never onto the action overlay.
                //
                // No per-item stamp exists on `forward_command`, so we
                // dedup on the per-broadcast `movement_sequence` (the u16
                // ACE bumps each `UpdateMotion`). The lib.rs emit SUPPRESSES
                // this same use-command from the `KIND_MOTION` locomotion
                // `motion_command` so it plays on `KIND_MOTION_ACTION` ONLY
                // (no double-play for remote players, who DO drive their
                // gait off the server echo).
                snapshot.action_command = Some(full);
                snapshot.action_sequence = Some(data.movement_sequence);
                snapshot.action_speed = invalid
                    .state
                    .forward_speed
                    .and_then(OrderedMotionSpeed::from_f32);
            }
            if let Some(style) = invalid
                .state
                .current_style
                .and_then(MotionStance::from_interpreted)
            {
                snapshot.current_style = Some(style);
            }
            snapshot.forward_command = invalid.state.forward_command;
            snapshot.sidestep_command = invalid.state.sidestep_command;
            snapshot.turn_command = invalid.state.turn_command;
            snapshot.forward_speed = invalid
                .state
                .forward_speed
                .and_then(OrderedMotionSpeed::from_f32);
            snapshot.sidestep_speed = invalid
                .state
                .sidestep_speed
                .and_then(OrderedMotionSpeed::from_f32);
            snapshot.turn_speed = invalid
                .state
                .turn_speed
                .and_then(OrderedMotionSpeed::from_f32);
        } else if let MovementTypeData::TurnToHeading(turn) = &data.data {
            let desired_heading = OrderedMotionSpeed::from_f32(turn.params.desired_heading);
            let speed = OrderedMotionSpeed::from_f32(turn.params.speed);

            if let (Some(desired_heading), Some(speed)) = (desired_heading, speed) {
                snapshot.directive = Some(EntityMotionDirective::TurnToHeading {
                    desired_heading,
                    speed,
                });
            }
        } else if let MovementTypeData::TurnToObject(turn) = &data.data
            && let Some(speed) = OrderedMotionSpeed::from_f32(turn.params.speed)
        {
            snapshot.directive = Some(EntityMotionDirective::TurnToObject {
                target: turn.target,
                desired_heading: OrderedMotionSpeed::from_f32(turn.desired_heading),
                speed,
            });
        }

        let has_data = snapshot.current_style.is_some()
            || snapshot.forward_command.is_some()
            || snapshot.sidestep_command.is_some()
            || snapshot.turn_command.is_some()
            || snapshot.forward_speed.is_some()
            || snapshot.sidestep_speed.is_some()
            || snapshot.turn_speed.is_some()
            || snapshot.directive.is_some()
            // Wave 2 (2026-06-08): a movement event carrying ONLY an
            // Action-class swing/eat (no locomotion axis) must still yield
            // a snapshot so the action command reaches the renderer.
            || snapshot.action_command.is_some();

        has_data.then_some(snapshot)
    }

    pub fn from_object_description(data: &ObjectDescriptionData) -> Option<Self> {
        let movement_data = data.movement_data.as_deref()?;
        let mut offset = 0;
        let movement_type_raw = u8::unpack(movement_data, &mut offset)?;
        let movement_type = MovementType::from_repr(movement_type_raw)?;
        let motion_flags = u8::unpack(movement_data, &mut offset)?;
        let current_style = u16::unpack(movement_data, &mut offset)?;

        let payload = match movement_type {
            MovementType::MoveToObject => {
                MovementTypeData::MoveToObject(MoveToObject::unpack(movement_data, &mut offset)?)
            }
            MovementType::MoveToPosition => MovementTypeData::MoveToPosition(
                MoveToPosition::unpack(movement_data, &mut offset)?,
            ),
            MovementType::TurnToObject => {
                MovementTypeData::TurnToObject(TurnToObject::unpack(movement_data, &mut offset)?)
            }
            MovementType::TurnToHeading => {
                MovementTypeData::TurnToHeading(TurnToHeading::unpack(movement_data, &mut offset)?)
            }
            // Only MovementType::Invalid (0) carries an InterpretedMotionState body;
            // unpack_ext would over-read >=4 bytes for the stop/raw types (1-5),
            // which use the same `Invalid` data variant but an empty MovementInvalid
            // (consumes nothing). Mirrors the A5 fix in movement/messages/motion.rs.
            MovementType::Invalid => MovementTypeData::Invalid(
                MovementInvalid::unpack_ext(movement_data, &mut offset, motion_flags)?,
            ),
            MovementType::RawCommand
            | MovementType::InterpretedCommand
            | MovementType::StopRawCommand
            | MovementType::StopInterpretedCommand
            | MovementType::StopCompletely => {
                MovementTypeData::Invalid(MovementInvalid::default())
            }
        };

        Self::from_movement_event(&MovementEventData {
            guid: data.public_weenie_desc.guid,
            object_instance_sequence: data.sequences[OBJECT_INSTANCE_SEQUENCE_INDEX],
            movement_sequence: 0,
            server_control_sequence: data.sequences[OBJECT_SERVER_CONTROL_SEQUENCE_INDEX],
            is_autonomous: data.autonomous_movement.unwrap_or(false),
            movement_type,
            motion_flags,
            current_style,
            data: payload,
        })
    }

    pub fn indicates_death_motion(self) -> bool {
        self.motion_command()
            .is_some_and(InterpretedMotionCommand::is_dead)
    }
}

#[cfg(test)]
mod tests {
    use super::{EntityMotionSnapshot, MotionStance, MovementEventData, MovementTypeData};
    use holtburger_common::Guid;
    use holtburger_protocol::messages::MovementType;
    use holtburger_protocol::messages::movement::messages::motion::{
        TurnToHeading, TurnToObject, TurnToParameters,
    };

    #[test]
    fn turn_to_heading_with_non_finite_directive_preserves_other_snapshot_fields() {
        let snapshot = EntityMotionSnapshot::from_movement_event(&MovementEventData {
            guid: Guid(0x60000001),
            object_instance_sequence: 1,
            movement_sequence: 2,
            server_control_sequence: 3,
            is_autonomous: false,
            movement_type: MovementType::TurnToHeading,
            motion_flags: 0,
            current_style: MotionStance::NonCombat.interpreted(),
            data: MovementTypeData::TurnToHeading(TurnToHeading {
                params: TurnToParameters {
                    movement_parameters: 0,
                    speed: 1.5,
                    desired_heading: f32::NAN,
                },
            }),
        })
        .expect("expected current style to keep snapshot populated");

        assert_eq!(snapshot.current_style, Some(MotionStance::NonCombat));
        assert_eq!(snapshot.directive, None);
    }

    #[test]
    fn turn_to_object_with_non_finite_speed_preserves_other_snapshot_fields() {
        let snapshot = EntityMotionSnapshot::from_movement_event(&MovementEventData {
            guid: Guid(0x60000001),
            object_instance_sequence: 1,
            movement_sequence: 2,
            server_control_sequence: 3,
            is_autonomous: false,
            movement_type: MovementType::TurnToObject,
            motion_flags: 0,
            current_style: MotionStance::NonCombat.interpreted(),
            data: MovementTypeData::TurnToObject(TurnToObject {
                target: Guid(0x70000001),
                desired_heading: 0.25,
                params: TurnToParameters {
                    movement_parameters: 0,
                    speed: f32::NAN,
                    desired_heading: 0.25,
                },
            }),
        })
        .expect("expected current style to keep snapshot populated");

        assert_eq!(snapshot.current_style, Some(MotionStance::NonCombat));
        assert_eq!(snapshot.directive, None);
    }

    /// Wave 2 (2026-06-08) — a creature swing (SlashHigh) rides in the
    /// `UpdateMotion` action `commands` list, NOT in `forward_command`.
    /// `from_movement_event` must surface it on `action_command`, expanded
    /// to its full 32-bit value, with its sequence + speed — even when no
    /// locomotion axis is present (B10).
    #[test]
    fn invalid_movement_surfaces_newest_action_command_expanded() {
        use holtburger_protocol::messages::movement::messages::motion::MovementInvalid;
        use holtburger_protocol::messages::movement::types::{
            InterpretedMotionState, MotionItem,
        };

        let state = InterpretedMotionState {
            // Two items: an older Thrust and a newer SlashHigh; the newest
            // (highest sequence) must win.
            commands: vec![
                MotionItem::new(0x005Au16, 4, false, 1.0), // ThrustHigh, seq 4
                MotionItem::new(0x005Bu16, 7, false, 1.5), // SlashHigh, seq 7
            ],
            ..InterpretedMotionState::default()
        };
        let snapshot = EntityMotionSnapshot::from_movement_event(&MovementEventData {
            guid: Guid(0x50000001),
            object_instance_sequence: 1,
            movement_sequence: 2,
            server_control_sequence: 3,
            is_autonomous: false,
            movement_type: MovementType::Invalid,
            motion_flags: 0,
            current_style: MotionStance::NonCombat.interpreted(),
            data: MovementTypeData::Invalid(MovementInvalid {
                state,
                sticky_object: None,
            }),
        })
        .expect("an action-only UpdateMotion must still yield a snapshot");

        assert_eq!(
            snapshot.action_command,
            Some(0x1000_005B),
            "newest action (SlashHigh) must surface expanded to full 32-bit"
        );
        assert_eq!(snapshot.action_sequence, Some(7));
        assert_eq!(
            snapshot.action_speed.map(|s| s.to_f32()),
            Some(1.5),
            "action speed must carry through for tempo scaling"
        );
        // The locomotion axes stay untouched — the swing is not a gait.
        assert_eq!(snapshot.forward_command, None);
    }

    /// Wave 2 (2026-06-08) — Eat rides the action list as a `0x40000000`
    /// use-class one-shot (B6). It must surface expanded, and a non-Action
    /// command in the same list (e.g. RunForward) must be ignored here so
    /// the gait is not double-driven.
    #[test]
    fn invalid_movement_surfaces_eat_and_ignores_locomotion_in_command_list() {
        use holtburger_protocol::messages::movement::messages::motion::MovementInvalid;
        use holtburger_protocol::messages::movement::types::{
            InterpretedMotionState, MotionItem,
        };

        let state = InterpretedMotionState {
            commands: vec![
                MotionItem::new(0x0007u16, 9, false, 1.0), // RunForward (not Action)
                MotionItem::new(0x001Au16, 3, false, 1.0), // Eat (Action class)
            ],
            ..InterpretedMotionState::default()
        };
        let snapshot = EntityMotionSnapshot::from_movement_event(&MovementEventData {
            guid: Guid(0x50000002),
            object_instance_sequence: 1,
            movement_sequence: 2,
            server_control_sequence: 3,
            is_autonomous: false,
            movement_type: MovementType::Invalid,
            motion_flags: 0,
            current_style: MotionStance::NonCombat.interpreted(),
            data: MovementTypeData::Invalid(MovementInvalid {
                state,
                sticky_object: None,
            }),
        })
        .expect("an Eat action must yield a snapshot");

        assert_eq!(
            snapshot.action_command,
            Some(0x4000_001A),
            "Eat must surface as the 0x40000000 use-class command, ignoring RunForward"
        );
    }

    /// Wave 2 (2026-06-08, review C1) — a 0x40-class STATE command (Stop,
    /// low-16 0x04 → 0x40000004) sitting in the `commands` list must NOT be
    /// surfaced as an action. Surfacing it would emit it on
    /// `KIND_MOTION_ACTION` (which has no local-guid skip) and drive the
    /// LOCAL player's predicted-gait locomotion cycle — the C1/B9
    /// regression. A genuine Eat (0x1A) and a genuine attack (SlashHigh
    /// 0x5B) in the same list still ARE surfaced.
    #[test]
    fn invalid_movement_does_not_surface_substate_state_command_in_command_list() {
        use holtburger_protocol::messages::movement::messages::motion::MovementInvalid;
        use holtburger_protocol::messages::movement::types::{
            InterpretedMotionState, MotionItem,
        };

        // A Stop (0x04) STATE command alone in the list must yield NO action.
        let stop_only = InterpretedMotionState {
            commands: vec![MotionItem::new(0x0004u16, 5, false, 1.0)], // Stop, 0x40000004
            ..InterpretedMotionState::default()
        };
        let snapshot = EntityMotionSnapshot::from_movement_event(&MovementEventData {
            guid: Guid(0x5000_0003),
            object_instance_sequence: 1,
            movement_sequence: 2,
            server_control_sequence: 3,
            is_autonomous: false,
            movement_type: MovementType::Invalid,
            motion_flags: 0,
            current_style: MotionStance::NonCombat.interpreted(),
            data: MovementTypeData::Invalid(MovementInvalid {
                state: stop_only,
                sticky_object: None,
            }),
        });
        assert_eq!(
            snapshot.and_then(|s| s.action_command),
            None,
            "Stop (0x40000004) is a STATE command, never a one-shot action"
        );

        // Stop + Eat + SlashHigh together: only the genuine actions are
        // eligible; the newest of them (SlashHigh, seq 9) wins.
        let mixed = InterpretedMotionState {
            commands: vec![
                MotionItem::new(0x0004u16, 8, false, 1.0), // Stop (STATE) — ignored
                MotionItem::new(0x001Au16, 6, false, 1.0), // Eat (action)
                MotionItem::new(0x005Bu16, 9, false, 1.0), // SlashHigh (action, newest)
            ],
            ..InterpretedMotionState::default()
        };
        let snapshot = EntityMotionSnapshot::from_movement_event(&MovementEventData {
            guid: Guid(0x5000_0003),
            object_instance_sequence: 1,
            movement_sequence: 2,
            server_control_sequence: 3,
            is_autonomous: false,
            movement_type: MovementType::Invalid,
            motion_flags: 0,
            current_style: MotionStance::NonCombat.interpreted(),
            data: MovementTypeData::Invalid(MovementInvalid {
                state: mixed,
                sticky_object: None,
            }),
        })
        .expect("a list with genuine actions must yield a snapshot");
        assert_eq!(
            snapshot.action_command,
            Some(0x1000_005B),
            "the newest GENUINE action (SlashHigh) wins; Stop is never eligible"
        );
    }

    /// Wave 2 (2026-06-08, review B6) — Eat arrives in the wire
    /// `forward_command` slot on a stock ACE server (SubState bit, not the
    /// Action bit). `from_movement_event` must surface it on
    /// `action_command`. RunForward in `forward_command` (locomotion) must
    /// NOT be surfaced as an action, and stays on the locomotion axis.
    #[test]
    fn forward_command_eat_surfaces_as_action_runforward_stays_locomotion() {
        use holtburger_protocol::messages::movement::messages::motion::MovementInvalid;
        use holtburger_protocol::messages::movement::types::{
            InterpretedMotionCommand, InterpretedMotionState,
        };

        // Eat (0x1A) in forward_command → surfaced as action; the snapshot
        // still records forward_command verbatim (lib.rs suppresses it from
        // the locomotion emit, not the snapshot).
        let eat_fwd = InterpretedMotionState {
            forward_command: Some(InterpretedMotionCommand::from(0x001Au16)),
            ..InterpretedMotionState::default()
        };
        let snapshot = EntityMotionSnapshot::from_movement_event(&MovementEventData {
            guid: Guid(0x5000_0004),
            object_instance_sequence: 1,
            movement_sequence: 42,
            server_control_sequence: 3,
            is_autonomous: false,
            movement_type: MovementType::Invalid,
            motion_flags: 0,
            current_style: MotionStance::NonCombat.interpreted(),
            data: MovementTypeData::Invalid(MovementInvalid {
                state: eat_fwd,
                sticky_object: None,
            }),
        })
        .expect("an eat in forward_command must yield a snapshot");
        assert_eq!(
            snapshot.action_command,
            Some(0x4000_001A),
            "eat in forward_command must surface as the use-class action"
        );
        assert_eq!(
            snapshot.action_sequence,
            Some(42),
            "forward-command action dedups on movement_sequence"
        );

        // RunForward (0x07) in forward_command is locomotion — NOT an action.
        let run_fwd = InterpretedMotionState {
            forward_command: Some(InterpretedMotionCommand::RUN_FORWARD),
            ..InterpretedMotionState::default()
        };
        let snapshot = EntityMotionSnapshot::from_movement_event(&MovementEventData {
            guid: Guid(0x5000_0004),
            object_instance_sequence: 1,
            movement_sequence: 7,
            server_control_sequence: 3,
            is_autonomous: false,
            movement_type: MovementType::Invalid,
            motion_flags: 0,
            current_style: MotionStance::NonCombat.interpreted(),
            data: MovementTypeData::Invalid(MovementInvalid {
                state: run_fwd,
                sticky_object: None,
            }),
        })
        .expect("RunForward yields a locomotion snapshot");
        assert_eq!(
            snapshot.action_command, None,
            "RunForward is locomotion, never a one-shot action"
        );
        assert_eq!(
            snapshot.motion_command().map(|c| c.raw()),
            Some(0x0007),
            "RunForward stays on the locomotion forward axis"
        );
    }

    /// Wave 2 (2026-06-08, review B6) — co-pack: RunForward on the
    /// locomotion `forward_command` axis AND Eat in the `commands` action
    /// list. The `commands` action takes priority for `action_command`
    /// (it carries a real per-item stamp), RunForward stays locomotion, and
    /// there is no double-play (the swing/eat is the single action overlay).
    #[test]
    fn forward_runforward_with_command_list_eat_surfaces_both_no_double_play() {
        use holtburger_protocol::messages::movement::messages::motion::MovementInvalid;
        use holtburger_protocol::messages::movement::types::{
            InterpretedMotionCommand, InterpretedMotionState, MotionItem,
        };

        let state = InterpretedMotionState {
            forward_command: Some(InterpretedMotionCommand::RUN_FORWARD),
            commands: vec![MotionItem::new(0x001Au16, 11, false, 1.0)], // Eat
            ..InterpretedMotionState::default()
        };
        let snapshot = EntityMotionSnapshot::from_movement_event(&MovementEventData {
            guid: Guid(0x5000_0005),
            object_instance_sequence: 1,
            movement_sequence: 2,
            server_control_sequence: 3,
            is_autonomous: false,
            movement_type: MovementType::Invalid,
            motion_flags: 0,
            current_style: MotionStance::NonCombat.interpreted(),
            data: MovementTypeData::Invalid(MovementInvalid {
                state,
                sticky_object: None,
            }),
        })
        .expect("co-packed locomotion + action yields a snapshot");
        assert_eq!(
            snapshot.action_command,
            Some(0x4000_001A),
            "the commands-list eat is the single action overlay"
        );
        assert_eq!(
            snapshot.action_sequence,
            Some(11),
            "commands-list action dedups on its own MotionItem stamp, not movement_sequence"
        );
        assert_eq!(
            snapshot.motion_command().map(|c| c.raw()),
            Some(0x0007),
            "RunForward simultaneously drives the locomotion forward axis"
        );
    }

    #[test]
    fn object_description_stop_completely_does_not_over_read_absent_body() {
        use holtburger_protocol::messages::object::messages::description::ObjectDescriptionData;
        // movement_data is exactly the 4-byte header: type=5 (StopCompletely),
        // motion_flags=0, current_style=NonCombat — and NO body. Pre-fix, types
        // 1-5 routed through MovementInvalid::unpack_ext, which over-reads >=4
        // absent body bytes and makes from_object_description return None. Post-fix
        // they use an empty MovementInvalid (consumes nothing), so the header parses.
        let style = MotionStance::NonCombat.interpreted();
        let mut movement_data = vec![MovementType::StopCompletely as u8, 0x00];
        movement_data.extend_from_slice(&style.to_le_bytes());
        let desc = ObjectDescriptionData {
            movement_data: Some(movement_data),
            ..ObjectDescriptionData::default()
        };

        let snapshot = EntityMotionSnapshot::from_object_description(&desc)
            .expect("StopCompletely header (no body) must parse without over-reading");
        assert_eq!(snapshot.current_style, Some(MotionStance::NonCombat));
    }
}

#[derive(Debug, Clone)]
pub struct Entity {
    pub guid: Guid,
    pub wcid: Option<u32>,
    pub position: WorldPosition,

    pub velocity: Vector3,
    pub acceleration: Vector3,
    pub omega: Vector3,
    pub gfx_id: Option<u32>,
    pub icon_id: Option<u32>,
    pub flags: ObjectDescriptionFlag,
    pub weenie_flags: WeenieHeaderFlag,
    pub weenie_flags2: WeenieHeaderFlag2,
    pub physics_state: PhysicsState,
    pub physics_parent_id: Option<Guid>,
    pub autonomous_movement: bool,
    pub motion_snapshot: Option<EntityMotionSnapshot>,
    pub health_fraction: Option<f32>,

    pub sequences: [u16; 9],

    pub properties: WorldObjectProperties,

    pub armor_profile: Option<ArmorProfile>,
    pub creature_profile: Option<CreatureProfile>,
    pub weapon_profile: Option<WeaponProfile>,
    pub hook_profile: Option<HookProfile>,
    pub armor_levels: Option<ArmorLevels>,
    pub spell_book: Vec<u32>,
    pub book: Option<BookData>,

    pub armor_highlight: Option<u16>,
    pub armor_color: Option<u16>,
    pub weapon_highlight: Option<u16>,
    pub weapon_color: Option<u16>,
    pub resist_highlight: Option<u16>,
    pub resist_color: Option<u16>,

    /// CMT Wave 16 / Phase 50 (2026-05-26): cached PhysicsScriptTable
    /// (DAT 0x34) DID for this entity. `0` = none (entity carries no
    /// table, or no table has been resolved yet).
    ///
    /// **Resolution chain (mirrors retail `acclient.c`):**
    /// 1. If `PhysicsDesc.PhsTableID` (our `petable_id`) is on the
    ///    description, use it — this is the runtime-override path the
    ///    server can send to swap a long-lived entity's table (retail
    ///    `acclient.c:322321-322331` reads `v3->phstable_id.id` and
    ///    overwrites `CPhysicsObj::physics_script_table`).
    /// 2. Otherwise fall back to the entity's `Setup` model's
    ///    `default_phstable_id` field (retail
    ///    `CPhysicsObj::InitWithSetup` at `acclient.c:320886-320900`).
    ///
    /// Populated on `ObjectCreate` and re-resolved on every subsequent
    /// `apply_description` call (which is also the path for PhysicsDesc
    /// runtime swaps), via the wasm-side helper that has the DAT source.
    ///
    /// Read by [Wave 17] via `entity_physics_script_table_did(guid)`
    /// (and `EntityManager.getPhysicsScriptTableDid(guid)` in JS) so
    /// `GameMessageScript` (opcode 0xF755) handlers can resolve a
    /// `PScriptType` enum + `mod` against the right
    /// `PhysicsScriptTable` for this specific entity.
    ///
    /// See `external/holtburger/docs/physicsscript-bridge-research-2026-05-26.md`
    /// §5 for the full lookup picture.
    pub physics_script_table_did: u32,
}

const OBJECT_POSITION_SEQUENCE_INDEX: usize = 0;
/// `ObjectVector` stamp — retail `CPhysicsObj::update_times[3]`, the
/// VectorUpdate (velocity/omega) sequence gated by
/// `SmartBox::DoVectorUpdate` (acclient.c:143459-143480). Lives in
/// `sequences[3]` per the RETAIL-MODEL ordering.
const OBJECT_VECTOR_SEQUENCE_INDEX: usize = 3;
const OBJECT_TELEPORT_SEQUENCE_INDEX: usize = 4;
const OBJECT_SERVER_CONTROL_SEQUENCE_INDEX: usize = 5;
const OBJECT_FORCE_POSITION_SEQUENCE_INDEX: usize = 6;
const OBJECT_INSTANCE_SEQUENCE_INDEX: usize = 8;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EntityPositionSyncOutcome {
    Rejected,
    Moved,
    Reset { sequence: u16 },
}

impl HasProperties for Entity {
    fn properties(&self) -> &WorldObjectProperties {
        &self.properties
    }
}

impl HasPropertiesMut for Entity {
    fn properties_mut(&mut self) -> &mut WorldObjectProperties {
        &mut self.properties
    }
}

impl Entity {
    pub fn motion_command(&self) -> Option<InterpretedMotionCommand> {
        self.motion_snapshot
            .and_then(EntityMotionSnapshot::motion_command)
    }

    /// The entity's last-applied `ObjectVector` (VectorUpdate) stamp —
    /// retail `CPhysicsObj::update_times[3]`.
    pub(crate) fn vector_sequence(&self) -> u16 {
        self.sequences[OBJECT_VECTOR_SEQUENCE_INDEX]
    }

    /// Advance the `ObjectVector` stamp after an accepted VectorUpdate
    /// (mirrors `SmartBox::DoVectorUpdate` writing `update_times[3]`,
    /// acclient.c:143471).
    pub(crate) fn set_vector_sequence(&mut self, vector_sequence: u16) {
        self.sequences[OBJECT_VECTOR_SEQUENCE_INDEX] = vector_sequence;
    }

    pub fn should_accept_server_position_sequences(
        &self,
        teleport_sequence: u16,
        force_position_sequence: u16,
    ) -> bool {
        let current_teleport_sequence = self.sequences[OBJECT_TELEPORT_SEQUENCE_INDEX];
        let current_force_position_sequence = self.sequences[OBJECT_FORCE_POSITION_SEQUENCE_INDEX];

        if is_newer_u16(current_teleport_sequence, teleport_sequence) {
            return false;
        }

        if teleport_sequence == current_teleport_sequence
            && is_newer_u16(current_force_position_sequence, force_position_sequence)
        {
            return false;
        }

        true
    }

    pub fn apply_server_position_update(
        &mut self,
        position: WorldPosition,
        instance_sequence: u16,
        position_sequence: Option<u16>,
        teleport_sequence: u16,
        force_position_sequence: u16,
        server_control_sequence: Option<u16>,
    ) -> EntityPositionSyncOutcome {
        if !self.should_accept_server_position_sequences(teleport_sequence, force_position_sequence)
        {
            return EntityPositionSyncOutcome::Rejected;
        }

        let old_teleport_sequence = self.sequences[OBJECT_TELEPORT_SEQUENCE_INDEX];
        let old_force_position_sequence = self.sequences[OBJECT_FORCE_POSITION_SEQUENCE_INDEX];
        let old_position_sequence = self.sequences[OBJECT_POSITION_SEQUENCE_INDEX];

        let teleport_advanced = is_newer_u16(teleport_sequence, old_teleport_sequence);
        let force_advanced = is_newer_u16(force_position_sequence, old_force_position_sequence);

        // Position-only update (no newer teleport/force): retail gates the apply on
        // newer_event(object, 0, position_ts) (acclient.c:145167) — reject a stale or
        // reordered position-only frame. A newer teleport/force is an authoritative
        // snap that applies regardless; a `None` position_sequence is a forced snap.
        // OQ-9 settled by ACE source: PositionPack.cs:47 bumps ObjectPosition per
        // broadcast (GetNextSequence), so a legitimate newer frame is never dropped.
        if !teleport_advanced && !force_advanced {
            if let Some(incoming_position_sequence) = position_sequence {
                if !is_newer_u16(incoming_position_sequence, old_position_sequence) {
                    return EntityPositionSyncOutcome::Rejected;
                }
            }
        }

        self.position = position;
        self.sequences[OBJECT_INSTANCE_SEQUENCE_INDEX] = instance_sequence;
        if let Some(position_sequence) = position_sequence {
            self.sequences[OBJECT_POSITION_SEQUENCE_INDEX] = position_sequence;
        }
        self.sequences[OBJECT_TELEPORT_SEQUENCE_INDEX] = teleport_sequence;
        self.sequences[OBJECT_FORCE_POSITION_SEQUENCE_INDEX] = force_position_sequence;
        if let Some(server_control_sequence) = server_control_sequence {
            self.sequences[OBJECT_SERVER_CONTROL_SEQUENCE_INDEX] = server_control_sequence;
        }

        let reset_required = position_sequence.is_none() || teleport_advanced || force_advanced;

        if reset_required {
            EntityPositionSyncOutcome::Reset {
                sequence: force_position_sequence,
            }
        } else {
            EntityPositionSyncOutcome::Moved
        }
    }

    pub fn set_property(&mut self, update: PropertyUpdate) {
        self.properties.apply(update);
    }

    pub fn apply_identify_response(&mut self, data: &IdentifyObjectResponseEventData) -> bool {
        identify::apply_identify_response(
            IdentifyTarget {
                properties: &mut self.properties,
                armor_profile: &mut self.armor_profile,
                creature_profile: &mut self.creature_profile,
                weapon_profile: &mut self.weapon_profile,
                hook_profile: &mut self.hook_profile,
                armor_levels: &mut self.armor_levels,
                spell_book: &mut self.spell_book,
                armor_highlight: &mut self.armor_highlight,
                armor_color: &mut self.armor_color,
                weapon_highlight: &mut self.weapon_highlight,
                weapon_color: &mut self.weapon_color,
                resist_highlight: &mut self.resist_highlight,
                resist_color: &mut self.resist_color,
            },
            data,
        )
    }

    pub fn set_container_id(&mut self, val: Option<Guid>) {
        self.set_iid_prop(PropertyInstanceId::Container, val.unwrap_or(Guid::NULL))
    }

    pub fn set_wielder_id(&mut self, val: Option<Guid>) {
        self.set_iid_prop(PropertyInstanceId::Wielder, val.unwrap_or(Guid::NULL))
    }

    pub fn apply_description(&mut self, data: &ObjectDescriptionData) {
        self.wcid = Some(data.public_weenie_desc.wcid);
        self.flags = data.public_weenie_desc.obj_desc_flags;
        self.weenie_flags = data.public_weenie_desc.weenie_flags;
        self.weenie_flags2 = data.public_weenie_desc.weenie_flags2;

        self.properties.ints.0.insert(
            PropertyInt::ItemType,
            data.public_weenie_desc.item_type as i32,
        );

        self.physics_state = data.physics_state;
        self.physics_parent_id = data.parent_id;

        if let Some(v) = data.velocity {
            self.velocity = v;
        }
        if let Some(a) = data.acceleration {
            self.acceleration = a;
        }
        if let Some(o) = data.omega {
            self.omega = o;
        }

        self.icon_id = Some(data.public_weenie_desc.icon_id);
        self.sequences = data.sequences;

        if let Some(val) = data.autonomous_movement {
            self.autonomous_movement = val;
        }

        self.motion_snapshot = EntityMotionSnapshot::from_object_description(data);

        // Hydrate properties from the description (using common mapping logic)
        self.properties.hydrate_from_odd(data);
    }

    /// Whether the renderer should draw this entity.
    ///
    /// Returns `false` when any of `HIDDEN`, `NO_DRAW`, or `CLOAKED`
    /// is set. Mirrors retail behavior — see `acclient.h` enum
    /// `PhysicsState` and ACE's draw-gate checks (e.g. 17 references
    /// to `Hidden` and 11 to `NoDraw` across `ACE.Server/Physics/`).
    pub fn should_draw(&self) -> bool {
        !self
            .physics_state
            .intersects(PhysicsState::HIDDEN | PhysicsState::NO_DRAW | PhysicsState::CLOAKED)
    }

    /// Whether this entity contributes a BSP tree to collision queries.
    ///
    /// Mirrors `State.HasFlag(PhysicsState.HasPhysicsBSP)` in ACE's
    /// `PhysicsObj.find_object_collisions`, `GetPhysicsRadius`, and
    /// `calc_cross_cells`. When `false`, callers should fall back to
    /// cylsphere/sphere bounds instead of BSP-polygon queries.
    pub fn has_physics_bsp(&self) -> bool {
        self.physics_state.contains(PhysicsState::HAS_PHYSICS_BSP)
    }

    /// Whether collision logic should run against this entity.
    ///
    /// `ETHEREAL` (pass-through, e.g. open doors and ghosts) and
    /// `IGNORE_COLLISIONS` both disable collision; either skips
    /// physics interaction. ACE's `Door.cs` flips `Ethereal` on
    /// open/close.
    pub fn is_collidable(&self) -> bool {
        !self
            .physics_state
            .intersects(PhysicsState::ETHEREAL | PhysicsState::IGNORE_COLLISIONS)
    }

    /// Whether this is a static (non-moving) entity.
    ///
    /// ACE checks `PhysicsState.Static` in 30 places to skip physics
    /// integration steps for fixed scenery and decorative objects.
    pub fn is_static(&self) -> bool {
        self.physics_state.contains(PhysicsState::STATIC)
    }

    /// Whether this entity is a missile (projectile).
    ///
    /// Missiles use a different physics path (no walk gravity, path
    /// alignment, despawn-on-collision). ACE's `find_object_collisions`
    /// branches on this flag at the top of the function.
    pub fn is_missile(&self) -> bool {
        self.physics_state.contains(PhysicsState::MISSILE)
    }

    /// Whether this entity emits particles.
    ///
    /// Particle update/spawn paths in ACE gate on this flag
    /// (`PhysicsObj.cs:748, 1002, 1146`). Without the gate, the
    /// renderer wastes work spawning particles on objects the retail
    /// client wouldn't.
    pub fn is_particle_emitter(&self) -> bool {
        self.physics_state.contains(PhysicsState::PARTICLE_EMITTER)
    }

    pub fn new(guid: Guid, name: String, position: WorldPosition) -> Self {
        let mut properties = WorldObjectProperties::default();
        properties.strings.insert(PropertyString::Name, name);

        Self {
            guid,
            wcid: None,
            position,
            velocity: Vector3 {
                x: 0.0,
                y: 0.0,
                z: 0.0,
            },
            acceleration: Vector3 {
                x: 0.0,
                y: 0.0,
                z: 0.0,
            },
            omega: Vector3 {
                x: 0.0,
                y: 0.0,
                z: 0.0,
            },
            gfx_id: None,
            icon_id: None,
            flags: ObjectDescriptionFlag::empty(),
            weenie_flags: WeenieHeaderFlag::empty(),
            weenie_flags2: WeenieHeaderFlag2::empty(),

            physics_state: PhysicsState::NONE,
            physics_parent_id: None,
            autonomous_movement: false,
            motion_snapshot: None,
            health_fraction: None,
            sequences: [0; 9],
            properties,
            armor_profile: None,
            creature_profile: None,
            weapon_profile: None,
            hook_profile: None,
            armor_levels: None,
            spell_book: Vec::new(),
            book: None,
            armor_highlight: None,
            armor_color: None,
            weapon_highlight: None,
            weapon_color: None,
            resist_highlight: None,
            resist_color: None,
            // CMT Wave 16 / Phase 50 (2026-05-26): unresolved until the
            // wasm-side helper inspects PhysicsDesc.petable_id or
            // Setup.default_phstable_id (lib.rs has the DAT source).
            physics_script_table_did: 0,
        }
    }
}

pub struct EntityManager {
    pub entities: HashMap<Guid, Entity>,
}

impl Default for EntityManager {
    fn default() -> Self {
        Self::new()
    }
}

impl EntityManager {
    pub fn new() -> Self {
        Self {
            entities: HashMap::new(),
        }
    }

    pub fn insert(&mut self, entity: Entity) {
        self.entities.insert(entity.guid, entity);
    }

    pub fn contains(&self, guid: impl Into<Guid>) -> bool {
        self.entities.contains_key(&guid.into())
    }

    pub fn get(&self, guid: impl Into<Guid>) -> Option<&Entity> {
        self.entities.get(&guid.into())
    }

    pub fn get_filtered<F>(&self, guid: impl Into<Guid>, predicate: F) -> Option<&Entity>
    where
        F: FnOnce(&Entity) -> bool,
    {
        let entity = self.get(guid)?;
        predicate(entity).then_some(entity)
    }

    pub fn get_mut(&mut self, guid: impl Into<Guid>) -> Option<&mut Entity> {
        self.entities.get_mut(&guid.into())
    }

    pub fn iter(&self) -> impl Iterator<Item = &Entity> {
        self.entities.values()
    }

    pub fn iter_filtered<'a, F>(&'a self, mut predicate: F) -> impl Iterator<Item = &'a Entity> + 'a
    where
        F: FnMut(&Entity) -> bool + 'a,
    {
        self.entities
            .values()
            .filter(move |entity| predicate(entity))
    }

    pub fn remove(&mut self, guid: impl Into<Guid>) -> Option<Entity> {
        self.entities.remove(&guid.into())
    }

    /// CMT Wave 16 / Phase 50 (2026-05-26): cached
    /// `PhysicsScriptTable` (DAT 0x34) DID for an entity.
    ///
    /// Returns `0` when the entity is unknown or when no table has been
    /// resolved yet (Setup model carries no `default_phstable_id` AND
    /// no `PhysicsDesc.PhsTableID` runtime override has arrived). Wave
    /// 17's `play_effect_vfx.js` consumer reads this to resolve a
    /// `GameMessageScript` `PScriptType` enum value into a concrete
    /// `PhysicsScript` (0x33) DID against the entity's own table.
    pub fn physics_script_table_did(&self, guid: impl Into<Guid>) -> u32 {
        self.entities
            .get(&guid.into())
            .map(|e| e.physics_script_table_did)
            .unwrap_or(0)
    }
}

#[cfg(test)]
mod physics_state_predicates_tests {
    use super::*;

    fn fixture(state: PhysicsState) -> Entity {
        let mut e = Entity::new(
            Guid::from(0x5000_0001u32),
            "test".into(),
            WorldPosition::default(),
        );
        e.physics_state = state;
        e
    }

    #[test]
    fn should_draw_gates_hidden_nodraw_cloaked() {
        assert!(fixture(PhysicsState::NONE).should_draw());
        assert!(fixture(PhysicsState::STATIC | PhysicsState::GRAVITY).should_draw());
        assert!(!fixture(PhysicsState::HIDDEN).should_draw());
        assert!(!fixture(PhysicsState::NO_DRAW).should_draw());
        assert!(!fixture(PhysicsState::CLOAKED).should_draw());
        assert!(!fixture(PhysicsState::STATIC | PhysicsState::HIDDEN).should_draw());
    }

    #[test]
    fn collidable_gates_ethereal_and_ignore_collisions() {
        assert!(fixture(PhysicsState::NONE).is_collidable());
        assert!(fixture(PhysicsState::REPORT_COLLISIONS).is_collidable());
        assert!(!fixture(PhysicsState::ETHEREAL).is_collidable());
        assert!(!fixture(PhysicsState::IGNORE_COLLISIONS).is_collidable());
    }

    #[test]
    fn single_flag_predicates() {
        let e = fixture(
            PhysicsState::STATIC
                | PhysicsState::HAS_PHYSICS_BSP
                | PhysicsState::MISSILE
                | PhysicsState::PARTICLE_EMITTER,
        );
        assert!(e.is_static());
        assert!(e.has_physics_bsp());
        assert!(e.is_missile());
        assert!(e.is_particle_emitter());
        let none = fixture(PhysicsState::NONE);
        assert!(!none.is_static());
        assert!(!none.has_physics_bsp());
        assert!(!none.is_missile());
        assert!(!none.is_particle_emitter());
    }
}
