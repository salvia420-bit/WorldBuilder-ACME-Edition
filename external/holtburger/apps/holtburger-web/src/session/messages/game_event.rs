//! `GameMessage` arms: The 0xF7B0 GameEvent envelope (its own inner per-event
//! match).
//!
//! Moved verbatim from the inbound `match message` (2026-10-05 recv_loop
//! split); see `session::messages::dispatch_game_message` for the routing.

use crate::*;
use crate::session::{LoopCtx, LoopFlags, LoopFlow};
use holtburger_protocol::messages::{GameAction, GameMessage};

pub(super) async fn handle(ctx: &mut LoopCtx, message: GameMessage) -> LoopFlow {
    let LoopFlags { seq_debug, .. } = ctx.flags;
    let LoopCtx {
        session,
        queued_events,
        latest_vendor_state,
        latest_container_contents,
        latest_object_icons,
        latest_allegiance,
        latest_allegiance_info,
        latest_friends,
        latest_squelch,
        latest_title,
        latest_house_status,
        latest_house_data,
        latest_house_profile,
        latest_house_restrictions,
        latest_contracts,
        latest_known_spells,
        rynth_use_done_seq,
        rynth_busy,
        rynth_ground_container,
        last_ping_rtt_ms,
        turbine_chat_state,
        pending_confirmations,
        plugin_list,
        world,
        movement,
        entity_seeded,
        heartbeat_armed,
        seq_tracker,
        ..
    } = &mut *ctx;
    match message {
        GameMessage::GameEvent(event_msg) => {
            // GameEvent wraps a sequenced inbound
            // dispatch keyed on `target` (player or
            // object guid) + `sequence`. The chat
            // surfaces here all carry text payloads or
            // are combat/death notifications that get
            // formatted into chat lines below; non-chat
            // variants (PlayerDescription, PingResponse,
            // ViewContents, magic enchant updates,
            // fellowship / trade events, etc.)
            // intentionally fall through to a catch-all
            // _no-op_ — those land in steps 5+
            // (interactive entities, vitals, inventory).
            if seq_debug {
                let opcode = game_event_opcode_for(&event_msg.event);
                let target_u32: u32 = event_msg.target.into();
                check_sequence_gap(
                    &seq_tracker,
                    opcode,
                    target_u32,
                    event_msg.sequence,
                );
            }
            match event_msg.event {
                // TurbineChat channel-list bootstrap.
                // ACE pushes this shortly after the
                // EnteredWorld handshake (or on
                // re-subscribe) carrying the room-IDs
                // for /cg /ct /clfg /crp /society
                // /olthoi. We stash it so the
                // SendTurbineChannel command arm can
                // resolve channel kind → room_id.
                holtburger_protocol::messages::GameEvent::SetTurbineChatChannels(
                    data,
                ) => {
                    turbine_chat_state.borrow_mut().channels = Some(*data);
                }
                holtburger_protocol::messages::GameEvent::Tell(data) => {
                    let category = chat_category_for_message_type(data.chat_type);
                    queued_events.borrow_mut().push(ClientEvent {
                        kind: CLIENT_EVENT_KIND_CHAT_RECEIVED,
                        string_payload: Some(format!(
                            "{} tells you, \"{}\"",
                            data.sender_name, data.message
                        )),
                        u32_payload: Some(data.chat_type),
                        u32_payload_2: Some(category),
                        f32_payload: None,
                    });
                }
                // Guild-moot (2026-07-16): stash confirmation
                // dialogs (allegiance swears etc.) for the
                // pendingConfirmations() poll. Deliberately
                // NOT a chat line — keeps transcripts clean.
                holtburger_protocol::messages::GameEvent::CharacterConfirmationRequest(
                    data,
                ) => {
                    console_log_str(&format!(
                        "[confirm/request] type={} ctx={} {}",
                        data.confirmation_type as u32, data.context, data.text
                    ));
                    pending_confirmations.borrow_mut().push(PendingConfirmation {
                        confirm_type: data.confirmation_type as u32,
                        context: data.context,
                        text: data.text.clone(),
                    });
                }
                // P6.1 (2026-07-27): admin plugin-manifest query.
                // Retail
                // `ClientAdminSystem::Handle_Admin__Recv_QueryPluginList`
                // (acclient.c 0x6B5EE0) answers UNCONDITIONALLY
                // and SYNCHRONOUSLY — the reply is never
                // suppressed, never deferred, and `context` is
                // echoed verbatim (it is the admin's only
                // correlation token). `plugin_list` is `None`
                // until the JS loader calls
                // `setPluginList()`; that case sends retail's
                // `NO_PLUGIN_API_PLUGIN_LIST` literal, matching
                // retail's `APIIsReady() == false` path.
                // Not routed through `queued_events`: no JS
                // round-trip is permitted to gate an admin
                // answer.
                holtburger_protocol::messages::GameEvent::AdminQueryPluginList(
                    data,
                ) => {
                    let roster = plugin_list.borrow().clone();
                    let reply = GameAction::QueryPluginListResponse(Box::new(
                        holtburger_protocol::messages::QueryPluginListResponseActionData::new(
                            data.context,
                            roster.as_deref(),
                        ),
                    ));
                    console_log_str(&format!(
                        "[plugin-query] 0x02AE ctx={} -> 0x02AF plugins={}",
                        data.context,
                        roster.as_deref().unwrap_or("<none>")
                    ));
                    if let Err(e) = session.send_action(reply).await {
                        log::warn!(
                            "recv_loop: send_action(QueryPluginListResponse ctx={}): {e}",
                            data.context
                        );
                    }
                }
                holtburger_protocol::messages::GameEvent::ChannelBroadcast(
                    data,
                ) => {
                    let channel_label =
                        chat_channel_label(data.channel.raw());
                    let category =
                        chat_category_for_channel(data.channel.raw());
                    queued_events.borrow_mut().push(ClientEvent {
                        kind: CLIENT_EVENT_KIND_CHAT_RECEIVED,
                        string_payload: Some(format!(
                            "[{}] {} says, \"{}\"",
                            channel_label, data.sender_name, data.message
                        )),
                        u32_payload: Some(data.channel.raw()),
                        u32_payload_2: Some(category),
                        f32_payload: None,
                    });
                }
                holtburger_protocol::messages::GameEvent::CommunicationTransientString(
                    data,
                ) => {
                    queued_events.borrow_mut().push(ClientEvent {
                        kind: CLIENT_EVENT_KIND_CHAT_RECEIVED,
                        string_payload: Some(data.message.clone()),
                        u32_payload: Some(0),
                        u32_payload_2: Some(CHAT_CATEGORY_TRANSIENT),
                        f32_payload: None,
                    });
                }
                holtburger_protocol::messages::GameEvent::PopupString(data) => {
                    queued_events.borrow_mut().push(ClientEvent {
                        kind: CLIENT_EVENT_KIND_CHAT_RECEIVED,
                        string_payload: Some(format!("[Popup] {}", data.message)),
                        u32_payload: Some(0),
                        u32_payload_2: Some(CHAT_CATEGORY_POPUP),
                        f32_payload: None,
                    });
                }
                holtburger_protocol::messages::GameEvent::AttackerNotification(
                    data,
                ) => {
                    // F10-2 — retail attacker line, e.g.
                    // "Critical hit!  You mangle Drudge
                    // Ravener for 37 points of damage!".
                    // The verb encodes type + severity
                    // (acclient.c GetDamageAdjective);
                    // `health_percent` is the severity =
                    // damage / MaxHealth (NOT the target's
                    // remaining health), so it drives the
                    // verb but is no longer printed as a
                    // misleading percent.
                    let prefix = attack_conditions_prefix(
                        data.critical_hit,
                        data.attack_conditions,
                    );
                    let verb = damage_severity_verb(
                        data.damage_type,
                        data.health_percent,
                        false,
                    );
                    let pts = if data.damage == 1 { "point" } else { "points" };
                    let line = format!(
                        "{}You {} {} for {} {} of damage!",
                        prefix, verb, data.defender_name, data.damage, pts,
                    );
                    queued_events.borrow_mut().push(ClientEvent {
                        kind: CLIENT_EVENT_KIND_CHAT_RECEIVED,
                        string_payload: Some(line),
                        u32_payload: Some(0),
                        u32_payload_2: Some(CHAT_CATEGORY_COMBAT),
                        f32_payload: None,
                    });
                    queued_events.borrow_mut().push(ClientEvent {
                        kind: CLIENT_EVENT_KIND_COMBAT_EVENT,
                        string_payload: Some(
                            // F10-2 — `severity` = damage /
                            // MaxHealth (renamed from the
                            // misleading `healthPercent`).
                            serde_json::json!({
                                "type": "damageDealt",
                                "defenderName": data.defender_name,
                                "damage": data.damage,
                                "damageType": damage_type_label(data.damage_type),
                                "severity": data.health_percent,
                                "criticalHit": data.critical_hit,
                                "attackConditions": data.attack_conditions.bits(),
                            })
                            .to_string(),
                        ),
                        u32_payload: None,
                        u32_payload_2: None,
                        f32_payload: None,
                    });
                }
                holtburger_protocol::messages::GameEvent::DefenderNotification(
                    data,
                ) => {
                    // F10-2 — retail defender line, e.g.
                    // "Banderling bashes you for 18 points
                    // of damage to your chest!". Plural
                    // verb form; `health_percent` is the
                    // severity (damage / MaxHealth), used
                    // for the verb only.
                    let prefix = attack_conditions_prefix(
                        data.critical_hit,
                        data.attack_conditions,
                    );
                    let verb = damage_severity_verb(
                        data.damage_type,
                        data.health_percent,
                        true,
                    );
                    let pts = if data.damage == 1 { "point" } else { "points" };
                    let line = format!(
                        "{}{} {} you for {} {} of damage to your {}!",
                        prefix,
                        data.attacker_name,
                        verb,
                        data.damage,
                        pts,
                        damage_location_label(data.damage_location),
                    );
                    queued_events.borrow_mut().push(ClientEvent {
                        kind: CLIENT_EVENT_KIND_CHAT_RECEIVED,
                        string_payload: Some(line),
                        u32_payload: Some(0),
                        u32_payload_2: Some(CHAT_CATEGORY_COMBAT),
                        f32_payload: None,
                    });
                    queued_events.borrow_mut().push(ClientEvent {
                        kind: CLIENT_EVENT_KIND_COMBAT_EVENT,
                        string_payload: Some(
                            // F10-2 — `severity` = damage /
                            // MaxHealth (renamed from the
                            // misleading `healthPercent`).
                            serde_json::json!({
                                "type": "damageTaken",
                                "attackerName": data.attacker_name,
                                "damage": data.damage,
                                "damageType": damage_type_label(data.damage_type),
                                "damageLocation": damage_location_label(data.damage_location),
                                "severity": data.health_percent,
                                "criticalHit": data.critical_hit,
                                "attackConditions": data.attack_conditions.bits(),
                            })
                            .to_string(),
                        ),
                        u32_payload: None,
                        u32_payload_2: None,
                        f32_payload: None,
                    });
                }
                holtburger_protocol::messages::GameEvent::EvasionAttackerNotification(
                    data,
                ) => {
                    queued_events.borrow_mut().push(ClientEvent {
                        kind: CLIENT_EVENT_KIND_CHAT_RECEIVED,
                        string_payload: Some(format!(
                            "{} evaded your attack.",
                            data.defender_name
                        )),
                        u32_payload: Some(0),
                        u32_payload_2: Some(CHAT_CATEGORY_COMBAT),
                        f32_payload: None,
                    });
                    queued_events.borrow_mut().push(ClientEvent {
                        kind: CLIENT_EVENT_KIND_COMBAT_EVENT,
                        string_payload: Some(
                            serde_json::json!({
                                "type": "evadedTarget",
                                "defenderName": data.defender_name,
                            })
                            .to_string(),
                        ),
                        u32_payload: None,
                        u32_payload_2: None,
                        f32_payload: None,
                    });
                }
                holtburger_protocol::messages::GameEvent::EvasionDefenderNotification(
                    data,
                ) => {
                    queued_events.borrow_mut().push(ClientEvent {
                        kind: CLIENT_EVENT_KIND_CHAT_RECEIVED,
                        string_payload: Some(format!(
                            "You evaded {}'s attack.",
                            data.attacker_name
                        )),
                        u32_payload: Some(0),
                        u32_payload_2: Some(CHAT_CATEGORY_COMBAT),
                        f32_payload: None,
                    });
                    queued_events.borrow_mut().push(ClientEvent {
                        kind: CLIENT_EVENT_KIND_COMBAT_EVENT,
                        string_payload: Some(
                            serde_json::json!({
                                "type": "evadedAttacker",
                                "attackerName": data.attacker_name,
                            })
                            .to_string(),
                        ),
                        u32_payload: None,
                        u32_payload_2: None,
                        f32_payload: None,
                    });
                }
                holtburger_protocol::messages::GameEvent::AttackDone(data) => {
                    // ACE marks the end of a swing
                    // sequence — power bar can refill
                    // for the next swing. `data.error`
                    // is the WeenieError code (None on
                    // success, e.g. YoureTooBusy /
                    // YouCantDoThatWhileInTheAir on
                    // rejection).
                    queued_events.borrow_mut().push(ClientEvent {
                        kind: CLIENT_EVENT_KIND_COMBAT_EVENT,
                        string_payload: Some(
                            serde_json::json!({
                                "type": "attackDone",
                                "error": format!("{:?}", data.error),
                            })
                            .to_string(),
                        ),
                        u32_payload: None,
                        u32_payload_2: None,
                        f32_payload: None,
                    });
                }
                holtburger_protocol::messages::GameEvent::CombatCommenceAttack => {
                    // Server is about to fire the next
                    // auto-repeat swing — UI shows the
                    // hourglass / wind-up indicator.
                    queued_events.borrow_mut().push(ClientEvent {
                        kind: CLIENT_EVENT_KIND_COMBAT_EVENT,
                        string_payload: Some(
                            serde_json::json!({
                                "type": "combatCommenceAttack",
                            })
                            .to_string(),
                        ),
                        u32_payload: None,
                        u32_payload_2: None,
                        f32_payload: None,
                    });
                }
                holtburger_protocol::messages::GameEvent::VictimNotification(
                    data,
                ) => {
                    // ACE pre-formats the line — "You
                    // have died!" / "Drudge slew you!"
                    // / "You killed yourself with a
                    // spell!" — so just relay it.
                    queued_events.borrow_mut().push(ClientEvent {
                        kind: CLIENT_EVENT_KIND_CHAT_RECEIVED,
                        string_payload: Some(data.death_message.clone()),
                        u32_payload: Some(0),
                        u32_payload_2: Some(CHAT_CATEGORY_DEATH),
                        f32_payload: None,
                    });
                }
                holtburger_protocol::messages::GameEvent::KillerNotification(
                    data,
                ) => {
                    // Survivor's POV: "You killed the
                    // drudge!"
                    queued_events.borrow_mut().push(ClientEvent {
                        kind: CLIENT_EVENT_KIND_CHAT_RECEIVED,
                        string_payload: Some(data.death_message.clone()),
                        u32_payload: Some(0),
                        u32_payload_2: Some(CHAT_CATEGORY_DEATH),
                        f32_payload: None,
                    });
                }
                holtburger_protocol::messages::GameEvent::PlayerDescription(
                    data,
                ) => {
                    // Phase 4 step 3.7: hydrate from
                    // PlayerDescription so subsequent
                    // movement reads the player's real
                    // run rate / motion table / skills.
                    //
                    // Phase 4 step 4 follow-on: the
                    // hydrate / apply / emit-derived-
                    // stats trio is now handled by the
                    // canonical world handler dispatcher
                    // up at the top of the recv-loop's
                    // per-message processing block (the
                    // `should_route_message_to_world` →
                    // `routing::handle_message` call).
                    // What stays in this arm is the
                    // movement-capabilities-override
                    // bookkeeping that step 3.6/3.7
                    // owns: clear the bootstrap-time
                    // fallback, verify real caps now
                    // resolve, and defensively re-install
                    // the fallback if they don't.
                    //
                    // Academy seed (2026-05-10): for
                    // fresh-character spawns ACE never
                    // sends `UpdatePosition` /
                    // `PrivateUpdatePosition` for the
                    // local player guid (ACE's
                    // `Player_Networking.SendSelf` order
                    // is PlayerDescription → PlayerCreate
                    // → CreateObject; the position rides
                    // on PlayerDescription, not a
                    // dedicated position update). Without
                    // this fall-through the player
                    // entity never gets seeded and the
                    // integrator no-ops every tick. Seed
                    // here when `data.pos` is `Some`,
                    // matching the pattern at
                    // `:8866-8888` (UpdatePosition path)
                    // and `:8970-8983`
                    // (PrivateUpdatePosition path); the
                    // existing teleport / motion arms
                    // overwrite via `set_player_position`
                    // once `entity_seeded` is true.
                    if let Some(w) = world.borrow_mut().as_mut() {
                        // Gate on `w.player.guid` (set at
                        // SelectCharacter time, before
                        // PlayerDescription arrives) rather
                        // than `LoopState::InWorld` —
                        // PlayerDescription typically
                        // races PlayerCreate by a few ms,
                        // and PlayerCreate is what
                        // transitions to InWorld. So at
                        // PlayerDescription handling time
                        // the loop state is still
                        // `EnteringWorld`, but `w.player.
                        // guid` already matches `data.guid`
                        // for the local player.
                        if !*entity_seeded
                            && data.guid == w.player.guid
                            && data.guid != holtburger_common::Guid::NULL
                        {
                            if let Some(pos) = data.pos {
                                let entity =
                                    holtburger_world::entity::Entity::new(
                                        data.guid,
                                        String::from("LocalPlayer"),
                                        pos,
                                    );
                                w.add_entity(entity);
                                let _ = w
                                    .set_local_player_runtime_pose(pos);
                                *entity_seeded = true;
                                console_log_str(&format!(
                                    "[step 3.7] WorldState player entity seeded via PlayerDescription at landblock=0x{:08X} ({:.1}, {:.1}, {:.1})",
                                    u32::from(pos.landblock_id),
                                    pos.coords.x,
                                    pos.coords.y,
                                    pos.coords.z,
                                ));
                                if !*heartbeat_armed {
                                    let now = web_time::Instant::now();
                                    movement
                                        .arm_heartbeat_schedule(now, w);
                                    *heartbeat_armed = true;
                                    console_log_str(
                                        "[step 3.7] AutonomousPosition heartbeat armed",
                                    );
                                }
                            } else {
                                console_log_str(
                                    "[step 3.7] PlayerDescription arrived without pos field — entity remains unseeded; waiting for UpdatePosition",
                                );
                            }
                        }
                        w.clear_self_movement_capabilities_override();
                        let real_caps_ok = w
                            .resolve_self_movement_capabilities()
                            .is_ok();
                        console_log_str(&format!(
                            "[step 3.7] PlayerDescription handled; \
                             fallback caps cleared (real_caps_ok={})",
                            real_caps_ok,
                        ));
                        if !real_caps_ok {
                            let fallback =
                                fallback_self_movement_capabilities();
                            w.set_self_movement_capabilities_override(
                                fallback,
                            );
                            console_log_str(
                                "[step 3.7] real biota didn't resolve; \
                                 fallback caps re-installed",
                            );
                        }
                    }
                }
                holtburger_protocol::messages::GameEvent::ApproachVendor(
                    data,
                ) => {
                    // Vendor UI (2026-05-19): cache the
                    // full vendor state (items + multipliers
                    // + alt currency) so JS can pull it via
                    // SessionHandle::get_vendor_state(guid)
                    // when plugins/vendor-ui.js renders the
                    // trade panel. Multi-vendor: keyed by
                    // vendor guid so opening a second
                    // doesn't clobber the first.
                    {
                        let vendor_guid_u32 = u32::from(data.vendor_guid);
                        let vendor_name_for_cache = world.borrow()
                            .as_ref()
                            .and_then(|w| {
                                w.entities.get(data.vendor_guid).map(|entity| {
                                    use holtburger_common::properties::WorldObjectExt as _;
                                    entity.name().to_string()
                                })
                            })
                            .unwrap_or_else(|| "Vendor".to_string());
                        let items: Vec<VendorStateItem> = data
                            .items
                            .iter()
                            .map(|item| {
                                let desc = &item.description;
                                VendorStateItem {
                                    item_guid: u32::from(desc.guid),
                                    wcid: desc.wcid,
                                    name: desc
                                        .name
                                        .clone()
                                        .unwrap_or_default(),
                                    value: desc.value.unwrap_or(0),
                                    stack_size: desc.stack_size.unwrap_or(1),
                                    item_type: desc.item_type,
                                    icon_id: desc.icon_id,
                                }
                            })
                            .collect();
                        latest_vendor_state.borrow_mut().insert(
                            vendor_guid_u32,
                            VendorState {
                                vendor_guid: vendor_guid_u32,
                                vendor_name: vendor_name_for_cache,
                                buy_multiplier: data.buy_multiplier,
                                sell_multiplier: data.sell_multiplier,
                                alternate_currency_wcid: data
                                    .alternate_currency_wcid,
                                alternate_currency_amount: data
                                    .alternate_currency_amount,
                                alternate_currency_name: data
                                    .alternate_currency_name
                                    .clone(),
                                items,
                                // Wave F.4 (2026-05-27): persist the
                                // typed-profile fields the wire already
                                // carries. Surfaced via
                                // `getCurrentVendorProfile`.
                                merchandise_item_types: data
                                    .merchandise_item_types,
                                min_value: data.merchandise_min_value,
                                max_value: data.merchandise_max_value,
                                deals_magic: data.deal_magical_items
                                    != 0,
                            },
                        );
                    }
                    // Phase 4 step 5 (interactive
                    // entities): the player clicked a
                    // vendor (a Creature weenie with
                    // merchandise) and ACE responded
                    // with the vendor's item list +
                    // buy/sell multipliers. Surface as
                    // kind=12 VendorOpened so JS can
                    // pop a vendor window (or a status
                    // line for the first-cut UI).
                    //
                    // The vendor's display name comes
                    // from `world.entities` if the
                    // entity was previously tracked —
                    // otherwise we fall back to a
                    // generic "Vendor" label. ACE's
                    // `ApproachVendorEventData` itself
                    // doesn't carry the vendor name on
                    // the wire (just the guid + item
                    // list); the cli looks it up via
                    // `state.entities.get(vendor_guid).name()`.
                    let vendor_guid = u32::from(data.vendor_guid);
                    let vendor_name = world.borrow()
                        .as_ref()
                        .and_then(|w| {
                            w.entities.get(data.vendor_guid).map(
                                |entity| {
                                    use holtburger_common::properties::WorldObjectExt as _;
                                    entity.name().to_string()
                                },
                            )
                        })
                        .unwrap_or_else(|| "Vendor".to_string());
                    let item_count = data.items.len() as u32;
                    queued_events.borrow_mut().push(ClientEvent {
                        kind: CLIENT_EVENT_KIND_VENDOR_OPENED,
                        string_payload: Some(vendor_name.clone()),
                        u32_payload: Some(vendor_guid),
                        u32_payload_2: Some(item_count),
                        f32_payload: None,
                    });
                    // Also surface as a chat line so
                    // the user sees something even
                    // before the vendor-window UI
                    // lands. Format mirrors the cli.
                    queued_events.borrow_mut().push(ClientEvent {
                        kind: CLIENT_EVENT_KIND_CHAT_RECEIVED,
                        string_payload: Some(format!(
                            "[Vendor] {vendor_name} has {item_count} items for sale."
                        )),
                        u32_payload: Some(0),
                        u32_payload_2: Some(CHAT_CATEGORY_TRADE),
                        f32_payload: None,
                    });
                }
                holtburger_protocol::messages::GameEvent::ViewContents(data) => {
                    // PR-HH 2026-05-23: non-vendor
                    // container opened (chest, corpse,
                    // salvage bag, etc.). Server-side
                    // `Container.Open()` sends N
                    // `GameMessageCreateObject` per
                    // contained item FIRST (which the
                    // entity store has already absorbed
                    // by the time we reach this arm),
                    // then one `GameEventViewContents`
                    // = (container_guid, [(item_guid,
                    // container_type), …]). We just
                    // cache the GUID list; JS reads
                    // item details out of the entity
                    // store by guid.
                    let container_guid_u32 = u32::from(data.container);
                    let item_guids: Vec<u32> = data
                        .items
                        .iter()
                        .map(|i| u32::from(i.guid))
                        .collect();
                    let item_count = item_guids.len() as u32;
                    // Populate icon cache while world.entities
                    // still holds the contained items. Items
                    // have model_id=0 so the JS spawn gate
                    // drops them before entityMap.set() — this
                    // is the only reliable icon_id source for
                    // the container-panel.
                    let world_guard = world.borrow();
                    if let Some(ref w) = *world_guard {
                        let mut icons = latest_object_icons.borrow_mut();
                        for i in data.items.iter() {
                            let ig = u32::from(i.guid);
                            if let Some(entity) = w.entities.get(i.guid) {
                                icons.insert(ig, entity.icon_id.unwrap_or(0));
                            }
                        }
                    }
                    let container_name = world.borrow()
                        .as_ref()
                        .and_then(|w| {
                            w.entities.get(data.container).map(|entity| {
                                use holtburger_common::properties::WorldObjectExt as _;
                                entity.name().to_string()
                            })
                        })
                        .unwrap_or_else(|| "Container".to_string());
                    latest_container_contents
                        .borrow_mut()
                        .insert(container_guid_u32, item_guids);
                    // rynth Phase 2: last-opened ground
                    // container (GetGroundContainerId).
                    *rynth_ground_container.borrow_mut() =
                        container_guid_u32;
                    queued_events.borrow_mut().push(ClientEvent {
                        kind: CLIENT_EVENT_KIND_CONTAINER_OPENED,
                        string_payload: Some(container_name),
                        u32_payload: Some(container_guid_u32),
                        u32_payload_2: Some(item_count),
                        f32_payload: None,
                    });
                }
                holtburger_protocol::messages::GameEvent::UseDone(data) => {
                    // Phase 4 step 5: ACE confirms the
                    // player's `Use` action completed.
                    // `error == None` is success
                    // (door opened, container
                    // approached, etc.); non-None
                    // routes to kind=13 UseFailed
                    // instead.
                    use holtburger_protocol::errors::WeenieError;
                    // rynth Phase 2: UseDone fires on
                    // EVERY action finish — completed or
                    // refused (RynthCoreHost GetUseDoneSeq
                    // contract). Count both; also retire
                    // one shadow-busy slot (floor 0).
                    *rynth_use_done_seq.borrow_mut() += 1;
                    {
                        let mut busy = rynth_busy.borrow_mut();
                        busy.0 = busy.0.saturating_sub(1);
                        busy.1 = Some(web_time::Instant::now());
                    }
                    if data.error == WeenieError::None {
                        queued_events.borrow_mut().push(ClientEvent {
                            kind: CLIENT_EVENT_KIND_USE_DONE,
                            string_payload: None,
                            u32_payload: None,
                            u32_payload_2: None,
                            f32_payload: None,
                        });
                    } else {
                        let label = format!("{:?}", data.error);
                        let code = data.error as u32;
                        queued_events.borrow_mut().push(ClientEvent {
                            kind: CLIENT_EVENT_KIND_USE_FAILED,
                            string_payload: Some(label.clone()),
                            u32_payload: Some(code),
                            u32_payload_2: None,
                            f32_payload: None,
                        });
                        // Spell-cast rejections (components /
                        // mana / range / indoors / in-air —
                        // ACE Player_Magic SendUseDoneEvent
                        // sites) get the retail client text
                        // as a transient toast-line; every
                        // other use-failure keeps the
                        // generic labelled system line.
                        let (message, category) =
                            match spellcast_error_text(code) {
                                Some(text) => (
                                    text.to_string(),
                                    CHAT_CATEGORY_TRANSIENT,
                                ),
                                None => (
                                    format!("[Use failed] {label}"),
                                    CHAT_CATEGORY_SYSTEM,
                                ),
                            };
                        queued_events.borrow_mut().push(ClientEvent {
                            kind: CLIENT_EVENT_KIND_CHAT_RECEIVED,
                            string_payload: Some(message),
                            u32_payload: Some(0),
                            u32_payload_2: Some(category),
                            f32_payload: None,
                        });
                    }
                }
                holtburger_protocol::messages::GameEvent::InventoryServerSaveFailed(
                    data,
                ) => {
                    // Equip/move rejection (0x00A0). ACE sends
                    // this when GetAndWieldItem bounces (slot
                    // occupied, weapon collision, ammo-type
                    // mismatch — Player_Inventory.cs
                    // CheckWeaponCollision). Previously
                    // UNHANDLED → silent paperdoll no-ops.
                    // The wire event names the item, so
                    // emit the AUTHORITATIVE kind=48
                    // InventoryActionFailed (item GUID +
                    // WeenieError) — NOT kind=13, which made
                    // rejection_feedback.js guess the item
                    // from a 2 s recent-action ring and
                    // could trip the kind=13 cast-reject
                    // hooks. The transient chat line still
                    // renders the toast/chat-log copy.
                    let code = data.error as u32;
                    let label = format!("{:?}", data.error);
                    queued_events.borrow_mut().push(ClientEvent {
                        kind: CLIENT_EVENT_KIND_INVENTORY_ACTION_FAILED,
                        string_payload: Some(label.clone()),
                        u32_payload: Some(data.item_guid.0),
                        u32_payload_2: Some(code),
                        f32_payload: None,
                    });
                    let message = if code == 0 {
                        "You can't wield that!".to_string()
                    } else {
                        format!("[Wield failed] {label}")
                    };
                    queued_events.borrow_mut().push(ClientEvent {
                        kind: CLIENT_EVENT_KIND_CHAT_RECEIVED,
                        string_payload: Some(message),
                        u32_payload: Some(0),
                        u32_payload_2: Some(CHAT_CATEGORY_TRANSIENT),
                        f32_payload: None,
                    });
                }
                holtburger_protocol::messages::GameEvent::WeenieError(
                    data,
                ) => {
                    // Phase 4 step 5: ACE sends
                    // `WeenieError` for many non-use
                    // reasons too — channel-join
                    // notifications
                    // (`YouHaveEnteredTheChannel(...)`,
                    // `TurbineChatIsEnabled`),
                    // chat-system info, fellowship /
                    // trade hints, etc. Surface every
                    // one as a kind=2 system chat
                    // line; the cli also routes them
                    // to chat. Use-failed semantics
                    // come exclusively from
                    // `UseDone(error != None)` so we
                    // don't false-positive on
                    // info-channel errors — EXCEPT the
                    // spell-cast subset below: ACE's
                    // `DoCastSpell_Inner` reports a
                    // fizzle via `SendWeenieError`
                    // (0x028A), never via UseDone, so
                    // these ALSO push kind=13 (the F8-2
                    // cast-cancel hook keys on it) and
                    // render the retail text as a
                    // transient toast-line instead of
                    // the raw Debug label.
                    let label = format!("{:?}", data.error);
                    let code = data.error as u32;
                    if let Some(text) = spellcast_error_text(code) {
                        queued_events.borrow_mut().push(ClientEvent {
                            kind: CLIENT_EVENT_KIND_USE_FAILED,
                            string_payload: Some(label),
                            u32_payload: Some(code),
                            u32_payload_2: None,
                            f32_payload: None,
                        });
                        queued_events.borrow_mut().push(ClientEvent {
                            kind: CLIENT_EVENT_KIND_CHAT_RECEIVED,
                            string_payload: Some(text.to_string()),
                            u32_payload: Some(0),
                            u32_payload_2: Some(CHAT_CATEGORY_TRANSIENT),
                            f32_payload: None,
                        });
                    } else {
                        // HUD overhaul 2026-10-05: the chat line is
                        // what the PLAYER reads, so render the retail
                        // English text (holtburger-core's template
                        // table, PascalCase→sentence fallback) rather
                        // than the Rust Debug label — the log used to
                        // show `YouHaveEnteredTheChannel(General)`.
                        // Consumers key on the u32 code, never this
                        // string.
                        let text = holtburger_core::errors::format_weenie_error(
                            data.error, None,
                        );
                        queued_events.borrow_mut().push(ClientEvent {
                            kind: CLIENT_EVENT_KIND_CHAT_RECEIVED,
                            string_payload: Some(text),
                            u32_payload: Some(code),
                            u32_payload_2: Some(CHAT_CATEGORY_SYSTEM),
                            f32_payload: None,
                        });
                    }
                }
                holtburger_protocol::messages::GameEvent::WeenieErrorWithString(
                    data,
                ) => {
                    // Phase 4 step 5: WeenieError +
                    // parameter string. Same kind=2
                    // chat treatment as the bare
                    // WeenieError arm; no kind=13.
                    // HUD overhaul 2026-10-05: retail English with
                    // the parameter substituted (see the arm above).
                    let label = holtburger_core::errors::format_weenie_error(
                        data.error,
                        Some(data.parameter.as_str()),
                    );
                    let code = data.error as u32;
                    queued_events.borrow_mut().push(ClientEvent {
                        kind: CLIENT_EVENT_KIND_CHAT_RECEIVED,
                        string_payload: Some(label),
                        u32_payload: Some(code),
                        u32_payload_2: Some(CHAT_CATEGORY_SYSTEM),
                        f32_payload: None,
                    });
                }
                holtburger_protocol::messages::GameEvent::MagicUpdateSpell(
                    data,
                ) => {
                    // K.1 follow-on (handoff validation gap #5):
                    // ACE broadcasts this every time a spell is
                    // added to the player's spellbook (e.g. via
                    // `@addspell <id>`, scroll learning, or
                    // class progression). Pre-fix the wasm side
                    // dropped it to the catch-all, so the
                    // Spellbook plugin only saw spells from the
                    // initial PlayerDescription burst and
                    // showed "No spells known" after any
                    // mid-session learn. Append to the wasm-
                    // side cache + emit a stats-updated event
                    // so the spellbook plugin re-renders.
                    let spell_id = data.spell_id as u32;
                    {
                        let mut book = latest_known_spells.borrow_mut();
                        if !book.contains(&spell_id) {
                            book.push(spell_id);
                        }
                    }
                    queued_events.borrow_mut().push(ClientEvent {
                        kind: CLIENT_EVENT_KIND_PLAYER_STATS_UPDATED,
                        string_payload: None,
                        u32_payload: Some(spell_id),
                        u32_payload_2: None,
                        f32_payload: None,
                    });
                }
                holtburger_protocol::messages::GameEvent::MagicRemoveSpell(
                    data,
                ) => {
                    // Phase J was C2S-only — ACE's matching
                    // S→C broadcast (this) wasn't wired here,
                    // so a successful remove silently left the
                    // client cache stale (the spell stayed in
                    // the spellbook even after ACE removed it).
                    // Symmetric fix to the MagicUpdateSpell
                    // arm above.
                    let spell_id = data.spell_id as u32;
                    {
                        let mut book = latest_known_spells.borrow_mut();
                        book.retain(|&id| id != spell_id);
                    }
                    queued_events.borrow_mut().push(ClientEvent {
                        kind: CLIENT_EVENT_KIND_PLAYER_STATS_UPDATED,
                        string_payload: None,
                        u32_payload: Some(spell_id),
                        u32_payload_2: None,
                        f32_payload: None,
                    });
                }
                holtburger_protocol::messages::GameEvent::PingResponse(_) => {
                    // PR-SS.1 2026-05-23: real RTT for
                    // the link-status indicator. Empty
                    // payload on both Request + Response
                    // (see protocol/messages/network/
                    // events.rs) so we can't multiplex —
                    // we always treat the response as
                    // matching the most recent send. The
                    // keepalive runs every 5s gated by
                    // last_send_time, so at most one
                    // outstanding ping at any time.
                    let rtt_ms = PING_SEND_INSTANT.with(|c| {
                        let mut slot = c.borrow_mut();
                        slot.take().map(|sent| {
                            web_time::Instant::now()
                                .saturating_duration_since(sent)
                                .as_millis()
                                .min(u32::MAX as u128)
                                as u32
                        })
                    });
                    if let Some(rtt) = rtt_ms {
                        *last_ping_rtt_ms.borrow_mut() = Some(rtt);
                    }
                }
                holtburger_protocol::messages::GameEvent::BookModifyPageResponse(
                    data,
                ) => {
                    // ACE acked the modify. Signal JS so
                    // it can re-fetch fresh page content
                    // via bookData(); the page-mod
                    // responses don't carry the new text.
                    queued_events.borrow_mut().push(ClientEvent {
                        kind: CLIENT_EVENT_KIND_BOOK_UPDATED,
                        string_payload: None,
                        u32_payload: Some(u32::from(data.object_guid)),
                        u32_payload_2: Some(u32::from(data.success)),
                        f32_payload: None,
                    });
                }
                holtburger_protocol::messages::GameEvent::BookAddPageResponse(
                    data,
                ) => {
                    queued_events.borrow_mut().push(ClientEvent {
                        kind: CLIENT_EVENT_KIND_BOOK_UPDATED,
                        string_payload: None,
                        u32_payload: Some(u32::from(data.object_guid)),
                        u32_payload_2: Some(u32::from(data.success)),
                        f32_payload: None,
                    });
                }
                holtburger_protocol::messages::GameEvent::BookDeletePageResponse(
                    data,
                ) => {
                    queued_events.borrow_mut().push(ClientEvent {
                        kind: CLIENT_EVENT_KIND_BOOK_UPDATED,
                        string_payload: None,
                        u32_payload: Some(u32::from(data.object_guid)),
                        u32_payload_2: Some(u32::from(data.success)),
                        f32_payload: None,
                    });
                }
                holtburger_protocol::messages::GameEvent::AllegianceUpdate(
                    data,
                ) => {
                    // Wave-F2 (2026-05-26): fold the wire
                    // payload directly (no world-state
                    // intermediate). `own_guid` resolves
                    // from `world.player.guid` when the
                    // WorldState is up — AllegianceUpdate
                    // only fires post-EnteredWorld, so
                    // pre-world is unreachable in practice.
                    let own_guid = world.borrow()
                        .as_ref()
                        .map(|w| u32::from(w.player.guid))
                        .unwrap_or(0);
                    publish_player_allegiance_snapshot(
                        data.as_ref(),
                        own_guid,
                        &latest_allegiance,
                    );
                    queued_events.borrow_mut().push(ClientEvent {
                        kind: CLIENT_EVENT_KIND_ALLEGIANCE_UPDATED,
                        string_payload: None,
                        u32_payload: None,
                        u32_payload_2: None,
                        f32_payload: None,
                    });
                }
                holtburger_protocol::messages::GameEvent::AllegianceLoginNotification(
                    data,
                ) => {
                    // Wave-F3 (2026-05-27): an allegiance
                    // member logged in or out. ACE pushes
                    // `Allegiance_AllegianceLoginNotification`
                    // (opcode 0x027A). Forward the wire
                    // GUID+flag to JS; the panel reads
                    // the name out of the cached hierarchy.
                    // Also flip the `logged_in` flag on
                    // any cached member matching the GUID
                    // so re-renders pick up immediately.
                    {
                        let mut cell = latest_allegiance.borrow_mut();
                        if let Some(snap) = cell.as_mut() {
                            let guid = data.character_id.0;
                            let flag = data.is_logged_in;
                            if let Some(m) = snap.monarch.as_mut() {
                                if m.guid == guid {
                                    m.logged_in = flag;
                                }
                            }
                            if let Some(m) = snap.patron.as_mut() {
                                if m.guid == guid {
                                    m.logged_in = flag;
                                }
                            }
                            if let Some(m) = snap.myself.as_mut() {
                                if m.guid == guid {
                                    m.logged_in = flag;
                                }
                            }
                            for v in snap.vassals.iter_mut() {
                                if v.guid == guid {
                                    v.logged_in = flag;
                                }
                            }
                        }
                    }
                    queued_events.borrow_mut().push(ClientEvent {
                        kind: CLIENT_EVENT_KIND_ALLEGIANCE_PRESENCE,
                        string_payload: None,
                        u32_payload: Some(data.character_id.0),
                        u32_payload_2: Some(u32::from(data.is_logged_in)),
                        f32_payload: None,
                    });
                }
                holtburger_protocol::messages::GameEvent::AllegianceInfoResponse(
                    data,
                ) => {
                    // Wave-F3 (2026-05-27): server reply
                    // to an `Allegiance_AllegianceInfoRequest`
                    // query (opcode 0x027C). The payload
                    // is a full `AllegianceProfile` for
                    // the queried target — useful for
                    // examining other players'
                    // allegiance trees. Cache the latest
                    // for the panel + emit kind=41.
                    *latest_allegiance_info.borrow_mut() =
                        Some(*data.clone());
                    queued_events.borrow_mut().push(ClientEvent {
                        kind: CLIENT_EVENT_KIND_ALLEGIANCE_INFO,
                        string_payload: None,
                        u32_payload: Some(data.target_id.0),
                        u32_payload_2: None,
                        f32_payload: None,
                    });
                }
                holtburger_protocol::messages::GameEvent::FriendsListUpdate(
                    data,
                ) => {
                    // Wave-H1 (2026-05-26): fold the wire
                    // payload per update_type semantics
                    // (FullList replaces, deltas mutate).
                    publish_player_friends_snapshot(
                        data.as_ref(),
                        &latest_friends,
                    );
                    queued_events.borrow_mut().push(ClientEvent {
                        kind: CLIENT_EVENT_KIND_FRIENDS_UPDATED,
                        string_payload: None,
                        u32_payload: None,
                        u32_payload_2: None,
                        f32_payload: None,
                    });
                }
                holtburger_protocol::messages::GameEvent::SetSquelchDb(
                    data,
                ) => {
                    // Wave-H3 (2026-05-26): full DB
                    // replace — ACE pushes once at
                    // login; no deltas (per-row mods
                    // round-trip via the modify*Squelch
                    // GameActions but ACE doesn't
                    // re-push the DB).
                    publish_player_squelch_snapshot(
                        data.as_ref(),
                        &latest_squelch,
                    );
                    queued_events.borrow_mut().push(ClientEvent {
                        kind: CLIENT_EVENT_KIND_SQUELCH_UPDATED,
                        string_payload: None,
                        u32_payload: None,
                        u32_payload_2: None,
                        f32_payload: None,
                    });
                }
                holtburger_protocol::messages::GameEvent::CharacterTitle(
                    data,
                ) => {
                    // Wave-H3 (2026-05-26): full catalog
                    // replace — ACE pushes once at login.
                    publish_player_title_snapshot(
                        data.as_ref(),
                        &latest_title,
                    );
                    queued_events.borrow_mut().push(ClientEvent {
                        kind: CLIENT_EVENT_KIND_TITLE_UPDATED,
                        string_payload: None,
                        u32_payload: None,
                        u32_payload_2: None,
                        f32_payload: None,
                    });
                }
                holtburger_protocol::messages::GameEvent::UpdateTitle(
                    data,
                ) => {
                    // Wave-H3 (2026-05-26): single-title
                    // delta — earn the title (append to
                    // catalog if not present) and
                    // optionally promote to active.
                    apply_player_title_update(
                        data.as_ref(),
                        &latest_title,
                    );
                    queued_events.borrow_mut().push(ClientEvent {
                        kind: CLIENT_EVENT_KIND_TITLE_UPDATED,
                        string_payload: None,
                        u32_payload: None,
                        u32_payload_2: None,
                        f32_payload: None,
                    });
                }
                holtburger_protocol::messages::GameEvent::HouseStatus(
                    data,
                ) => {
                    // Wave L2 (2026-05-26): ACE wire is
                    // `(uint)weenieError` only. Cache the
                    // code into `latest_house_status` for
                    // the sync getter; no bus event — the
                    // panel polls on `playerStatsUpdated`.
                    *latest_house_status.borrow_mut() =
                        Some(HouseStatus {
                            error_code: data.error as u32,
                        });
                }
                holtburger_protocol::messages::GameEvent::HouseData(
                    data,
                ) => {
                    // Wave M2 (2026-05-26): cache owner-
                    // side house metadata. ACE wire per
                    // `HouseData.Write()`: u32 BuyTime,
                    // u32 RentTime, u32 HouseType, u32
                    // MaintenanceFree, List<Buy>, List<Rent>,
                    // Position. We pick up the scalar +
                    // position fields; payment-list display
                    // is not modeled in this snapshot.
                    *latest_house_data.borrow_mut() =
                        Some(HouseData {
                            buy_time: data.buy_time,
                            rent_time: data.rent_time,
                            house_type: data.house_type,
                            maintenance_free: data.maintenance_free,
                            landblock_id: u32::from(data.position.landblock_id),
                            pos_x: data.position.coords.x,
                            pos_y: data.position.coords.y,
                            pos_z: data.position.coords.z,
                        });
                }
                holtburger_protocol::messages::GameEvent::HouseProfile(
                    data,
                ) => {
                    // Wave M3 (2026-05-26): ACE wire is
                    // `u32 crystal_guid` + `HouseProfile.Write()`
                    // (dwelling header + owner-name string +
                    // buy/rent payment lists). We retain the
                    // header scalars + OwnerName.
                    *latest_house_profile.borrow_mut() =
                        Some(HouseProfile {
                            crystal_guid: u32::from(data.crystal_guid),
                            dwelling_id: data.dwelling_id,
                            owner_id: u32::from(data.owner_id),
                            bitmask: data.bitmask,
                            house_type: data.house_type,
                            maintenance_free: data.maintenance_free,
                            owner_name: data.owner_name.clone(),
                        });
                }
                holtburger_protocol::messages::GameEvent::HouseUpdateRestrictions(
                    data,
                ) => {
                    // Wave M3 (2026-05-26): ACE wire per
                    // `RestrictionDB.Write()`: u32 Version,
                    // u32 OpenStatus, u32 MonarchID,
                    // PackableHashTable<guid, storage_flag>.
                    // Surface count + storage-count for the
                    // panel; the full guest map is not in
                    // this snapshot.
                    let storage_count = data
                        .guests
                        .values()
                        .filter(|v| **v != 0)
                        .count() as u32;
                    *latest_house_restrictions.borrow_mut() =
                        Some(HouseRestrictions {
                            object_guid: u32::from(data.object_guid),
                            version: data.version,
                            open_status: data.open_status,
                            monarch_id: u32::from(data.monarch_id),
                            guest_count: data.guests.len() as u32,
                            storage_count,
                        });
                }
                holtburger_protocol::messages::GameEvent::SendClientContractTrackerTable(
                    data,
                ) => {
                    // Wave F.5 (2026-05-27): full
                    // contract-tracker push at login
                    // (ACE `Player_Networking.SendContractTrackerTable`
                    // when `GetContractsCount > 0`).
                    // Wholesale replace; sort by
                    // contract_id for a stable display
                    // order (ACE's wire order follows
                    // HashComparer bucketing).
                    apply_player_contracts_full(
                        data.as_ref(),
                        &latest_contracts,
                    );
                    queued_events.borrow_mut().push(ClientEvent {
                        kind: CLIENT_EVENT_KIND_CONTRACTS_UPDATED,
                        string_payload: None,
                        u32_payload: None,
                        u32_payload_2: None,
                        f32_payload: None,
                    });
                }
                holtburger_protocol::messages::GameEvent::SendClientContractTracker(
                    data,
                ) => {
                    // Wave F.5 (2026-05-27): single-
                    // contract delta from ACE
                    // `ContractManager.Add` / `Erase` /
                    // `Update`. `delete_contract`
                    // routes to remove-by-id; otherwise
                    // upsert by contract_id. JS payload
                    // carries (contract_id, deleted-flag)
                    // so panel logic can react to add /
                    // remove without diffing snapshots.
                    apply_player_contracts_delta(
                        data.as_ref(),
                        &latest_contracts,
                    );
                    queued_events.borrow_mut().push(ClientEvent {
                        kind: CLIENT_EVENT_KIND_CONTRACTS_UPDATED,
                        string_payload: None,
                        u32_payload: Some(data.tracker.contract_id),
                        u32_payload_2: Some(
                            if data.delete_contract { 1 } else { 0 },
                        ),
                        f32_payload: None,
                    });
                }
                // === Wave 6.C — Portal Storm dispatch (2026-05-28) ===
                //
                // Surface the 4 Misc_PortalStorm* events as
                // CLIENT_EVENT_KIND_PORTAL_STORM (= 45) so the
                // status-indicators plugin's pre-wired
                // `portalStormChanged` subscription
                // (`plugins/status-indicators.js:542-547`)
                // can flip the indicator state. Payload shape
                // matches the constant's doc comment: state +
                // level (drives indicator on/off) + extent
                // (ACE-reported f32 for Brewing/Imminent;
                // 0.0 for the payload-less Storm/Subsided).
                //
                // Level mapping (rises with severity so the
                // indicator's intensity scales naturally if
                // a future Wave swaps the sprite per-level):
                //   Subsided = 0  → indicator OFF
                //   Brewing  = 1  → indicator ON (early warn)
                //   Imminent = 2  → indicator ON (final warn)
                //   Storm    = 3  → indicator ON (active teleport)
                holtburger_protocol::messages::GameEvent::MiscPortalStormBrewing(
                    data,
                ) => {
                    queued_events.borrow_mut().push(ClientEvent {
                        kind: CLIENT_EVENT_KIND_PORTAL_STORM,
                        string_payload: Some("brewing".to_string()),
                        u32_payload: Some(1),
                        u32_payload_2: None,
                        f32_payload: Some(data.extent),
                    });
                }
                holtburger_protocol::messages::GameEvent::MiscPortalStormImminent(
                    data,
                ) => {
                    queued_events.borrow_mut().push(ClientEvent {
                        kind: CLIENT_EVENT_KIND_PORTAL_STORM,
                        string_payload: Some("imminent".to_string()),
                        u32_payload: Some(2),
                        u32_payload_2: None,
                        f32_payload: Some(data.extent),
                    });
                }
                holtburger_protocol::messages::GameEvent::MiscPortalStorm => {
                    queued_events.borrow_mut().push(ClientEvent {
                        kind: CLIENT_EVENT_KIND_PORTAL_STORM,
                        string_payload: Some("storm".to_string()),
                        u32_payload: Some(3),
                        u32_payload_2: None,
                        f32_payload: Some(0.0),
                    });
                }
                holtburger_protocol::messages::GameEvent::MiscPortalStormSubsided => {
                    queued_events.borrow_mut().push(ClientEvent {
                        kind: CLIENT_EVENT_KIND_PORTAL_STORM,
                        string_payload: Some("subsided".to_string()),
                        u32_payload: Some(0),
                        u32_payload_2: None,
                        f32_payload: Some(0.0),
                    });
                }
                // SG-C1b (2026-06-09): chess minigame — surface the
                // 5 SG-C1a-decoded events to JS as kind=50 ChessUpdate
                // ClientEvents (string-encoded record, see the
                // CLIENT_EVENT_KIND_CHESS_UPDATE doc). JS maintains the
                // board state + emits `chessUpdate` on the plugin bus.
                holtburger_protocol::messages::GameEvent::JoinGameResponse(data) => {
                    let board = u32::from(data.board_guid);
                    queued_events.borrow_mut().push(ClientEvent {
                        kind: CLIENT_EVENT_KIND_CHESS_UPDATE,
                        string_payload: Some(format!(
                            "join|{board:08x}|{}",
                            data.color
                        )),
                        u32_payload: Some(board),
                        u32_payload_2: None,
                        f32_payload: None,
                    });
                }
                holtburger_protocol::messages::GameEvent::MoveResponse(data) => {
                    let board = u32::from(data.board_guid);
                    queued_events.borrow_mut().push(ClientEvent {
                        kind: CLIENT_EVENT_KIND_CHESS_UPDATE,
                        string_payload: Some(format!(
                            "moveres|{board:08x}|{}",
                            data.result
                        )),
                        u32_payload: Some(board),
                        u32_payload_2: None,
                        f32_payload: None,
                    });
                }
                holtburger_protocol::messages::GameEvent::OpponentTurn(data) => {
                    let board = u32::from(data.board_guid);
                    let md = &data.move_data;
                    queued_events.borrow_mut().push(ClientEvent {
                        kind: CLIENT_EVENT_KIND_CHESS_UPDATE,
                        string_payload: Some(format!(
                            "turn|{board:08x}|{}|{}|{:08x}|{}|{}|{}|{}|{:08x}",
                            data.color,
                            md.move_type,
                            u32::from(md.player_guid),
                            md.from.x,
                            md.from.y,
                            md.to.x,
                            md.to.y,
                            u32::from(md.piece_guid),
                        )),
                        u32_payload: Some(board),
                        u32_payload_2: None,
                        f32_payload: None,
                    });
                }
                holtburger_protocol::messages::GameEvent::OpponentStalemate(data) => {
                    let board = u32::from(data.board_guid);
                    queued_events.borrow_mut().push(ClientEvent {
                        kind: CLIENT_EVENT_KIND_CHESS_UPDATE,
                        string_payload: Some(format!(
                            "stale|{board:08x}|{}|{}",
                            data.color, data.stalemate
                        )),
                        u32_payload: Some(board),
                        u32_payload_2: None,
                        f32_payload: None,
                    });
                }
                holtburger_protocol::messages::GameEvent::GameOver(data) => {
                    let board = u32::from(data.board_guid);
                    queued_events.borrow_mut().push(ClientEvent {
                        kind: CLIENT_EVENT_KIND_CHESS_UPDATE,
                        string_payload: Some(format!(
                            "over|{board:08x}|{}",
                            data.team_winner
                        )),
                        u32_payload: Some(board),
                        u32_payload_2: None,
                        f32_payload: None,
                    });
                }
                // SG-C2 (2026-06-09): item-op self-events.
                holtburger_protocol::messages::GameEvent::InscriptionResponse(data) => {
                    queued_events.borrow_mut().push(ClientEvent {
                        kind: CLIENT_EVENT_KIND_INSCRIPTION,
                        string_payload: Some(data.inscription.clone()),
                        u32_payload: Some(u32::from(data.object_guid)),
                        u32_payload_2: Some(u32::from(data.scribe_guid)),
                        f32_payload: None,
                    });
                }
                holtburger_protocol::messages::GameEvent::SalvageOperationsResult(data) => {
                    let list = data
                        .results
                        .iter()
                        .map(|r| format!("{}:{}:{}", r.material_type, r.units, r.workmanship))
                        .collect::<Vec<_>>()
                        .join(",");
                    queued_events.borrow_mut().push(ClientEvent {
                        kind: CLIENT_EVENT_KIND_SALVAGE_RESULT,
                        string_payload: Some(list),
                        u32_payload: Some(data.skill),
                        u32_payload_2: Some(data.augmentation_bonus as u32),
                        f32_payload: None,
                    });
                }
                // SG-C3 (2026-06-09): UI-surface self-events → kind=53.
                holtburger_protocol::messages::GameEvent::QueryAgeResponse(data) => {
                    queued_events.borrow_mut().push(ClientEvent {
                        kind: CLIENT_EVENT_KIND_UI_EVENT,
                        string_payload: Some(format!(
                            "age|{}|{}",
                            data.target_name, data.age
                        )),
                        u32_payload: None,
                        u32_payload_2: None,
                        f32_payload: None,
                    });
                }
                holtburger_protocol::messages::GameEvent::StartBarber(data) => {
                    queued_events.borrow_mut().push(ClientEvent {
                        kind: CLIENT_EVENT_KIND_UI_EVENT,
                        string_payload: Some("barber".to_string()),
                        u32_payload: Some(data.setup_table_id),
                        u32_payload_2: Some(data.palette_base_did),
                        f32_payload: None,
                    });
                }
                holtburger_protocol::messages::GameEvent::ChannelList(data) => {
                    queued_events.borrow_mut().push(ClientEvent {
                        kind: CLIENT_EVENT_KIND_UI_EVENT,
                        string_payload: Some(format!(
                            "channellist|{}",
                            data.player_names.join(",")
                        )),
                        u32_payload: Some(data.player_names.len() as u32),
                        u32_payload_2: None,
                        f32_payload: None,
                    });
                }
                holtburger_protocol::messages::GameEvent::ChannelIndex(data) => {
                    queued_events.borrow_mut().push(ClientEvent {
                        kind: CLIENT_EVENT_KIND_UI_EVENT,
                        string_payload: Some(format!(
                            "channelindex|{}",
                            data.channels.join(",")
                        )),
                        u32_payload: Some(data.channels.len() as u32),
                        u32_payload_2: None,
                        f32_payload: None,
                    });
                }
                holtburger_protocol::messages::GameEvent::UpdateHar(data) => {
                    queued_events.borrow_mut().push(ClientEvent {
                        kind: CLIENT_EVENT_KIND_UI_EVENT,
                        string_payload: Some("har".to_string()),
                        u32_payload: Some(data.bitmask),
                        u32_payload_2: Some(data.guests.len() as u32),
                        f32_payload: None,
                    });
                }
                holtburger_protocol::messages::GameEvent::HouseAvailableHouses(data) => {
                    queued_events.borrow_mut().push(ClientEvent {
                        kind: CLIENT_EVENT_KIND_UI_EVENT,
                        string_payload: Some("houses".to_string()),
                        u32_payload: Some(data.house_type),
                        u32_payload_2: Some(data.total_available as u32),
                        f32_payload: None,
                    });
                }
                _ => {
                    // Non-chat GameEvents drop through
                    // to the no-op outer catch-all.
                    // Future steps (fellowship UI,
                    // identify popup, book contents,
                    // ...) wire them up in their own
                    // arms.
                }
            }
        }
        _ => unreachable!("GameMessage routed to the wrong handler module"),
    }
    LoopFlow::Continue
}
