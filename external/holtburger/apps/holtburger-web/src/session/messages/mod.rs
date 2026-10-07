//! Inbound server traffic for the wasm `recv_loop` (2026-10-05 split).
//!
//! The body of the loop's `for event in events` (one `SessionEvent` from
//! `session.recv_message()`), moved verbatim out of the `select!` arm:
//! TimeSync adoption, message unpack, the pre-route GameEvent hooks and
//! `*_changed` mirrors, canonical world routing, and the per-`GameMessage`
//! match. Rewrites vs the inline original: `return;` -> `return
//! LoopFlow::Exit;`, the for-level `continue` -> `return LoopFlow::Continue`
//! (next event), and `LoopFlow::Exit` as `send_or_disconnect!`'s return.
//!
//! The per-`GameMessage` arms of that match live, verbatim, one module per
//! concern (`position`, `objects`, `game_event`, `chat`, `login`, `misc`);
//! [`dispatch_game_message`] routes each variant, `misc` keeps the catch-all.

use crate::*;
use crate::session::{LoopCtx, LoopFlags, LoopFlow};
use holtburger_protocol::messages::GameMessage;
use holtburger_protocol::traits::ProtocolUnpack;
use holtburger_session::SessionEvent;

mod chat;
mod game_event;
mod login;
mod misc;
mod objects;
mod position;

