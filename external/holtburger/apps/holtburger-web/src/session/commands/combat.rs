//! `SessionCommand` arms: Combat and magic: combat-mode changes, spell casts,
//! spellbook edits, melee/missile attacks, health queries.
//!
//! Moved verbatim from the `recv_loop` command `select!` arm (2026-10-05
//! split); see `session::commands::handle_command` for the routing.

use crate::*;
use crate::session::{LoopCtx, LoopFlow};
use crate::combat_toggle::{effective_combat_mode, PendingCombatRequest};

thread_local! {
    /// latency (2026-10-05): the last un-echoed ChangeCombatMode request and
    /// when it was sent — retail's locally-written `combatMode` (see
    /// `crate::combat_toggle`). The recv loop is the only writer/reader.
    static PENDING_COMBAT_REQUEST: std::cell::Cell<
        Option<(PendingCombatRequest, web_time::Instant)>,
    > = const { std::cell::Cell::new(None) };
}

fn note_combat_request(
    requested: holtburger_protocol::messages::CombatMode,
    confirmed_at_request: holtburger_protocol::messages::CombatMode,
) {
    PENDING_COMBAT_REQUEST.with(|c| {
        c.set(Some((
            PendingCombatRequest { requested, confirmed_at_request },
            web_time::Instant::now(),
        )))
    });
}

