use crate::WorldEvent;
use crate::events::FellowshipActivity;
use crate::state::{FellowshipMemberState, FellowshipState, WorldState};
use holtburger_protocol::messages::{GameEvent, GameEventMessage};

pub(crate) fn handle_event(
    state: &mut WorldState,
    event: &GameEventMessage,
    events: &mut Vec<WorldEvent>,
) -> bool {
    match &event.event {
        GameEvent::FellowshipFullUpdate(data) => {
            let previous_fellowship = state.fellowship.clone();
            state.fellowship = Some(FellowshipState::from(data.as_ref()));

            if previous_fellowship.is_none()
                && let Some(fellowship) = state.fellowship.as_ref()
                && fellowship
                    .members
                    .iter()
                    .any(|member| member.guid == state.player.guid)
            {
                // fellowship-2: retail `RecvNotice_FellowshipUpdate`
                // (acclient.c:203573-203648) — create vs recruit by who leads.
                events.push(WorldEvent::FellowshipActivity(
                    FellowshipActivity::YouJoined {
                        fellowship_name: fellowship.name.clone(),
                        leader_name: fellowship.leader_name(),
                        self_is_leader: fellowship.is_led_by(state.player.guid),
                        open: fellowship.open,
                    },
                ));
            }

            events.push(WorldEvent::FellowshipStateUpdated(state.fellowship.clone()));
            true
        }
        GameEvent::FellowshipUpdateFellow(data) => {
            let member = FellowshipMemberState::from(&data.fellow);
            let member_is_new = state.fellowship.as_ref().is_none_or(|fellowship| {
                !fellowship
                    .members
                    .iter()
                    .any(|existing| existing.guid == member.guid)
            });

            match state.fellowship.as_mut() {
                Some(fellowship) => fellowship.upsert_member(member.clone()),
                None => {
                    state.fellowship = Some(FellowshipState::unknown_with_member(member.clone()))
                }
            }

            if member_is_new {
                if member.guid == state.player.guid {
                    let fellowship = state.fellowship.as_ref();
                    events.push(WorldEvent::FellowshipActivity(
                        FellowshipActivity::YouJoined {
                            fellowship_name: fellowship
                                .map(|fellowship| fellowship.name.clone())
                                .unwrap_or_default(),
                            leader_name: fellowship.and_then(|fellowship| fellowship.leader_name()),
                            self_is_leader: fellowship
                                .is_some_and(|fellowship| fellowship.is_led_by(state.player.guid)),
                            open: fellowship.is_some_and(|fellowship| fellowship.open),
                        },
                    ));
                } else {
                    events.push(WorldEvent::FellowshipActivity(
                        FellowshipActivity::MemberJoined {
                            member_name: member.name.clone(),
                        },
                    ));
                }
            }

            events.push(WorldEvent::FellowshipStateUpdated(state.fellowship.clone()));
            true
        }
        GameEvent::FellowshipQuit(data) => {
            apply_member_departure(state, data.player_guid, false, events);
            true
        }
        GameEvent::FellowshipDismiss(data) => {
            apply_member_departure(state, data.player_guid, true, events);
            true
        }
        GameEvent::FellowshipDisband => {
            // fellowship-2: retail `gmFellowshipUI::FellowshipDisbanded`
            // (acclient.c:203000-203040) reads `_leader` BEFORE deleting.
            let fellowship = state.fellowship.as_ref();
            let fellowship_name = fellowship.map(|fellowship| fellowship.name.clone());
            let leader_name = fellowship.and_then(|fellowship| fellowship.leader_name());
            let self_is_leader =
                fellowship.is_some_and(|fellowship| fellowship.is_led_by(state.player.guid));
            state.fellowship = None;
            events.push(WorldEvent::FellowshipActivity(
                FellowshipActivity::FellowshipDisbanded {
                    fellowship_name,
                    leader_name,
                    self_is_leader,
                },
            ));
            events.push(WorldEvent::FellowshipStateUpdated(None));
            true
        }
        GameEvent::FellowshipFellowUpdateDone | GameEvent::FellowshipFellowStatsDone => true,
        _ => false,
    }
}

fn apply_member_departure(
    state: &mut WorldState,
    player_guid: holtburger_common::Guid,
    dismissed: bool,
    events: &mut Vec<WorldEvent>,
) {
    let member_name = state
        .fellowship
        .as_ref()
        .and_then(|fellowship| {
            fellowship
                .members
                .iter()
                .find(|member| member.guid == player_guid)
                .map(|member| member.name.clone())
        })
        .unwrap_or_else(|| format!("0x{:08X}", player_guid.0));
    // fellowship-2: retail `FellowQuit` / `FellowDismissed`
    // (acclient.c:203045-203190) read the fellowship name and `_leader`
    // BEFORE `RemoveFellow` — capture them before any state change.
    let fellowship_name = state
        .fellowship
        .as_ref()
        .map(|fellowship| fellowship.name.clone());
    let leader_name = state
        .fellowship
        .as_ref()
        .and_then(|fellowship| fellowship.leader_name());
    let self_is_leader = state
        .fellowship
        .as_ref()
        .is_some_and(|fellowship| fellowship.is_led_by(state.player.guid));

    let mut clear_fellowship = player_guid == state.player.guid;

    if let Some(fellowship) = state.fellowship.as_mut() {
        fellowship.remove_member(player_guid);
        fellowship.reassess_leader_after_departure(player_guid);
        clear_fellowship = clear_fellowship || fellowship.members.is_empty();
    }

    if clear_fellowship {
        state.fellowship = None;
    }

    let activity = match (player_guid == state.player.guid, dismissed) {
        (true, true) => FellowshipActivity::YouWereDismissed { leader_name },
        (true, false) => FellowshipActivity::YouLeft { fellowship_name },
        (false, true) => FellowshipActivity::MemberWasDismissed {
            member_name,
            self_is_leader,
        },
        (false, false) => FellowshipActivity::MemberLeft { member_name },
    };
    events.push(WorldEvent::FellowshipActivity(activity));
    events.push(WorldEvent::FellowshipStateUpdated(state.fellowship.clone()));
}