/// Handle one inbound `SessionEvent`. `LoopFlow::Exit` = the loop must return.
pub(crate) async fn handle_message(ctx: &mut LoopCtx, event: SessionEvent) -> LoopFlow {
    let LoopFlags {
        world_lifecycle_on,
        wire_state_packs_stage1_on,
        remote_interp_on,
        ..
    } = ctx.flags;
    let LoopCtx {
        queued_events,
        entity_updates,
        latest_stats,
        latest_vendor_state,
        latest_container_contents,
        latest_object_icons,
        latest_inscriptions,
        latest_appraisals,
        latest_enchantments,
        latest_fellowship,
        latest_trade,
        latest_book,
        latest_known_spells,
        wielder_index,
        projectile_index,
        physics_script_table_index,
        entity_enchantments_index,
        identify_meta_index,
        latest_sanctuary,
        door_part_snapshot,
        rynth_id_times,
        last_recv_instant,
        world,
        movement,
        cached_player_description,
        cached_time_sync,
        js_spawned_guids,
        ..
    } = &mut *ctx;
    let bytes = match event {
        SessionEvent::Message(bytes) => bytes,
        // P4.2 TIMESYNC (2026-07-27): adopt the server clock
        // (both lanes reach here — the direct `Session`
        // emits TimeSync natively; the `?netWorker=1` proxy
        // now forwards it as `RX_KIND_TIMESYNC`). Retail
        // parity: the client snaps `Timer::cur_time` to
        // every CTimeSyncHeader (ClientNet::HandleTimeSynch,
        // acclient.c:371516 → Timer::set_time,
        // acclient.c:75365) — snap, no slewing.
        SessionEvent::TimeSync(server_time) => {
            let stamped_at = web_time::Instant::now();
            *cached_time_sync = Some((server_time, stamped_at));
            if let Some(w) = world.borrow_mut().as_mut() {
                let _ = w.set_server_time_sync(server_time, stamped_at);
            }
            return LoopFlow::Continue;
        }
    };
    // PR-SS 2026-05-23: stamp the recv timestamp for the
    // link-status indicator. Any inbound server frame
    // counts as "the link is alive" — staleness > 2s
    // tints the indicator red, > 0.5s yellow.
    *last_recv_instant.borrow_mut() = Some(web_time::Instant::now());
    let mut offset = 0;
    let Some(message) = GameMessage::unpack(&bytes, &mut offset) else {
        return LoopFlow::Continue;
    };

    // Run-skill plumbing backstop (2026-06-02): cache the
    // latest PlayerDescription so a late-constructed
    // WorldState can be hydrated from it (see the
    // `cached_player_description` declaration above and the
    // replay in both world-construction arms). We cache
    // unconditionally — whether or not `world` exists yet —
    // because the whole point is to recover from the case
    // where it doesn't. The normal in-loop dispatch below
    // still hydrates a world that already exists; the cache
    // only matters for the construct-after-PlayerDescription
    // race. We keep the latest (clobbering an earlier cache)
    // so a re-login on the same loop hydrates from the most
    // recent description.
    if let GameMessage::GameEvent(event_msg) = &message
        && matches!(
            event_msg.event,
            holtburger_protocol::messages::GameEvent::PlayerDescription(_)
        )
    {
        *cached_player_description = Some(message.clone());
    }

    // Phase 4 step 4 follow-on (vitals + inventory panels):
    // route stat / inventory / GameEvent messages through the
    // canonical world handler dispatcher BEFORE the recv loop's
    // own match-block runs. The dispatcher mutates
    // `WorldState.player.{vitals,attributes,skills}` +
    // `state.entities` + `state.player.inventory` /
    // `state.player.equipment` so the snapshot publishers below
    // see current state. We then scan the events the dispatcher
    // emitted to decide whether stats / inventory changed
    // enough to warrant a JS-facing kind=8 / kind=11 signal.
    //
    // Position messages (`Update*Position`, `VectorUpdate`,
    // `UpdateMotion`) are intentionally NOT routed: the recv
    // loop's existing arms handle them with step 3.6 / 3.5
    // semantics (entity_seeded gating, heartbeat arming, JS
    // entity_updates push) that double-handling would risk
    // regressing.
    let mut stats_changed = false;
    // HUD rec #84 (2026-06-16): set when
    // PlayerEnchantmentsUpdated fires, gates the kind=58
    // SharedCooldownsUpdated emit below.
    let mut cooldowns_changed = false;
    let mut inventory_changed = false;
    let mut fellowship_changed = false;
    // HUD rec #48: defaults to FellowUpdateType::Full (1)
    // so disband-then-rejoin and recv-loop catch-all
    // re-fires both flag a full rebuild. Overwritten in
    // the pre-route block below when the wire payload
    // carries an explicit Stats / Vitals tag.
    let mut fellowship_update_type: u32 = 1;
    let mut trade_changed = false;
    let mut book_changed: Option<holtburger_common::Guid> = None;
    // === Wave 4.B — remote enchantments pre-route hook (2026-05-28) ===
    //
    // ACE broadcasts buff / debuff stacks for non-self
    // entities via the same `MagicUpdateEnchantment` (etc.)
    // GameEvents the local player receives. The canonical
    // `holtburger_world::player::mutations` handlers gate
    // every one with `if target != self.guid { return false; }`
    // (mutations.rs:440-548), so remote enchantments arrive
    // on the wire and are dropped — leaving raid healers
    // unable to see if their group's buffs landed, PvP
    // players unable to tell if their debuffs stuck, and
    // the new Wave-F.2 buffs HUD blind to anything outside
    // the local player.
    //
    // The non-invasive fix (per `docs/audit-refresh-2026-
    // 05-28.md` §"Wave 4.B recommendation") is a parallel
    // `entity_enchantments_index` HashMap — mirroring the
    // CMT-Wave-16 `physics_script_table_index` pattern.
    // World shape stays unchanged; the buffs HUD + nameplate
    // sprite read via `handle.entityEnchantments(guid)`.
    //
    // We intercept the wire BEFORE
    // `should_route_message_to_world` runs so the world
    // handler's discard guard is irrelevant — the index is
    // populated regardless of whether the world dispatcher
    // accepts or drops the event downstream.
    //
    // **Why pre-route, not post-route**: the world handlers
    // return `false` for non-self enchantments, so post-route
    // the per-GUID payload data is gone (no `WorldEvent`
    // emit). Pre-route gives us the typed event with the
    // `target` field still populated by `game_event.rs:225-278`.
    //
    // **Self-target events** still flow through the
    // `latest_enchantments` snapshot + `kind=8
    // playerStatsUpdated` cadence — we explicitly skip
    // self-targets here so we don't double-publish.
    //
    // Coordinates with Wave 6.A's `should_route_message_to_
    // world` extension (commit 8d21a126): that filter
    // gates `PrivateUpdateProperty*` for the world
    // dispatcher; this hook is upstream of the filter and
    // doesn't depend on it.
    let mut entity_enchantments_changed: Option<u32> = None;
    if let GameMessage::GameEvent(event_msg) = &message {
        let self_guid: Option<u32> = world.borrow()
            .as_ref()
            .map(|w| u32::from(w.player.guid))
            .filter(|&g| g != 0);
        // Helper closure: returns Some(target_guid) when
        // we should populate the index, None when we
        // should let the existing self-path handle it.
        let extract_remote_target = |target: holtburger_common::Guid| -> Option<u32> {
            let g = u32::from(target);
            if g == 0 {
                return None;
            }
            match self_guid {
                Some(sg) if sg == g => None,
                _ => Some(g),
            }
        };
        use holtburger_protocol::messages::GameEvent;
        match &event_msg.event {
            GameEvent::MagicUpdateEnchantment(data) => {
                if let Some(g) = extract_remote_target(data.target) {
                    let mut idx = entity_enchantments_index.borrow_mut();
                    let entry = idx.entry(g).or_default();
                    // Replace existing (spell_id, layer)
                    // or append. Mirrors
                    // `Player::upsert_enchantment`
                    // (mutations.rs:450-458).
                    let snap = player_enchantment_from_wire(&data.enchantment);
                    if let Some(existing) = entry.iter_mut().find(|e| {
                        e.spell_id as u16 == data.enchantment.spell_id
                            && e.layer as u16 == data.enchantment.layer
                    }) {
                        *existing = snap;
                    } else {
                        entry.push(snap);
                    }
                    entity_enchantments_changed = Some(g);
                }
            }
            GameEvent::MagicUpdateMultipleEnchantments(data) => {
                if let Some(g) = extract_remote_target(data.target) {
                    let mut idx = entity_enchantments_index.borrow_mut();
                    let entry = idx.entry(g).or_default();
                    for ench in &data.enchantments {
                        let snap = player_enchantment_from_wire(ench);
                        if let Some(existing) = entry.iter_mut().find(|e| {
                            e.spell_id as u16 == ench.spell_id
                                && e.layer as u16 == ench.layer
                        }) {
                            *existing = snap;
                        } else {
                            entry.push(snap);
                        }
                    }
                    entity_enchantments_changed = Some(g);
                }
            }
            GameEvent::MagicRemoveEnchantment(data) => {
                if let Some(g) = extract_remote_target(data.target) {
                    let mut idx = entity_enchantments_index.borrow_mut();
                    if let Some(entry) = idx.get_mut(&g) {
                        entry.retain(|e| {
                            e.spell_id as u16 != data.spell_id
                                || e.layer as u16 != data.layer
                        });
                        if entry.is_empty() {
                            idx.remove(&g);
                        }
                    }
                    entity_enchantments_changed = Some(g);
                }
            }
            GameEvent::MagicDispelEnchantment(data) => {
                // mutations.rs:261-269 routes
                // DispelEnchantment through
                // remove_enchantment; we mirror that shape.
                if let Some(g) = extract_remote_target(data.target) {
                    let mut idx = entity_enchantments_index.borrow_mut();
                    if let Some(entry) = idx.get_mut(&g) {
                        entry.retain(|e| {
                            e.spell_id as u16 != data.spell_id
                                || e.layer as u16 != data.layer
                        });
                        if entry.is_empty() {
                            idx.remove(&g);
                        }
                    }
                    entity_enchantments_changed = Some(g);
                }
            }
            GameEvent::MagicRemoveMultipleEnchantments(data) => {
                if let Some(g) = extract_remote_target(data.target) {
                    let mut idx = entity_enchantments_index.borrow_mut();
                    if let Some(entry) = idx.get_mut(&g) {
                        for (sid, layer) in &data.spells {
                            entry.retain(|e| {
                                e.spell_id as u16 != *sid
                                    || e.layer as u16 != *layer
                            });
                        }
                        if entry.is_empty() {
                            idx.remove(&g);
                        }
                    }
                    entity_enchantments_changed = Some(g);
                }
            }
            GameEvent::MagicDispelMultipleEnchantments(data) => {
                if let Some(g) = extract_remote_target(data.target) {
                    let mut idx = entity_enchantments_index.borrow_mut();
                    if let Some(entry) = idx.get_mut(&g) {
                        for (sid, layer) in &data.spells {
                            entry.retain(|e| {
                                e.spell_id as u16 != *sid
                                    || e.layer as u16 != *layer
                            });
                        }
                        if entry.is_empty() {
                            idx.remove(&g);
                        }
                    }
                    entity_enchantments_changed = Some(g);
                }
            }
            GameEvent::MagicPurgeEnchantments(data) => {
                // Purge non-VITAE; leave VITAE entries
                // alone (per mutations.rs:526-548
                // `keep_bad=false` branch — kept
                // enchantments are those with the VITAE
                // flag).
                if let Some(g) = extract_remote_target(data.target) {
                    let mut idx = entity_enchantments_index.borrow_mut();
                    if let Some(entry) = idx.get_mut(&g) {
                        use holtburger_common::properties::EnchantmentTypeFlags;
                        entry.retain(|e| {
                            let flags = EnchantmentTypeFlags::from_bits_truncate(
                                e.stat_mod_type,
                            );
                            flags.contains(EnchantmentTypeFlags::VITAE)
                        });
                        if entry.is_empty() {
                            idx.remove(&g);
                        }
                    }
                    entity_enchantments_changed = Some(g);
                }
            }
            GameEvent::MagicPurgeBadEnchantments(data) => {
                // Purge debuffs only; preserve beneficials
                // AND vitae (mutations.rs `keep_bad=true`
                // branch — kept are BENEFICIAL | VITAE).
                if let Some(g) = extract_remote_target(data.target) {
                    let mut idx = entity_enchantments_index.borrow_mut();
                    if let Some(entry) = idx.get_mut(&g) {
                        use holtburger_common::properties::EnchantmentTypeFlags;
                        entry.retain(|e| {
                            let flags = EnchantmentTypeFlags::from_bits_truncate(
                                e.stat_mod_type,
                            );
                            flags.contains(EnchantmentTypeFlags::BENEFICIAL)
                                || flags.contains(EnchantmentTypeFlags::VITAE)
                        });
                        if entry.is_empty() {
                            idx.remove(&g);
                        }
                    }
                    entity_enchantments_changed = Some(g);
                }
            }
            // HUD rec #48: capture the wire update_type
            // tag for the next FellowshipStateUpdated
            // republish. FullUpdate → Full(1) so the
            // panel rebuilds; UpdateFellow carries one
            // of Stats(2) / Vitals(3) / Full(1) on the
            // wire which lets the panel patch a single
            // member instead of redrawing. Disband
            // empties `world.fellowship` to None, so the
            // republished snapshot is None and JS won't
            // see this field — Full(1) is safe as the
            // default for the next rejoin.
            // P15 self-pickup direct (2026-07-04) — the
            // TODAY-live ground-rig removal. ACE tells the
            // PICKER an item entered a container only via
            // ItemServerSaysContainId (THIS event, 0x0022) —
            // the other-players lanes (PickupEvent /
            // ObjectDelete) already map to KIND_REMOVE, and
            // the canonical world-state lane (the
            // PropertiesUpdated arm in the post-route drain)
            // is inert under live defaults: mid-session
            // ObjectCreates only enter state.entities under
            // ?worldLifecycle=on, so move_entity_into_container
            // bails before emitting. Push the removal
            // directly; a rig-less guid (login inventory
            // hydrate, pack→pack move, stowed hand rig
            // already removed by the dequip PickupEvent) is
            // a JS _armRemove no-op. Live legs 3/4: without
            // this the picked-up dagger's ground mesh stayed
            // clickable while the item sat in the pack.
            GameEvent::InventoryPutObjInContainer(data) => {
                js_spawned_guids.remove(&u32::from(data.item_guid));
                entity_updates.borrow_mut().push(EntityUpdate {
                    kind: ENTITY_UPDATE_KIND_REMOVE,
                    guid: u32::from(data.item_guid),
                    model_id: 0,
                    landblock_id: 0,
                    x: 0.0,
                    y: 0.0,
                    z: 0.0,
                    qw: 1.0,
                    qx: 0.0,
                    qy: 0.0,
                    qz: 0.0,
                    wcid: 0,
                    item_type: 0,
                    name: String::new(),
                    obj_scale: 1.0,
                    icon_id: 0,
                    palette_id: 0,
                    mtable_id: 0,
                    model_changes: Vec::new(),
                    texture_changes: Vec::new(),
                    sub_palettes: Vec::new(),
                    placement_id: 0,
                    portal_destination: String::new(),
                    vx: 0.0,
                    vy: 0.0,
                    vz: 0.0,
                    omega_z: 0.0,
                    motion_command: 0,
                    motion_stance: 0,
                    physics_script_did: 0,
                    sound_table_did: 0,
                    obj_desc_flags: 0,
                    weenie_flags: 0,
                    motion_speed: 1.0,
                    physics_translucency: 0.0,
                    is_autonomous: false,
                });
            }
            GameEvent::FellowshipFullUpdate(_) => {
                fellowship_update_type = 1;
            }
            GameEvent::FellowshipUpdateFellow(data) => {
                fellowship_update_type = data.update_type as u32;
            }
            // HUD rec #53: stash IdentifyObjectResponse
            // (success, flags) so build_appraisal_snapshot
            // (post-route, success path) and the failure
            // synthesis below can read them. On failure
            // the world handler swallows the event without
            // emitting EntityIdentified, so we materialize
            // a stub snapshot + kind=32 here ourselves so
            // the JS examine panel can render
            // "Insufficient identification skill" instead
            // of staring at stale success data.
            GameEvent::IdentifyObjectResponse(data) => {
                let g = u32::from(data.object_guid);
                let succ = data.success;
                let flags_bits = data.flags.bits();
                identify_meta_index
                    .borrow_mut()
                    .insert(g, (succ, flags_bits));
                if !succ {
                    let stub = serde_json::json!({
                        "guid": g,
                        "identifySuccess": false,
                        "identifyFlags": flags_bits,
                        "properties": {
                            "ints": {}, "int64s": {}, "bools": {},
                            "floats": {}, "strings": {}, "dids": {},
                        },
                        "spellBook": [],
                    });
                    latest_appraisals
                        .borrow_mut()
                        .insert(g, stub.to_string());
                    queued_events.borrow_mut().push(ClientEvent {
                        kind: CLIENT_EVENT_KIND_OBJECT_APPRAISED,
                        string_payload: None,
                        u32_payload: Some(g),
                        u32_payload_2: None,
                        f32_payload: None,
                    });
                }
            }
            _ => {}
        }
    }
    if should_route_message_to_world(
        &message,
        world_lifecycle_on,
        wire_state_packs_stage1_on,
        remote_interp_on,
    ) && let Some(w) = world.borrow_mut().as_mut()
    {
        let mut world_events: Vec<holtburger_world::WorldEvent> = Vec::new();
        holtburger_world::handlers::routing::handle_message(
            w,
            &message,
            &mut world_events,
        );
        for ev in &world_events {
            use holtburger_world::WorldEvent;
            match ev {
                // === Wave 3.C — per-vital events (2026-05-28) ===
                // Split the per-vital case OUT of the
                // catch-all OR so we can emit a granular
                // kind=42/43/44 with (current, buffed_max)
                // alongside the coalesced kind=8. Non-HUD
                // subscribers (skill panel, attribute panel,
                // burden indicator) keep using kind=8 — the
                // per-vital events are additive.
                // === Wave 6 polish — vitalChanged oldValue (2026-05-28) ===
                // ACPlugin's `Character.OnVitalChanged` carries
                // `int OldValue` per `VitalChangedEventArgs.cs:13-35`.
                // Wave 3.C's per-vital event split (kind=42/43/44)
                // emitted only {current, buffedMax} because the
                // mutation site overwrote the cached vital before
                // the recv loop's event scan could capture the
                // prior. Wave 6 polish (holtburger-world handlers
                // `update_vital_current` + `update_vital` +
                // `update_health_fraction`) now snapshot the prior
                // value BEFORE the in-place mutation and surface it
                // on `WorldEvent::VitalUpdated { prev_current }`.
                //
                // We thread it through `f32_payload` as a non-NaN
                // f32. Vitals max out at ~1500 retail, well below
                // f32's 2^24 = 16M lossless integer range, so the
                // u32→f32 cast is exact for every realistic value.
                // `None` (handler couldn't capture, e.g. mid-spawn
                // hydrate) maps to `f32_payload: None` and JS
                // consumers must treat it as "delta unavailable".
                WorldEvent::VitalUpdated { vital, prev_current } => {
                    stats_changed = true;
                    use holtburger_world::stats::VitalType;
                    let kind = match vital.vital_type {
                        VitalType::Health => CLIENT_EVENT_KIND_VITAL_HEALTH,
                        VitalType::Stamina => CLIENT_EVENT_KIND_VITAL_STAMINA,
                        VitalType::Mana => CLIENT_EVENT_KIND_VITAL_MANA,
                    };
                    queued_events.borrow_mut().push(ClientEvent {
                        kind,
                        string_payload: None,
                        u32_payload: Some(vital.current),
                        u32_payload_2: Some(vital.buffed_max),
                        f32_payload: prev_current.map(|v| v as f32),
                    });
                }
                WorldEvent::AttributeUpdated(_)
                | WorldEvent::SkillUpdated(_)
                | WorldEvent::LevelInfoUpdated(_)
                | WorldEvent::DerivedStatsUpdated(_) => {
                    stats_changed = true;
                }
                // HUD rec #84 (2026-06-16): keep the
                // kind=8 stats refresh wired (existing
                // behavior) AND additionally flag a
                // kind=58 SharedCooldownsUpdated emit
                // whenever the COOLDOWN bit
                // (`EnchantmentTypeFlags::COOLDOWN =
                // 0x1000000`) appears in the refreshed
                // enchantment list. JS hotbar / vitals-
                // hud subscribe to a narrower bus event
                // instead of re-filtering on every
                // stats tick.
                WorldEvent::PlayerEnchantmentsUpdated { .. } => {
                    stats_changed = true;
                    cooldowns_changed = true;
                }
                // F10-1: a tracked entity's health fraction
                // changed (QueryHealth response, or a damage
                // UpdateHealthFraction broadcast). Bridge it to
                // JS so the target-bar can show the selected
                // monster's health bar (previously dropped at
                // the `_ => {}` catch-all).
                WorldEvent::EntityHealthUpdated { guid, health_fraction } => {
                    queued_events.borrow_mut().push(ClientEvent {
                        kind: CLIENT_EVENT_KIND_ENTITY_HEALTH,
                        string_payload: None,
                        u32_payload: Some(u32::from(*guid)),
                        u32_payload_2: None,
                        f32_payload: Some(*health_fraction),
                    });
                }
                WorldEvent::FellowshipStateUpdated(_) => {
                    fellowship_changed = true;
                }
                // SG-E (2026-06-09, Lens-2 discovery): the world
                // dispatcher emits `FellowshipActivity` for every
                // join/leave/dismiss/disband (the cli renders these
                // as chat lines — `panels/chat.rs:548`), but the
                // wasm recv loop dropped them at the `_ => {}`
                // catch-all: only `FellowshipStateUpdated` was
                // consumed (roster refresh), so the local player's
                // own "You left/joined the fellowship." feedback —
                // and member join/leave notices — never reached JS.
                // Surface them as a `kind=2 CHAT_RECEIVED` line in
                // the Fellowship category (16). Formatting mirrors
                // the cli's `format_fellowship_activity` 1:1.
                WorldEvent::FellowshipActivity(activity) => {
                    use holtburger_world::events::FellowshipActivity as FA;
                    let line = match activity {
                        FA::YouJoined { fellowship_name } => {
                            if fellowship_name.is_empty() {
                                "You joined the fellowship.".to_string()
                            } else {
                                format!(
                                    "You joined the fellowship '{}'.",
                                    fellowship_name
                                )
                            }
                        }
                        FA::MemberJoined { member_name } => {
                            format!("{} joined the fellowship.", member_name)
                        }
                        FA::YouLeft => "You left the fellowship.".to_string(),
                        FA::MemberLeft { member_name } => {
                            format!("{} left the fellowship.", member_name)
                        }
                        FA::YouWereDismissed => {
                            "You were dismissed from the fellowship.".to_string()
                        }
                        FA::MemberWasDismissed { member_name } => {
                            format!(
                                "{} was dismissed from the fellowship.",
                                member_name
                            )
                        }
                        FA::FellowshipDisbanded { fellowship_name } => {
                            match fellowship_name {
                                Some(name) if !name.is_empty() => {
                                    format!("The fellowship '{}' was disbanded.", name)
                                }
                                _ => "The fellowship was disbanded.".to_string(),
                            }
                        }
                    };
                    queued_events.borrow_mut().push(ClientEvent {
                        kind: CLIENT_EVENT_KIND_CHAT_RECEIVED,
                        string_payload: Some(line),
                        u32_payload: None,
                        u32_payload_2: Some(CHAT_CATEGORY_FELLOWSHIP),
                        f32_payload: None,
                    });
                }
                WorldEvent::TradeStateUpdated(_) => {
                    trade_changed = true;
                }
                WorldEvent::EntityBookUpdated { guid, .. } => {
                    book_changed = Some(*guid);
                }
                // ACPlugin PR-2 (2026-05-27): split
                // ContainerClosed out of the catch-all OR
                // so we can emit `kind=31
                // CONTAINER_CLOSED` in addition to the
                // existing inventory-changed signal.
                // World.cs:253-262 fires
                // `containerClosed` from
                // OnItem_StopViewingObjectContents;
                // matrix row 10/row 4 → IMPLEMENTED.
                WorldEvent::ContainerClosed(container_guid) => {
                    inventory_changed = true;
                    let container_guid_u32 = u32::from(*container_guid);
                    // `w` (the mutable borrow established
                    // on the outer `world.as_mut()` arm
                    // at :23286) is in scope. Borrow it
                    // re-immutably here for the name
                    // lookup — Rust's NLL allows the
                    // mut borrow to coexist with this
                    // local read because we never touch
                    // it again until after the read ends.
                    let container_name = {
                        use holtburger_common::properties::WorldObjectExt as _;
                        w.entities
                            .get(*container_guid)
                            .map(|entity| entity.name().to_string())
                            .unwrap_or_else(|| "Container".to_string())
                    };
                    queued_events.borrow_mut().push(ClientEvent {
                        kind: CLIENT_EVENT_KIND_CONTAINER_CLOSED,
                        string_payload: Some(container_name),
                        u32_payload: Some(container_guid_u32),
                        u32_payload_2: None,
                        f32_payload: None,
                    });
                }
                WorldEvent::EntitySpawned(_)
                | WorldEvent::EntityReplaced(_)
                | WorldEvent::EntityDespawned(_)
                | WorldEvent::ContainerOpened(_) => {
                    // Could affect inventory if the entity
                    // is owned by the player; the snapshot
                    // builder filters by ownership so a
                    // false positive here just refreshes
                    // the panel one extra time.
                    inventory_changed = true;
                }
                WorldEvent::PropertiesUpdated { guid, updates } => {
                    // P15 (2026-07-04) — SELF-pickup ground-rig
                    // removal. ACE tells the PICKER an item
                    // entered a container only via
                    // GameEventItemServerSaysContainId (the
                    // InventoryPutObjInContainer event) — no
                    // PickupEvent / ObjectDelete arrives for
                    // self (those are the other-players lanes,
                    // already mapped to KIND_REMOVE above). The
                    // world crate clears the entity's world
                    // presence and surfaces the contain as
                    // PropertiesUpdated{InstanceId(Container,
                    // != NULL)} — mirror the PickupEvent arm so
                    // the ground mesh despawns the moment the
                    // item becomes contained (live leg 3: the
                    // dagger reached the pack, InventoryUpdated
                    // ×3, but its world rig lingered clickable).
                    // UNGATED emit: `js_spawned_guids` is the
                    // WIELDED-CHILD ledger only (sole insert =
                    // the ParentEvent arm), so ground rigs are
                    // never in it (leg-4 finding). A spurious
                    // KIND_REMOVE for a rig-less contained item
                    // (login inventory hydrates, pack→pack
                    // moves) is a JS `_armRemove` no-op, and
                    // the dequip lane's PickupEvent already
                    // removed hand rigs before this arrives.
                    // NOTE: under live defaults this arm fires
                    // only for entities the world dispatcher
                    // TRACKS — mid-session ObjectCreates route
                    // only under ?worldLifecycle=on (see
                    // should_route_message_to_world), so the
                    // TODAY-live self-pickup removal is the
                    // direct GameEvent hook in the pre-route
                    // block (search "P15 self-pickup direct").
                    // This arm is the canonical lane once
                    // lifecycle routing flips on; both are
                    // idempotent (JS _armRemove no-ops).
                    let contained = updates.iter().any(|u| {
                        matches!(
                            u,
                            holtburger_common::properties::PropertyUpdate::InstanceId(
                                holtburger_common::properties::PropertyInstanceId::Container,
                                c,
                            ) if *c != holtburger_common::Guid::NULL
                        )
                    });
                    if contained {
                        let guid_u32 = u32::from(*guid);
                        js_spawned_guids.remove(&guid_u32);
                        {
                            entity_updates.borrow_mut().push(EntityUpdate {
                                kind: ENTITY_UPDATE_KIND_REMOVE,
                                guid: guid_u32,
                                model_id: 0,
                                landblock_id: 0,
                                x: 0.0,
                                y: 0.0,
                                z: 0.0,
                                qw: 1.0,
                                qx: 0.0,
                                qy: 0.0,
                                qz: 0.0,
                                wcid: 0,
                                item_type: 0,
                                name: String::new(),
                                obj_scale: 1.0,
                                icon_id: 0,
                                palette_id: 0,
                                mtable_id: 0,
                                model_changes: Vec::new(),
                                texture_changes: Vec::new(),
                                sub_palettes: Vec::new(),
                                placement_id: 0,
                                portal_destination: String::new(),
                                vx: 0.0,
                                vy: 0.0,
                                vz: 0.0,
                                omega_z: 0.0,
                                motion_command: 0,
                                motion_stance: 0,
                                physics_script_did: 0,
                                sound_table_did: 0,
                                obj_desc_flags: 0,
                                weenie_flags: 0,
                                motion_speed: 1.0,
                                physics_translucency: 0.0,
                                is_autonomous: false,
                            });
                        }
                    }
                    inventory_changed = true;
                }
                WorldEvent::EntityDetached {
                    entity_guid,
                    prior_wielder_guid,
                } => {
                    inventory_changed = true;
                    queued_events.borrow_mut().push(ClientEvent {
                        kind: CLIENT_EVENT_KIND_ENTITY_DETACHED,
                        string_payload: None,
                        u32_payload: Some(*entity_guid),
                        u32_payload_2: Some(*prior_wielder_guid),
                        f32_payload: None,
                    });
                }
                // Wave C / PR8 (2026-06-06): mirror the
                // EntityDetached arm. JS consumers (paperdoll
                // reload, 3D rig wielded-children pass) listen
                // for kind=49 alongside kind=47.
                WorldEvent::EntityAttached {
                    entity_guid,
                    new_wielder_guid,
                } => {
                    inventory_changed = true;
                    queued_events.borrow_mut().push(ClientEvent {
                        kind: CLIENT_EVENT_KIND_ENTITY_ATTACHED,
                        string_payload: None,
                        u32_payload: Some(*entity_guid),
                        u32_payload_2: Some(*new_wielder_guid),
                        f32_payload: None,
                    });
                }
                WorldEvent::InventoryActionFailed {
                    item_guid,
                    weenie_error_code,
                } => {
                    queued_events.borrow_mut().push(ClientEvent {
                        kind: CLIENT_EVENT_KIND_INVENTORY_ACTION_FAILED,
                        string_payload: None,
                        u32_payload: Some(*item_guid),
                        u32_payload_2: Some(*weenie_error_code),
                        f32_payload: None,
                    });
                }
                // Phase 4 step 6f: EntityIdentified
                // arrives in response to our auto-fired
                // `GameAction::IdentifyObject` for
                // portals (above in the ObjectCreate
                // arm). The world's
                // `inventory::handle_event` arm has
                // already populated the entity's
                // `properties.strings` map with the
                // assessment props; pull
                // `AppraisalPortalDestination` and
                // emit a kind=3 META_REFRESH
                // EntityUpdate so JS can render the
                // chip below the portal sprite. Also
                // flag inventory_changed so the
                // identified-item path (e.g. a player-
                // appraised inventory weapon) refreshes
                // the panel.
                WorldEvent::EntityIdentified(entity) => {
                    use holtburger_common::properties::{
                        HasProperties, PropertyInt, PropertyString,
                    };
                    let entity_guid = entity.guid;
                    // Wave J3 (2026-05-26): stash the inscription
                    // text for the `⌕ Examine` cascade. Mirrors
                    // `assessment::InscriptionInfo::from_object`
                    // (which reads the same property off the same
                    // entity); we cache here so the wasm getter
                    // can read it sync without re-borrowing world.
                    if let Some(text) = entity
                        .properties()
                        .strings
                        .get(&PropertyString::Inscription)
                        .cloned()
                    {
                        latest_inscriptions
                            .borrow_mut()
                            .insert(u32::from(entity_guid), text);
                    } else {
                        latest_inscriptions
                            .borrow_mut()
                            .remove(&u32::from(entity_guid));
                    }
                    let item_type_int = entity
                        .properties()
                        .ints
                        .get(&PropertyInt::ItemType)
                        .copied()
                        .unwrap_or(0)
                        as u32;
                    if item_type_int & ITEM_TYPE_PORTAL_BIT != 0 {
                        let dest = entity
                            .properties()
                            .strings
                            .get(&PropertyString::AppraisalPortalDestination)
                            .cloned()
                            .unwrap_or_default();
                        if !dest.is_empty() {
                            entity_updates.borrow_mut().push(EntityUpdate {
                                kind: ENTITY_UPDATE_KIND_META_REFRESH,
                                guid: u32::from(entity_guid),
                                model_id: 0,
                                landblock_id: 0,
                                x: 0.0,
                                y: 0.0,
                                z: 0.0,
                                qw: 1.0,
                                qx: 0.0,
                                qy: 0.0,
                                qz: 0.0,
                                wcid: 0,
                                item_type: 0,
                                name: String::new(),
                                obj_scale: 1.0,
                                icon_id: 0,
                                palette_id: 0,
                                mtable_id: 0,
                                model_changes: Vec::new(),
                                texture_changes: Vec::new(),
                                sub_palettes: Vec::new(),
                                placement_id: 0,
                                portal_destination: dest,
                                vx: 0.0,
                                vy: 0.0,
                                vz: 0.0,
                                omega_z: 0.0,
                                motion_command: 0,
                                motion_stance: 0,
                                physics_script_did: 0,
                                sound_table_did: 0,
                                obj_desc_flags: 0,
                                weenie_flags: 0,
                // A1 (2026-05-29): non-MOTION updates carry no
                // playback speed — identity (no anim scaling).
                motion_speed: 1.0,
                physics_translucency: 0.0,
                                is_autonomous: false,
                            });
                        }
                    }
                    inventory_changed = true;
                    // EX-05 (2026-06-05) — examine refactor
                    // wire side. Build a JSON-shaped snapshot
                    // of the entity's full appraisal data
                    // (the 6 property tables + 4 optional
                    // sub-bodies + spell-book + enchantment
                    // bitfields + armor-levels) and stash
                    // it on `latest_appraisals` keyed by
                    // GUID. The JS examine plugin reads via
                    // `getObjectAppraisal(guid)` after the
                    // kind=32 event fires below.
                    // HUD rec #53: read the (success, flags)
                    // captured pre-route on this Identify
                    // round-trip. Always Some(...) here since
                    // the world handler only emits
                    // EntityIdentified on success; the failure
                    // path is handled separately in the
                    // pre-route block below.
                    let identify_meta = identify_meta_index
                        .borrow()
                        .get(&u32::from(entity_guid))
                        .copied();
                    let appraisal_json =
                        build_appraisal_snapshot(&entity, identify_meta);
                    latest_appraisals
                        .borrow_mut()
                        .insert(u32::from(entity_guid), appraisal_json);
                    // rynth Phase 2: stamp the identify-apply
                    // time (epoch ms) — SUCCESS site only.
                    rynth_id_times.borrow_mut().insert(
                        u32::from(entity_guid),
                        web_time::SystemTime::now()
                            .duration_since(web_time::UNIX_EPOCH)
                            .map(|d| d.as_millis() as f64)
                            .unwrap_or(0.0),
                    );
                    // ACPlugin PR-2 (2026-05-27): emit
                    // kind=32 ObjectAppraised. The
                    // existing kind=3 META_REFRESH
                    // entity-update only fires for
                    // portals (the dest-chip). All other
                    // appraised types had no event
                    // surface — /assess UI, vendor
                    // tooltips, examine popovers were
                    // blocked entirely (matrix row 12).
                    // Now every EntityIdentified emits
                    // kind=32 with the GUID so plugins
                    // can refresh from the entity store.
                    let entity_name = entity
                        .properties()
                        .strings
                        .get(&PropertyString::Name)
                        .cloned()
                        .unwrap_or_default();
                    queued_events.borrow_mut().push(ClientEvent {
                        kind: CLIENT_EVENT_KIND_OBJECT_APPRAISED,
                        string_payload: Some(entity_name),
                        u32_payload: Some(u32::from(entity_guid)),
                        u32_payload_2: None,
                        f32_payload: None,
                    });
                }
                // Phase 6 step E: SetState packets for
                // door-flagged entities produce a
                // DoorStateChanged event alongside the
                // EntityStateUpdated. Forward the
                // door-state transition to JS as a
                // kind=15 ClientEvent so the JS-side
                // door state map updates, the matching
                // building-AABB entry's `active` flag
                // toggles, and the door sprite rotates
                // around its hinge frame. The state
                // payload is `1` for Open / `0` for
                // Closed — matches the JS-side
                // `__doorStates` Map's "open" /
                // "closed" string mapping.
                WorldEvent::DoorStateChanged { guid, state: door_state } => {
                    let state_u32: u32 = match door_state {
                        holtburger_world::DoorState::Open => 1,
                        holtburger_world::DoorState::Closed => 0,
                    };
                    // PR-PP 2026-05-23: the actual load-
                    // bearing wire for "open door is
                    // walkable". The world emitted the
                    // DoorStateChanged event but our
                    // recv loop wasn't propagating it
                    // into the spatial scene's AABB
                    // filter — `building_aabbs_near_pose`
                    // returns only `.active == true`
                    // entries, but nothing was flipping
                    // the flag, so open doors kept
                    // blocking movement. Now we look up
                    // the door's bound `(BuildingId,
                    // part_index)` (registered at
                    // ObjectCreate time via
                    // `scene.register_door_part`) and
                    // call `set_door_aabb_active` with
                    // active=!open, exactly mirroring
                    // the existing test fixture at
                    // lib.rs:8586 + 8741. The 2D-Pixi
                    // and 3D-Three.js visual rotation
                    // paths (kind=15 handler in
                    // index.html) are unchanged.
                    let active = matches!(door_state, holtburger_world::DoorState::Closed);
                    // `w` here is the outer `if let Some(w) = world.as_mut()`
                    // binding that wraps this whole WorldEvent dispatch
                    // block — re-borrowing `world` would conflict.
                    let door_guid_u64 = u32::from(*guid) as u64;
                    // PR-PP follow-up: lazy door registration when
                    // the ObjectCreate-time spatial match missed
                    // (race with building-AABB drain, dynamic
                    // dungeon, etc.). On the first DoorStateChanged
                    // for an unregistered door, run the same
                    // building-AABB spatial match as the
                    // ObjectCreate arm at lib.rs:17211 and
                    // register the result. Idempotent on
                    // subsequent state changes.
                    let mut lookup = w.scene.door_part_for_guid(door_guid_u64);
                    if lookup.is_none() {
                        let pose_opt = w.entities.get(*guid).map(|e| e.position);
                        if let Some(pose) = pose_opt {
                            let candidates = w.scene.building_aabbs_near_pose(&pose);
                            let px = pose.coords.x;
                            let py = pose.coords.y;
                            let mut hit: Option<(holtburger_world::BuildingId, u8)> = None;
                            for entry in candidates {
                                if px >= entry.aabb.min.x
                                    && px <= entry.aabb.max.x
                                    && py >= entry.aabb.min.y
                                    && py <= entry.aabb.max.y
                                {
                                    hit = Some((entry.building_id, entry.part_index));
                                    break;
                                }
                            }
                            if let Some((bid, pidx)) = hit {
                                w.scene.register_door_part(door_guid_u64, bid, pidx);
                                lookup = Some((bid, pidx));
                                console_log_str(&format!(
                                    "[phase6.E] DoorStateChanged 0x{:08X} lazy-registered to building part bid={:?} pidx={}",
                                    u32::from(*guid), bid, pidx,
                                ));
                            }
                        }
                    }
                    if let Some((building_id, part_index)) = lookup {
                        let flipped = w.scene.set_door_aabb_active(
                            building_id, part_index, active,
                        );
                        console_log_str(&format!(
                            "[phase6.E] DoorStateChanged 0x{:08X} state={:?} → set_door_aabb_active(bid={:?}, pidx={}, active={}) flipped={}",
                            u32::from(*guid),
                            door_state,
                            building_id,
                            part_index,
                            active,
                            flipped,
                        ));
                    } else {
                        // No outdoor building AABB enclosed the door's pose
                        // — indoor cell door. The door entity's cylinder
                        // is correctly skipped via the is_collidable
                        // ETHEREAL filter, but the EnvCell BSP mesh may
                        // include the door PANEL geometry as static wall
                        // polys. PR-RR interim: when door opens, register
                        // a world-space exclusion AABB centred on the
                        // door's pose; `clamp_delta_against_cell_walls_
                        // with_exclusions` (movement/system.rs:680) skips
                        // cell-mesh triangles whose centroid lands inside.
                        let (ethereal, collidable, pose_opt) = w
                            .entities
                            .get(*guid)
                            .map(|e| {
                                use holtburger_common::properties::PhysicsState;
                                (
                                    e.physics_state.contains(PhysicsState::ETHEREAL),
                                    e.is_collidable(),
                                    Some(e.position),
                                )
                            })
                            .unwrap_or((false, false, None));
                        let guid_u32 = u32::from(*guid);
                        if matches!(door_state, holtburger_world::DoorState::Open) {
                            if let Some(pose) = pose_opt {
                                // ~1.5m horizontal × full door height
                                // (-0.5..+3 m vertical) AABB around the
                                // door's global position. Big enough to
                                // capture the door panel + small frame
                                // overlap; tight enough to avoid
                                // excluding surrounding wall polys.
                                let g = pose.global_coords();
                                let aabb = holtburger_common::Aabb {
                                    min: holtburger_common::Vector3::new(
                                        g.x - 1.5, g.y - 1.5, g.z - 0.5,
                                    ),
                                    max: holtburger_common::Vector3::new(
                                        g.x + 1.5, g.y + 1.5, g.z + 3.0,
                                    ),
                                };
                                w.scene.add_open_door_exclusion(guid_u32, aabb);
                                console_log_str(&format!(
                                    "[phase6.E] DoorStateChanged 0x{:08X} state=Open — INDOOR: added cell-mesh exclusion AABB @ global ({:.1},{:.1},{:.1}), eth={} (open-door exclusion count now {})",
                                    guid_u32, g.x, g.y, g.z, ethereal,
                                    w.scene.open_door_exclusion_len(),
                                ));
                            } else {
                                console_log_str(&format!(
                                    "[phase6.E] DoorStateChanged 0x{:08X} state=Open — INDOOR: NO pose available to build exclusion AABB; cell-mesh will still block. eth={} collidable={}",
                                    guid_u32, ethereal, collidable,
                                ));
                            }
                        } else {
                            // Closed: drop the exclusion entry.
                            let removed = w.scene.remove_open_door_exclusion(guid_u32);
                            console_log_str(&format!(
                                "[phase6.E] DoorStateChanged 0x{:08X} state=Closed — INDOOR: removed cell-mesh exclusion (was_set={}) eth={} (open-door exclusion count now {})",
                                guid_u32, removed, ethereal,
                                w.scene.open_door_exclusion_len(),
                            ));
                        }
                    }
                    queued_events.borrow_mut().push(ClientEvent {
                        kind: CLIENT_EVENT_KIND_DOOR_STATE_CHANGED,
                        string_payload: None,
                        u32_payload: Some(u32::from(*guid)),
                        u32_payload_2: Some(state_u32),
                        f32_payload: None,
                    });
                }
                WorldEvent::EntityVisibilityChanged { guid, visible } => {
                    queued_events.borrow_mut().push(ClientEvent {
                        kind: CLIENT_EVENT_KIND_ENTITY_VISIBILITY_CHANGED,
                        string_payload: None,
                        u32_payload: Some(u32::from(*guid)),
                        u32_payload_2: Some(if *visible { 1 } else { 0 }),
                        f32_payload: None,
                    });
                }
                // CMT Wave 11 / Phase 34 (2026-05-26):
                // bridge `WorldEvent::PlayEffect`
                // (emitted from `handlers::system::handle_message`'s
                // `GameMessage::PlayEffect` arm — Wave 10
                // Phase 31's contribution) to a kind=30
                // `ClientEvent` so JS-side VFX
                // consumers (`scene3d/play_effect_vfx.js`)
                // can spawn particle bursts at the
                // target entity's position. The
                // PlayScript ID lives in
                // `u32_payload_2`; see
                // `apps/holtburger-web/ui/ac_play_script.js`
                // for the enum mirror.
                WorldEvent::PlayEffect { target, script_id, speed } => {
                    queued_events.borrow_mut().push(ClientEvent {
                        kind: CLIENT_EVENT_KIND_PLAY_EFFECT,
                        string_payload: None,
                        u32_payload: Some(u32::from(*target)),
                        u32_payload_2: Some(*script_id),
                        f32_payload: Some(*speed),
                    });
                }
                _ => {}
            }
        }
        // A13-W1 (2026-06-11): consume the self-movement
        // sequence WorldEvents (`SelfServerControlledMotion`
        // / `SelfUpdatePosition` / `SelfAutonomousPosition`)
        // through the SAME shared helper the native runtime
        // calls in `client/messages.rs::handle_world_events`
        // — single consumption site for both targets. Only
        // reachable when the movement family is routed
        // (`?wireStatePacks=stage1`); gated anyway so the
        // default path stays byte-identical. The native-only
        // follow-ons (simulation hand-off, F2-3 deferred
        // LoginComplete) keep their existing wasm owners:
        // the UpdateMotion JS arm + the UpdatePosition arm's
        // F2-3 block below.
        if wire_state_packs_stage1_on {
            movement.apply_self_movement_world_events(&world_events);
            // A3-D3 (2026-06-12): the sibling movement-event
            // consumer — per-entity `MovementManager`
            // registry (`unpack_movement` Stage-3 semantics),
            // same shared helper the native runtime calls.
            // Doubly gated: this `stage1` URL flag (without
            // it UpdateMotion never reaches `handlers/`) AND
            // the default-off Rust const
            // `USE_UNPACK_MOVEMENT_SEMANTICS` inside.
            movement.apply_movement_world_events(&world_events);
        }
    }

    // Phase 4 step 4 follow-on: spatial-bypass inventory
    // tracking for `ObjectCreate` / `ObjectDelete` /
    // `InventoryRemoveObject`. Routing these through the
    // canonical `holtburger_world::handlers::inventory`
    // dispatcher trips a wasm `unreachable` panic in the
    // spatial body store (`scene.update_entity` +
    // `reconcile_authoritative_body` paths assume state
    // the wasm bundle doesn't initialise — see the
    // `should_route_message_to_world` doc comment). We
    // replicate the inventory-relevant subset of the
    // canonical handlers inline, sans spatial work, so
    // `state.entities` + `state.player.inventory` /
    // `state.player.equipment` stay current and
    // `publish_player_inventory_snapshot` produces a
    // populated snapshot.
    //
    // P4.1 / LEAK-01 (2026-07-27): built here so all four
    // lifecycle arms below share ONE prune surface. Holds
    // only `&Rc`, so it never conflicts with the
    // `world.borrow_mut()` held across the match.
    let per_guid_bridge_indexes = PerGuidBridgeIndexes {
        latest_vendor_state: &latest_vendor_state,
        latest_container_contents: &latest_container_contents,
        latest_object_icons: &latest_object_icons,
        latest_inscriptions: &latest_inscriptions,
        latest_appraisals: &latest_appraisals,
        identify_meta_index: &identify_meta_index,
        door_part_snapshot: &door_part_snapshot,
        rynth_id_times: &rynth_id_times,
        projectile_index: &projectile_index,
        physics_script_table_index: &physics_script_table_index,
        entity_enchantments_index: &entity_enchantments_index,
    };
    if let Some(w) = world.borrow_mut().as_mut() {
        match &message {
            // A8-M1 (2026-06-11): under `?worldLifecycle=on`
            // the canonical world dispatcher (routed above via
            // `should_route_message_to_world`) already owns
            // ALL world-state mutation for the lifecycle
            // family — only the wasm-bridge-local JS-facing
            // indexes are maintained here. `inventory_changed`
            // for the create case comes from the routed
            // `WorldEvent::EntitySpawned/EntityReplaced` arm
            // in the scan above; for deletes we set it
            // unconditionally (the snapshot builder filters
            // by ownership, so a false positive just
            // refreshes the panel one extra time — same
            // rationale as that arm).
            GameMessage::ObjectCreate(data) if world_lifecycle_on => {
                maintain_bridge_indexes_on_routed_create(
                    w,
                    data.public_weenie_desc.guid,
                    &wielder_index,
                    &projectile_index,
                    &physics_script_table_index,
                    &per_guid_bridge_indexes,
                );
            }
            GameMessage::ObjectDelete(data) if world_lifecycle_on => {
                maintain_bridge_indexes_on_delete(
                    data.guid,
                    &wielder_index,
                    &per_guid_bridge_indexes,
                );
                inventory_changed = true;
            }
            GameMessage::InventoryRemoveObject(data) if world_lifecycle_on => {
                maintain_bridge_indexes_on_delete(
                    data.object_guid,
                    &wielder_index,
                    &per_guid_bridge_indexes,
                );
                inventory_changed = true;
            }
            GameMessage::ObjectCreate(data) => {
                if apply_inventory_object_create(w, data, &wielder_index, &projectile_index, &physics_script_table_index, &per_guid_bridge_indexes) {
                    inventory_changed = true;
                }
            }
            GameMessage::ObjectDelete(data) => {
                // === Wave 4.B — propagate to entity_enchantments_index (2026-05-28) ===
                if apply_inventory_object_delete(w, data.guid, &wielder_index, &per_guid_bridge_indexes) {
                    inventory_changed = true;
                }
            }
            GameMessage::InventoryRemoveObject(data) => {
                // === Wave 4.B — propagate to entity_enchantments_index (2026-05-28) ===
                if apply_inventory_object_delete(w, data.object_guid, &wielder_index, &per_guid_bridge_indexes) {
                    inventory_changed = true;
                }
            }
            // CMT Wave 16 / Phase 50 (2026-05-26):
            // PhysicsDesc runtime swap listener. ACE
            // re-broadcasts the full ObjectDescriptionData
            // (with a fresh PhysicsDesc.PhsTableID slot,
            // if applicable) on opcode 0xF7DB whenever a
            // long-lived entity changes appearance —
            // typically equip/unequip via
            // `Creature.CalculateObjDesc`. Retail
            // `acclient.c:322321-322331` reads the new
            // `phstable_id.id` and swaps the entity's
            // `physics_script_table` pointer. We mirror
            // that here: re-apply the description to the
            // cached entity (refreshes
            // `PropertyDataId::PhysicsEffectTable`) and
            // re-resolve the cached
            // `physics_script_table_did`. Returning the
            // same Setup → `default_phstable_id` value
            // when PhysicsDesc carries no override is the
            // correct retail behaviour (the override
            // doesn't sticky-clear; absence means use the
            // Setup default). The parallel
            // `physics_script_table_index` keeps the JS
            // accessor's value coherent with the entity
            // field.
            GameMessage::UpdateObject(data) => {
                let guid = data.public_weenie_desc.guid;
                if let Some(entity) = w.entities.get_mut(guid) {
                    entity.apply_description(data);
                    let new_did = resolve_physics_script_table_did(entity);
                    entity.physics_script_table_did = new_did;
                    let g_u32 = u32::from(guid);
                    let mut idx = physics_script_table_index.borrow_mut();
                    if new_did == 0 {
                        idx.remove(&g_u32);
                    } else {
                        idx.insert(g_u32, new_did);
                    }
                }
                // FU-1 (2026-06-11): UpdateObject (0xF7DB) is one
                // of the two paths (the other is ParentEvent
                // below) that carries a Wielder /
                // CurrentWieldedLocation transition for an
                // already-spawned item without a fresh
                // ObjectCreate — e.g. the equipping player's own
                // weapon, since ACE's TrackEquippedObject returns
                // for `wielder == this`. `apply_description` just
                // refreshed the cached entity above, so re-fold
                // it into the per-wielder index. Idempotent: the
                // upsert de-dupes on item_guid and no-ops when the
                // item carries no wielder + equip-slot bit.
                upsert_wielder_index(w, guid, &wielder_index);
            }
            // FU-1 (2026-06-11): ParentEvent (0xF749) is the
            // other in-session equip signal. When a wielded child
            // is attached (`parent_guid != NULL`) the equipping
            // player gets NO fresh CreateObject for it, so
            // `apply_inventory_object_create` never indexed it.
            // Fold the now-current entity into the per-wielder
            // index here so `entity_wielded_items(wielder)`
            // includes the session-equipped item (the JS
            // flushWieldedDirty equip_mask→holding-location
            // heuristic then attaches it). On detach
            // (`parent_guid == NULL`) strip the child from every
            // wielder bucket, mirroring
            // `apply_inventory_object_delete`'s per-list retain.
            GameMessage::ParentEvent(data) => {
                if data.parent_guid != holtburger_common::Guid::NULL {
                    upsert_wielder_index(w, data.child_guid, &wielder_index);
                } else {
                    strip_wielder_index_item(data.child_guid, &wielder_index);
                }
                inventory_changed = true;
            }
            // HUD rec #56 (2026-06-16): a Sanctuary
            // PrivateUpdatePosition carries the player's
            // lifestone bind location. This packet stays
            // un-routed to the world handler on wasm
            // (should_route_message_to_world), so read it
            // directly and refresh the snapshot JS reads via
            // SessionHandle::player_sanctuary on lifestone-popup
            // open.
            GameMessage::PrivateUpdatePosition(data)
                if data.position_type
                    == holtburger_protocol::messages::movement::PositionType::Sanctuary =>
            {
                *latest_sanctuary.borrow_mut() =
                    Some(build_sanctuary_js(&data.pos));
            }
            _ => {}
        }
    }
    if stats_changed && let Some(w) = world.borrow().as_ref() {
        publish_player_stats_snapshot(w, &latest_stats);
        // Phase G: piggyback known-spells refresh on
        // stats_changed. The local-player biota only
        // refreshes when stat events fire (after
        // PlayerDescription / IdentifyObject response),
        // so this is the right cadence.
        publish_player_known_spells_snapshot(
            w,
            &latest_known_spells,
        );
        // PR-JJ 2026-05-23: piggyback enchantments
        // refresh on stats_changed. The dispatcher
        // already buckets PlayerEnchantmentsUpdated
        // into stats_changed (see arm at 15679), so
        // every magic update / remove / purge / dispel
        // fires us at the same cadence. JS reads via
        // `handle.playerEnchantments()` on each
        // `kind=8 playerStatsUpdated` drain.
        publish_player_enchantments_snapshot(
            w,
            &latest_enchantments,
        );
        queued_events.borrow_mut().push(ClientEvent {
            kind: CLIENT_EVENT_KIND_PLAYER_STATS_UPDATED,
            string_payload: None,
            u32_payload: None,
            u32_payload_2: None,
            f32_payload: None,
        });
    }
    // HUD rec #84 (2026-06-16): kind=58
    // SharedCooldownsUpdated. Fires whenever
    // PlayerEnchantmentsUpdated lands (cooldown or not)
    // so hotbar / vitals-hud get a narrow signal — the
    // payload-less variant lets them re-pull via
    // `playerEnchantments()` and filter on the COOLDOWN
    // bit themselves. `u32_payload` carries the cooldown
    // count for at-a-glance "anything active right now".
    if cooldowns_changed {
        const COOLDOWN_BIT: u32 = 0x1000000;
        let count = latest_enchantments
            .borrow()
            .iter()
            .filter(|e| (e.stat_mod_type & COOLDOWN_BIT) != 0)
            .count() as u32;
        queued_events.borrow_mut().push(ClientEvent {
            kind: CLIENT_EVENT_KIND_SHARED_COOLDOWNS,
            string_payload: None,
            u32_payload: Some(count),
            u32_payload_2: None,
            f32_payload: None,
        });
    }
    // === Wave 4.B — emit remote-entity enchantment event (2026-05-28) ===
    //
    // The pre-route hook just mutated
    // `entity_enchantments_index` for a non-self target.
    // Signal the UI layer so the buffs HUD's per-target
    // overlay + the nameplate sprite's buff badge can
    // refresh. JS reads the new snapshot via
    // `handle.entityEnchantments(guid)`.
    //
    // **Why a dedicated event kind** (not piggyback on
    // playerStatsUpdated): a remote enchantment change
    // does NOT modify the local player's stats — the
    // buffs HUD shouldn't re-pull `playerEnchantments()`
    // and the stats snapshot publisher shouldn't republish.
    // u32_payload carries the target GUID so the UI can
    // selectively re-render only that nameplate / target.
    if let Some(target_guid) = entity_enchantments_changed {
        let count = entity_enchantments_index
            .borrow()
            .get(&target_guid)
            .map(|v| v.len() as u32)
            .unwrap_or(0);
        queued_events.borrow_mut().push(ClientEvent {
            kind: CLIENT_EVENT_KIND_ENTITY_ENCHANTMENTS_UPDATED,
            string_payload: None,
            u32_payload: Some(target_guid),
            u32_payload_2: Some(count),
            f32_payload: None,
        });
    }
    if inventory_changed && world.borrow().is_some() {
        // Rebuilt on the next `playerInventory()` read, not per message.
        mark_player_inventory_dirty();
        queued_events.borrow_mut().push(ClientEvent {
            kind: CLIENT_EVENT_KIND_INVENTORY_UPDATED,
            string_payload: None,
            u32_payload: None,
            u32_payload_2: None,
            f32_payload: None,
        });
    }
    if fellowship_changed && let Some(w) = world.borrow().as_ref() {
        // Wave D (2026-05-25): the world dispatcher's
        // fellowship handler fires `FellowshipStateUpdated`
        // for all 5 fellowship GameEvents (FullUpdate,
        // UpdateFellow, Quit, Dismiss, Disband — plus the
        // two ack arms FellowUpdateDone / FellowStatsDone
        // which are no-ops in the handler today). Republish
        // from `world.fellowship` here and signal JS with a
        // single kind=22 event — the panel re-fetches via
        // `handle.playerFellowship()`.
        //
        // HUD rec #48: `fellowship_update_type` was set in
        // the pre-route GameEvent match above. Threads
        // into the snapshot so JS can decide between
        // `rebuildFromSnapshot()` (Full) and a per-member
        // patch path (Stats / Vitals).
        publish_player_fellowship_snapshot(
            w,
            &latest_fellowship,
            fellowship_update_type,
        );
        queued_events.borrow_mut().push(ClientEvent {
            kind: CLIENT_EVENT_KIND_FELLOWSHIP_UPDATED,
            string_payload: None,
            u32_payload: Some(fellowship_update_type),
            u32_payload_2: None,
            f32_payload: None,
        });
    }
    if trade_changed && let Some(w) = world.borrow().as_ref() {
        // AC Trade (2026-05-25): the world dispatcher's
        // trade handler fires `TradeStateUpdated` for all
        // 9 trade GameEvent arms (RegisterTrade,
        // AddToTrade, AcceptTrade, ResetTrade,
        // DeclineTrade / ClearTradeAcceptance /
        // TradeFailure, CloseTrade). Republish from
        // `world.trade` here — `None` after CloseTrade,
        // `Some` otherwise — and signal JS with a single
        // kind=23 event. The trade-panel reads via
        // `handle.playerTrade()`.
        publish_player_trade_snapshot(w, &latest_trade);
        queued_events.borrow_mut().push(ClientEvent {
            kind: CLIENT_EVENT_KIND_TRADE_UPDATED,
            string_payload: None,
            u32_payload: None,
            u32_payload_2: None,
            f32_payload: None,
        });
    }
    if let (Some(book_guid), Some(w)) = (book_changed, world.borrow().as_ref()) {
        // AC Books (2026-05-25): world dispatcher's
        // inventory handler folded BookDataResponse /
        // BookPageDataResponse into entity.book and
        // emitted EntityBookUpdated. Republish the
        // most-recently-touched book — only one book is
        // open at a time on the panel — and signal JS
        // with kind=24.
        publish_player_book_snapshot(w, book_guid, &latest_book);
        queued_events.borrow_mut().push(ClientEvent {
            kind: CLIENT_EVENT_KIND_BOOK_UPDATED,
            string_payload: None,
            u32_payload: Some(u32::from(book_guid)),
            u32_payload_2: None,
            f32_payload: None,
        });
    }

    // recv_loop split (2026-10-05): the per-`GameMessage` arms live in
    // session/messages/*.rs.
    dispatch_game_message(ctx, message).await
}