pub(super) async fn handle(ctx: &mut LoopCtx, cmd: SessionCommand) -> LoopFlow {
    let LoopCtx { session, queued_events, world, movement, entity_seeded, .. } = &mut *ctx;
    match cmd {
        SessionCommand::ToggleCombatMode => {
            // Combat-mode toggle. Read the player's
            // current CombatMode property; if NonCombat,
            // send ChangeCombatMode(suggested) where
            // suggested is derived from equipped items;
            // otherwise send ChangeCombatMode(NonCombat).
            // ACE handles stance derivation server-side
            // via Creature_Combat.cs::GetCombatStance —
            // we never request a specific MotionStance.
            // Mirrors the cli's `domains/combat.rs`
            // toggle pattern + ClientCommand::SetCombatMode
            // → GameAction::ChangeCombatMode dispatch
            // already wired in holtburger-core.
            use holtburger_protocol::messages::{
                ChangeCombatModeActionData, CombatMode, GameAction,
            };
            use holtburger_world::context::WorldContextExt;
            let world_guard = world.borrow();
            let Some(w) = world_guard.as_ref() else {
                console_log_str(
                    "[combat-mode] ToggleCombatMode before WorldState ready — dropping",
                );
                return LoopFlow::Continue;
            };
            if !*entity_seeded {
                console_log_str(
                    "[combat-mode] ToggleCombatMode before player entity seeded — dropping",
                );
                return LoopFlow::Continue;
            }
            // latency (2026-10-05): toggle from the REQUESTED mode while
            // its echo is in flight (retail writes combatMode locally at
            // request time, acclient.c:408855), so a second press inside one
            // round trip toggles back instead of re-sending the same target.
            let confirmed = w.player_combat_mode();
            let current = PENDING_COMBAT_REQUEST.with(|c| match c.get() {
                Some((p, at)) => effective_combat_mode(
                    confirmed,
                    Some(p),
                    at.elapsed().as_secs_f64() * 1000.0,
                ),
                None => confirmed,
            });
            // Pre-2026-05-17 the toggle only fired the
            // suggested-mode path on `NonCombat`. But
            // `WorldState.player.combat_mode` is `Undef`
            // before ACE has broadcast its first
            // PlayerDescription with `combat_mode`. That
            // races against the user clicking the bar's
            // `⚐ Enter Combat Mode` button — first click
            // sees `Undef` and (under the old logic) fell
            // through to "else → NonCombat", which is a
            // no-op since the player is already there.
            // Treat `Undef` the same as `NonCombat` here:
            // the user obviously wants to enter combat,
            // and ACE will reply with the right derived
            // mode either way.
            let target_mode = if matches!(
                current,
                CombatMode::NonCombat | CombatMode::Undef
            ) {
                // Default the suggestion to Melee when no
                // equipment is wielded (the cli helper
                // returns Melee in that case via its
                // `let mut best = CombatMode::Melee;`
                // floor in WorldContextExt::get_suggested_combat_mode).
                // ACE's GetCombatStance falls through to
                // HandCombat for Melee+no-weapon → fists
                // pose, matching retail's "no weapon →
                // bare-handed combat" behaviour.
                w.get_suggested_combat_mode()
            } else {
                CombatMode::NonCombat
            };
            // Out-of-ammo pre-check (mirrors ACE
            // Player_Combat.cs Missile arm, which would
            // bounce this request back to NonCombat ~0.5s
            // later with a transient string the user can
            // easily miss). Refuse locally with the SAME
            // message so the failure is immediate and the
            // stance indicator never flickers through a
            // doomed missile stance.
            if target_mode == CombatMode::Missile
                && w.is_missing_missile_ammo()
            {
                console_log_str(
                    "[combat-mode] toggle blocked: launcher equipped with no ammunition",
                );
                queued_events.borrow_mut().push(ClientEvent {
                    kind: CLIENT_EVENT_KIND_CHAT_RECEIVED,
                    string_payload: Some(
                        "You are out of ammunition!".to_string(),
                    ),
                    u32_payload: Some(0),
                    u32_payload_2: Some(CHAT_CATEGORY_TRANSIENT),
                    f32_payload: None,
                });
                return LoopFlow::Continue;
            }
            drop(world_guard);
            let action = GameAction::ChangeCombatMode(Box::new(
                ChangeCombatModeActionData { mode: target_mode },
            ));
            send_or_disconnect!(
                queued_events,
                e,
                send_ordered!(movement, session, action),
                "recv_loop: send_action(ChangeCombatMode): {e}",
                "toggle_combat_mode: {e}",
                LoopFlow::Exit
            );
            note_combat_request(target_mode, confirmed);
            console_log_str(&format!(
                "[combat-mode] toggle: {current:?} → {target_mode:?}",
            ));
        }
        SessionCommand::SetCombatMode { mode } => {
            // JS plugin computed the desired mode from
            // the authoritative motion stance. Just send
            // it — no world-state lookup (except the
            // out-of-ammo pre-check below, mirroring the
            // ToggleCombatMode arm).
            use holtburger_protocol::messages::{
                ChangeCombatModeActionData, CombatMode, GameAction,
            };
            use holtburger_world::context::WorldContextExt;
            // Caster pre-check (mirrors the Missile ammo
            // guard below). ACE's
            // HandleSwitchToMagicCombatMode returns 0
            // when GetEquippedWand() is null — the
            // CombatMode property half-flips server-side
            // but no stance motion or client update is
            // ever sent, so the request dies SILENTLY.
            // Refuse locally with immediate feedback
            // instead. Retail's UI never offered magic
            // mode without a wielded caster, so there is
            // no retail string for this; the message
            // follows the ammo-guard idiom.
            if mode == CombatMode::Magic
                && world.borrow()
                    .as_ref()
                    .is_some_and(|w| !w.is_wielding_caster())
            {
                console_log_str(
                    "[combat-mode] set(Magic) blocked: no caster (wand/orb/staff) wielded",
                );
                queued_events.borrow_mut().push(ClientEvent {
                    kind: CLIENT_EVENT_KIND_CHAT_RECEIVED,
                    string_payload: Some(
                        "You must wield a wand, orb, or staff to enter magic combat mode!"
                            .to_string(),
                    ),
                    u32_payload: Some(0),
                    u32_payload_2: Some(CHAT_CATEGORY_TRANSIENT),
                    f32_payload: None,
                });
                return LoopFlow::Continue;
            }
            if mode == CombatMode::Missile
                && world.borrow()
                    .as_ref()
                    .is_some_and(|w| w.is_missing_missile_ammo())
            {
                console_log_str(
                    "[combat-mode] set(Missile) blocked: launcher equipped with no ammunition",
                );
                queued_events.borrow_mut().push(ClientEvent {
                    kind: CLIENT_EVENT_KIND_CHAT_RECEIVED,
                    string_payload: Some(
                        "You are out of ammunition!".to_string(),
                    ),
                    u32_payload: Some(0),
                    u32_payload_2: Some(CHAT_CATEGORY_TRANSIENT),
                    f32_payload: None,
                });
                return LoopFlow::Continue;
            }
            let confirmed = world.borrow().as_ref().map(|w| w.player_combat_mode());
            let action = GameAction::ChangeCombatMode(Box::new(
                ChangeCombatModeActionData { mode },
            ));
            send_or_disconnect!(
                queued_events,
                e,
                send_ordered!(movement, session, action),
                "recv_loop: send_action(ChangeCombatMode {mode:?}): {e}",
                "set_combat_mode: {e}",
                LoopFlow::Exit
            );
            // latency (2026-10-05): a keyboard toggle right after a
            // combat-bar request toggles from THIS request (see above).
            if let Some(confirmed) = confirmed {
                note_combat_request(mode, confirmed);
            }
            console_log_str(&format!(
                "[combat-mode] set: → {mode:?}",
            ));
        }
        SessionCommand::CastTargetedSpell {
            target_guid,
            spell_id,
        } => {
            // Retail stops the player BEFORE every cast / attack
            // request: `FreeHandsAndCastSpell` (acclient.c:403775),
            // untargeted `CastSpell`, `StartAttackRequest`
            // (:408917) all call `MaybeStopCompletely` — held keys
            // stop counting until re-pressed (the slidecast
            // re-tap, PARITY-LEDGER H2/R1). Every JS cast/attack
            // path funnels through this arm, so it lives here
            // (the stop is queued with the request below).
            // Phase F (combat-magic): build and send a
            // GameAction::CastTargetedSpell. ACE validates
            // everything server-side (mana cost, spell
            // known, LOS, range, stance, components).
            use holtburger_common::Guid;
            use holtburger_protocol::messages::{
                CastTargetedSpellActionData, GameAction,
            };
            let action = GameAction::CastTargetedSpell(Box::new(
                CastTargetedSpellActionData {
                    target: Guid(target_guid),
                    spell_id,
                },
            ));
            // Stop's MoveToState must reach ACE BEFORE the request (ACE
            // cancels a pending MoveTo chain on MoveToState) — the
            // movement tick sends `action` right after the stop flush.
            let send_result = match movement.enqueue_stop_then_action(action) {
                Some(action) => session.send_action(action).await.map(|_| ()),
                None => Ok(()),
            };
            send_or_disconnect!(
                queued_events,
                e,
                send_result,
                "recv_loop: send_action(CastTargetedSpell): {e}",
                "cast_targeted_spell: {e}",
                LoopFlow::Exit
            );
            // 2026-10-07: the cast window (castMoveLock / castHoldReclaim)
            // runs from here to the server's UseDone.
            movement.note_cast_request_sent();
            console_log_str(&format!(
                "[cast_spell] target=0x{target_guid:08X} spell_id={spell_id}",
            ));
        }
        SessionCommand::CastUntargetedSpell { spell_id } => {
            // Retail MaybeStopCompletely first (see CastTargetedSpell) —
            // queued with the request below.
            use holtburger_protocol::messages::{
                CastUntargetedSpellActionData, GameAction,
            };
            let action = GameAction::CastUntargetedSpell(Box::new(
                CastUntargetedSpellActionData { spell_id },
            ));
            // Stop's MoveToState must reach ACE BEFORE the request (ACE
            // cancels a pending MoveTo chain on MoveToState) — the
            // movement tick sends `action` right after the stop flush.
            let send_result = match movement.enqueue_stop_then_action(action) {
                Some(action) => session.send_action(action).await.map(|_| ()),
                None => Ok(()),
            };
            send_or_disconnect!(
                queued_events,
                e,
                send_result,
                "recv_loop: send_action(CastUntargetedSpell): {e}",
                "cast_untargeted_spell: {e}",
                LoopFlow::Exit
            );
            movement.note_cast_request_sent();
            console_log_str(&format!(
                "[cast_spell] untargeted spell_id={spell_id}",
            ));
        }
        SessionCommand::RemoveSpellFromBook { spell_id } => {
            use holtburger_protocol::messages::{
                GameAction, RemoveSpellFromBookActionData,
            };
            let action = GameAction::RemoveSpellFromBook(Box::new(
                RemoveSpellFromBookActionData { spell_id },
            ));
            send_or_disconnect!(
                queued_events,
                e,
                send_ordered!(movement, session, action),
                "recv_loop: send_action(RemoveSpellFromBook): {e}",
                "remove_spell_from_book: {e}",
                LoopFlow::Exit
            );
            console_log_str(&format!(
                "[remove_spell] spell_id={spell_id}",
            ));
        }
        SessionCommand::TargetedMissileAttack {
            target_guid,
            attack_height,
            accuracy_level,
        } => {
            // Retail MaybeStopCompletely first (see CastTargetedSpell) —
            // queued with the request below.
            // Phase E (combat-missile): mirror of the
            // melee arm — ACE owns target liveness,
            // ammo check, range, stance check, etc.
            use holtburger_common::Guid;
            use holtburger_protocol::messages::{
                GameAction, TargetedMissileAttackActionData,
            };
            let accuracy_level = accuracy_level.clamp(0.0, 1.0);
            let action = GameAction::TargetedMissileAttack(Box::new(
                TargetedMissileAttackActionData {
                    target_guid: Guid(target_guid),
                    attack_height,
                    accuracy_level,
                },
            ));
            // Stop's MoveToState must reach ACE BEFORE the request (ACE
            // cancels a pending MoveTo chain on MoveToState) — the
            // movement tick sends `action` right after the stop flush.
            let send_result = match movement.enqueue_stop_then_action(action) {
                Some(action) => session.send_action(action).await.map(|_| ()),
                None => Ok(()),
            };
            send_or_disconnect!(
                queued_events,
                e,
                send_result,
                "recv_loop: send_action(TargetedMissileAttack): {e}",
                "missile_attack: {e}",
                LoopFlow::Exit
            );
            console_log_str(&format!(
                "[missile_attack] target=0x{target_guid:08X} height={attack_height:?} accuracy={accuracy_level:.2}",
            ));
        }
        SessionCommand::TargetedMeleeAttack {
            target_guid,
            attack_height,
            power_level,
        } => {
            // Retail MaybeStopCompletely first (see CastTargetedSpell) —
            // queued with the request below.
            // Phase B (combat-melee): build a
            // GameAction::TargetedMeleeAttack (sub-opcode 0x0008)
            // and dispatch. ACE's HandleActionTargetedMeleeAttack
            // owns all validation (combat mode, target liveness,
            // CanDamage, range, busy state) — we just forward.
            // The server auto-repeats the swing via ActionChain
            // until target dies / leaves range / player cancels,
            // so this fires once per engagement, not per swing.
            use holtburger_common::Guid;
            use holtburger_protocol::messages::{
                GameAction, TargetedMeleeAttackActionData,
            };
            let power_level = power_level.clamp(0.0, 1.0);
            let action = GameAction::TargetedMeleeAttack(Box::new(
                TargetedMeleeAttackActionData {
                    target_guid: Guid(target_guid),
                    attack_height,
                    power_level,
                },
            ));
            // Stop's MoveToState must reach ACE BEFORE the request (ACE
            // cancels a pending MoveTo chain on MoveToState) — the
            // movement tick sends `action` right after the stop flush.
            let send_result = match movement.enqueue_stop_then_action(action) {
                Some(action) => session.send_action(action).await.map(|_| ()),
                None => Ok(()),
            };
            send_or_disconnect!(
                queued_events,
                e,
                send_result,
                "recv_loop: send_action(TargetedMeleeAttack): {e}",
                "attack: {e}",
                LoopFlow::Exit
            );
            console_log_str(&format!(
                "[attack] target=0x{target_guid:08X} height={attack_height:?} power={power_level:.2}",
            ));
        }
        SessionCommand::CancelAttack => {
            // F6-4 (combat): stop ACE's auto-repeat attack loop.
            // Empty-body GameAction::CancelAttack (sub-opcode
            // 0x01B7). ACE's HandleActionCancelAttack tears down
            // the ActionChain re-fire. Fire-and-forget — no local
            // state to mutate (the swing animation plays out its
            // own release frames).
            use holtburger_protocol::messages::{
                GameAction, CancelAttackActionData,
            };
            let action =
                GameAction::CancelAttack(Box::new(CancelAttackActionData {}));
            send_or_disconnect!(
                queued_events,
                e,
                send_ordered!(movement, session, action),
                "recv_loop: send_action(CancelAttack): {e}",
                "cancelAttack: {e}",
                LoopFlow::Exit
            );
            // 2026-10-07 — pure send trace (~150 per 15-min session: every
            // movement key pressed in a combat stance sends one, picking.js
            // F6-4) and nothing parses it. `?diag=1` restores it.
            if flag_search()
                .trim_start_matches('?')
                .split('&')
                .any(|kv| kv == "diag=1")
            {
                console_log_str("[cancelAttack] sent");
            }
        }
        SessionCommand::QueryHealth { target_guid } => {
            // F10-1 (combat): ask ACE for the target's health
            // fraction. The UpdateHealth reply flows through the
            // world into WorldEvent::EntityHealthUpdated, bridged
            // to JS as kind=54 for the target-bar health bar.
            use holtburger_common::Guid;
            use holtburger_protocol::messages::{
                GameAction, QueryHealthActionData,
            };
            let action = GameAction::QueryHealth(Box::new(
                QueryHealthActionData {
                    target_guid: Guid(target_guid),
                },
            ));
            send_or_disconnect!(
                queued_events,
                e,
                send_ordered!(movement, session, action),
                "recv_loop: send_action(QueryHealth): {e}",
                "queryHealth: {e}",
                LoopFlow::Exit
            );
        }
        _ => unreachable!("SessionCommand routed to the wrong handler module"),
    }
    LoopFlow::Continue
}