/// Route one unpacked `GameMessage` to its handler module (the old inline
/// `match message` arms, moved verbatim). Variants no module names fall to
/// `misc`, whose `_` arm is the original catch-all.
async fn dispatch_game_message(ctx: &mut LoopCtx, message: GameMessage) -> LoopFlow {
    match message {
        m @ (GameMessage::PlayerTeleport { .. }
        | GameMessage::UpdatePosition { .. }
        | GameMessage::PrivateUpdatePosition { .. }
        | GameMessage::PublicUpdatePosition { .. }
        | GameMessage::UpdateMotion { .. }
        | GameMessage::VectorUpdate { .. }) => position::handle(ctx, m).await,
        m @ (GameMessage::ObjectCreate { .. }
        | GameMessage::UpdateObject { .. }
        | GameMessage::ObjDescEvent { .. }
        | GameMessage::ParentEvent { .. }
        | GameMessage::ObjectDelete { .. }
        | GameMessage::PickupEvent { .. }) => objects::handle(ctx, m).await,
        m @ GameMessage::GameEvent { .. } => game_event::handle(ctx, m).await,
        m @ (GameMessage::ServerMessage { .. }
        | GameMessage::HearSpeech { .. }
        | GameMessage::HearRangedSpeech { .. }
        | GameMessage::EmoteText { .. }
        | GameMessage::SoulEmote { .. }
        | GameMessage::PlayerKilled { .. }
        | GameMessage::TurbineChat { .. }) => chat::handle(ctx, m).await,
        m @ (GameMessage::CharacterList { .. }
        | GameMessage::CharacterCreateResponse { .. }
        | GameMessage::CharacterEnterWorldServerReady { .. }
        | GameMessage::PlayerCreate { .. }
        | GameMessage::ServerName { .. }
        | GameMessage::DddInterrogation { .. }
        | GameMessage::CharacterError { .. }) => login::handle(ctx, m).await,
        m => misc::handle(ctx, m).await,
    }
}
