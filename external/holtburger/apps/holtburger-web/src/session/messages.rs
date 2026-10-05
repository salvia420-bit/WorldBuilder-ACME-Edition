//! Inbound server traffic for the wasm `recv_loop` (2026-10-05 split).
//!
//! The body of the loop's `for event in events` (one `SessionEvent` from
//! `session.recv_message()`), moved verbatim out of the `select!` arm:
//! TimeSync adoption, message unpack, the pre-route GameEvent hooks and
//! `*_changed` mirrors, canonical world routing, and the per-`GameMessage`
//! match. Rewrites vs the inline original: `return;` -> `return
//! LoopFlow::Exit;`, the for-level `continue` -> `return LoopFlow::Continue`
//! (next event), and `LoopFlow::Exit` as `send_or_disconnect!`'s return.

use crate::*;
use crate::session::{LoopCtx, LoopFlags, LoopFlow};
use holtburger_protocol::messages::{
    CharacterEnterWorldData, CharacterGenerationVerificationResponse, GameAction, GameMessage,
};
use holtburger_protocol::traits::ProtocolUnpack;
use holtburger_session::SessionEvent;

/// Handle one inbound `SessionEvent`. `LoopFlow::Exit` = the loop must return.
pub(crate) async fn handle_message(ctx: &mut LoopCtx, event: SessionEvent) -> LoopFlow {
    let LoopFlags {
        seq_debug,
        spawn_motion_state_on,
        spawn_door_collision_on,
        skip_contained_spawn_on,
        spawn_hidden_state_on,
        wielded_spawn_on,
        world_lifecycle_on,
        wire_state_packs_stage1_on,
        routine_pos_guard_on,
        remote_interp_on,
        remote_root_motion_on,
        remote_sticky_on,
        combat_radii_on,
        server_run_rate_on,
        retail_leash_on,
        leash_echo_gate_on,
        ..
    } = ctx.flags;
    let LoopCtx {
        session,
        queued_events,
        character_list,
        entity_updates,
        charlist_tx,
        world_bootstrap,
        latest_stats,
        latest_inventory,
        latest_vendor_state,
        latest_container_contents,
        latest_object_icons,
        latest_inscriptions,
        latest_appraisals,
        latest_enchantments,
        latest_fellowship,
        latest_trade,
        latest_book,
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
        wielder_index,
        projectile_index,
        physics_script_table_index,
        entity_enchantments_index,
        identify_meta_index,
        latest_server_info,
        latest_sanctuary,
        latest_localization,
        door_part_snapshot,
        local_player_pose,
        rynth_use_done_seq,
        rynth_busy,
        rynth_id_times,
        rynth_ground_container,
        last_recv_instant,
        last_ping_rtt_ms,
        turbine_chat_state,
        pending_confirmations,
        plugin_list,
        world,
        state,
        account_name,
        movement,
        entity_seeded,
        heartbeat_armed,
        pending_post_teleport_login_complete,
        local_player_kind1_emitted,
        local_player_spawn_emitted,
        cached_player_description,
        cached_time_sync,
        js_spawned_guids,
        seq_tracker,
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
    if inventory_changed && let Some(w) = world.borrow().as_ref() {
        publish_player_inventory_snapshot(w, &latest_inventory);
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

    match message {
        GameMessage::CharacterList(data) => {
            *account_name = data.account_name.clone();
            let new_list: Vec<CharacterSummary> = data
                .characters
                .iter()
                .map(|entry| CharacterSummary {
                    id: u32::from(entry.guid),
                    name: entry.name.clone(),
                    delete_time: entry.delete_time,
                })
                .collect();
            let count = new_list.len() as u32;
            *character_list.borrow_mut() = new_list;
            // TurbineChat: server advertises Turbine-style
            // chat capability in this packet. When
            // disabled, also clear any stale channel list
            // from a prior session.
            {
                let mut tcs = turbine_chat_state.borrow_mut();
                tcs.enabled = data.use_turbine_chat;
                if !data.use_turbine_chat {
                    tcs.channels = None;
                }
            }
            if let Some(tx) = charlist_tx.take() {
                let _ = tx.send(CharListReady {
                    account_name: account_name.clone(),
                });
            } else {
                // Re-fire after CharacterCreate /
                // CharacterDelete: surface as a kind=0
                // event so JS can call
                // `handle.characterList()` for the
                // updated snapshot.
                queued_events.borrow_mut().push(ClientEvent {
                    kind: CLIENT_EVENT_KIND_CHARACTER_LIST_RECEIVED,
                    string_payload: Some(account_name.clone()),
                    u32_payload: Some(count),
                    u32_payload_2: None,
                    f32_payload: None,
                });
            }
        }
        GameMessage::CharacterCreateResponse(data) => {
            // Phase 4 step 2a.5: surface the response
            // to JS, and on success append the new
            // character to `character_list` locally.
            // ACE does NOT auto-send a CharacterList
            // re-fire after CharacterCreate — the cli
            // (apps/holtburger-cli/src/pages/selection
            // /state.rs::handle_create_response, line
            // 307) pushes a CharacterEntry locally;
            // we mirror that here so JS sees the new
            // entry on the next handle.characterList()
            // call.
            if data.response == CharacterGenerationVerificationResponse::Ok {
                let guid = data.guid.map(u32::from).unwrap_or(0);
                let name = data.name.clone().unwrap_or_default();
                if guid != 0 {
                    character_list.borrow_mut().push(CharacterSummary {
                        id: guid,
                        name: name.clone(),
                        delete_time: 0,
                    });
                }
                queued_events.borrow_mut().push(ClientEvent {
                    kind: CLIENT_EVENT_KIND_CHARACTER_CREATED,
                    string_payload: Some(name),
                    u32_payload: Some(guid),
                    u32_payload_2: None,
                    f32_payload: None,
                });
            } else {
                let code = data.response as u32;
                let label = format!("{:?}", data.response);
                queued_events.borrow_mut().push(ClientEvent {
                    kind: CLIENT_EVENT_KIND_CHARACTER_CREATE_FAILED,
                    string_payload: Some(label),
                    u32_payload: Some(code),
                    u32_payload_2: None,
                    f32_payload: None,
                });
            }
        }
        GameMessage::PlayerTeleport(data) => {
            // Phase 4 step 3.6: ACE sets player.Teleporting=true
            // on every teleport (e.g. @telepoi) and silently
            // drops AutonomousPosition packets while the flag
            // is set. The cli pattern is to fire LoginComplete
            // back on every PlayerTeleport — that's the action
            // ACE's GameActionLoginComplete invokes
            // OnTeleportComplete on, which clears Teleporting.
            // Without this, AutonomousPosition heartbeats are
            // received but silently dropped, server-side
            // position freezes at the @telepoi destination,
            // and movement looks fine client-side but the
            // server never sees it (the original 3.6 bug
            // pattern at a different layer).
            console_log_str(&format!(
                "[step 3.6] PlayerTeleport received (teleport_seq={}); sending LoginComplete to clear Teleporting",
                data.teleport_sequence,
            ));
            // Workstream G (3D camera/game-feel fix, 2026-05-11):
            // mirror the cli's `holtburger_world::handlers::player.rs:71-78`
            // PlayerTeleport flow on the wasm side. The cli routes
            // PlayerTeleport through `routing::handle_message` →
            // `player::handle_message` which (a) advances the
            // player's teleport_sequence and (b) calls
            // `suspend_runtime_bodies(TeleportOrWorldReset)` so
            // each body's pose snaps to its authoritative_pose
            // and `sampling.mode` flips to `Suspended`. The wasm
            // bundle's `should_route_message_to_world` filter
            // does NOT include `PlayerTeleport` (the recv loop
            // owns the LoginComplete action), so without this
            // mirror the wasm-side WorldState gets:
            //   - teleport_sequence stale (never advanced).
            //   - body.sampling.mode stuck at SimulatingMotionState
            //     (from the entity-seed `set_local_player_runtime_pose`
            //     call), which is then load-bearing for the
            //     subsequent UpdatePosition's
            //     `reconcile_authoritative_body` preserve-runtime
            //     gate: with `Snapshot` + `LocalPlayer` +
            //     SimulatingMotionState, preserve=true and
            //     body.pose is NOT reset to the new (destination)
            //     pose. body.authoritative_pose updates fine via
            //     the wasm-side `set_player_position` path; the
            //     runtime pose silently sticks at the source
            //     landblock. The F-capture diag (2026-05-11)
            //     confirms:
            //       [step 3.6 tick #120] pose=(12.32,-28.48,0.00)
            //         cell=0x860201AD indoor=true ...
            //         auth=(84.00,7.10,94.00) (Holtburg
            //         destination) mode=SimulatingMotionState
            //     With pose stuck at the Academy indoor cell,
            //     the integrator's `advance_local_pose_for_-
            //     manual_drive` hits the academy-rubberband-fix
            //     pre-bake gate (indoor cell with no triangles +
            //     no AABB) and zeros lateral delta — player
            //     can't move at all even when W is pressed.
            //
            // Fix: advance teleport_sequence + suspend bodies
            // here, mirroring the world handler. Then the
            // subsequent UpdatePosition for the destination
            // hits the wasm's reconcile gate, set_player_position
            // fires (Workstream G unconditional-snap below),
            // and `reconcile_authoritative_body` sees
            // mode=Suspended → preserve=false → body.pose snaps
            // to the destination pose. mode flips to
            // AuthoritativeOnly; the integrator's next W press
            // sets it back to SimulatingMotionState.
            // A13-W1 (2026-06-11): under `?wireStatePacks=stage1`
            // the canonical `handlers/player.rs` PlayerTeleport
            // arm (routed above via
            // `should_route_message_to_world`) already performed
            // EXACTLY this pair — `set_teleport_sequence` +
            // `suspend_runtime_bodies(TeleportOrWorldReset)` —
            // so the hand-mirror below is skipped on-path (the
            // duplicated-mirror class this whole workstream
            // retires; survey A13 §3 row 3).
            if !wire_state_packs_stage1_on
                && let Some(w) = world.borrow_mut().as_mut()
            {
                w.player.set_teleport_sequence(data.teleport_sequence);
                let _ = w.suspend_runtime_bodies(
                    holtburger_world::RuntimeBodyResetCause::TeleportOrWorldReset,
                );
                // Soak-11 Layer-1 (2026-07-20): arm the
                // teleport-arrival latch. `set_teleport_sequence`
                // above pre-mirrors the destination stamp, so the
                // follow-up self `UpdatePosition` reads its
                // `teleport_sequence` EQUAL (`is_newer_u16 ==
                // false`) and lands via the Snapshot de-suspend,
                // which does NOT self-latch
                // `pending_arrival_placement` → retail's arrival
                // PLACEMENT (`find_placement_position`,
                // acclient.c:313341) is skipped and an embedded
                // arrival stays stuck at the env-cell seam. Arming
                // here lets the next self `UpdatePosition` latch the
                // placement (consume-once via
                // `take_teleport_arrival`).
                w.player.arm_teleport_arrival();
                console_log_str(&format!(
                    "[workstream-G] PlayerTeleport: advanced teleport_sequence → {} + suspended runtime bodies + armed arrival-placement latch; runtime pose will snap on next UpdatePosition",
                    data.teleport_sequence,
                ));
            }
            // A4-Q3 (2026-06-12): exit-world drain — retail
            // cancels every pending one-shot with
            // `AnimationDone(success=0)` across the portal/
            // teleport transit (`CPhysicsObj::exit_world` →
            // `MotionTableManager::HandleExitWorld` +
            // `MovementManager::HandleExitWorld`,
            // acclient.c:322215-322220 → :329940-329947,
            // :339411-339417). Dual-site with the cli recv arm
            // (client/messages.rs `PlayerTeleport`), the F2-3
            // pattern — `should_route_message_to_world` only
            // routes `PlayerTeleport` under
            // `?wireStatePacks=stage1` and the movement
            // world-event pass ignores `TeleportStarted`, so
            // the recv arm owns the trigger on BOTH stage1
            // states (no double-fire: nothing else drains).
            // Local half is `USE_MOTION_TABLE_QUEUE`-gated;
            // registry half is map-miss-inert. The JS
            // `?mtQueue` overlay-cancellation notify may land
            // before or after this drain — both orders are
            // empty-queue no-ops on the loser
            // (acclient.c:329884 head-null guard). The renderer
            // overlay stop itself is JS-owned (entities.js
            // `_cancelOneShotOverlays`, the
            // `remove_all_link_animations` analogue).
            if let Some(w) = world.borrow().as_ref() {
                movement.handle_exit_world_for(w.player.guid, true);
            }
            // F2-3 (movement bughunt 2026-06-09): sending
            // `LoginComplete` here — the instant `PlayerTeleport`
            // arrives — clears ACE's `Teleporting` flag
            // (`GameActionLoginComplete` → `OnTeleportComplete`)
            // BEFORE the destination `UpdatePosition` has been
            // applied. ACE then accepts AutonomousPosition while
            // we're still streaming the SOURCE landblock pose
            // (the desync ACE flags at `Player_Tick.cs:416`).
            // Retail's `CPlayerSystem::SendLoginCompleteNotification`
            // (`acclient.c 0x562E90`) never sends from the teleport
            // message — it gates on the destination being loaded.
            // When the flag is on, defer to the first post-teleport
            // local-player `UpdatePosition` (handled in the
            // `GameMessage::UpdatePosition` arm); ACE always emits
            // that destination pose via the "fake" SendUpdatePosition
            // in `Player_Location.Teleport`. Default-off; see
            // `holtburger_core::client::DEFER_LOGIN_COMPLETE_AFTER_TELEPORT`.
            if holtburger_core::client::DEFER_LOGIN_COMPLETE_AFTER_TELEPORT {
                *pending_post_teleport_login_complete = true;
                console_log_str(
                    "[F2-3] PlayerTeleport: deferring LoginComplete until first post-teleport UpdatePosition (destination applied)",
                );
            } else {
                let login_complete = GameAction::LoginComplete(Box::new(
                    holtburger_protocol::messages::LoginCompleteActionData,
                ));
                if let Err(e) = session.send_action(login_complete).await {
                    console_log_str(&format!(
                        "[step 3.6] post-teleport LoginComplete send failed: {e}"
                    ));
                }
            }
            // ACPlugin PR-4 (2026-05-27): Character.OnPortalSpaceEntered
            // mirror. `Character.cs:468-471` fires the bus
            // event on every Effects_PlayerTeleport — the
            // loading-screen overlay listens for it.
            queued_events.borrow_mut().push(ClientEvent {
                kind: CLIENT_EVENT_KIND_PORTAL_SPACE_ENTERED,
                string_payload: None,
                u32_payload: Some(u32::from(data.teleport_sequence)),
                u32_payload_2: None,
                f32_payload: None,
            });
        }
        GameMessage::CharacterEnterWorldServerReady => {
            // Server is acknowledging our CharacterEnterWorldRequest;
            // chain the CharacterEnterWorld reply automatically so
            // JS doesn't have to round-trip through poll_events to
            // drive each step of the spawn handshake.
            if let LoopState::EnteringWorld { guid, account } = &state {
                let msg = GameMessage::CharacterEnterWorld(Box::new(
                    CharacterEnterWorldData {
                        guid: *guid,
                        account: account.clone(),
                    },
                ));
                send_or_disconnect!(
                    queued_events,
                    e,
                    session.send_message(&msg).await,
                    "recv_loop: send CharacterEnterWorld: {e}",
                    "CharacterEnterWorld: {e}",
                    LoopFlow::Exit
                );
            }
        }
        GameMessage::PlayerCreate(data) => {
            // Phase 4 step 2a/2a.6: PlayerCreate is the
            // server's "you're in the world" signal.
            // Mirrors the cli's
            // `crates/holtburger-core/src/client/messages.rs:433-466`
            // path: queue PlayerSpawned for JS, send
            // LoginComplete back to the server (ACE
            // expects this acknowledgement before
            // accepting in-world commands like @telepoi),
            // then transition to InWorld + queue
            // EnteredWorld so JS unhides the Teleport
            // button.
            //
            // The earlier "wait for GameEvent::
            // PlayerDescription / StartGame" gate was
            // wrong — empirically ACE sends a flurry of
            // ObjectCreate / ServerName / etc. and never
            // a parseable GameEvent for our flow, but
            // PlayerCreate ALWAYS arrives, and the cli's
            // path through line 464 makes it the
            // canonical InWorld trigger anyway.
            let player_guid_raw = u32::from(data.guid);
            // Workstream A: idempotent — the SelectCharacter
            // eager-construct path (~line 11270) already
            // emitted kind=1 PlayerSpawned with this same
            // guid; suppress the duplicate so JS doesn't
            // re-run `setLocalPlayerGuid` + status-line
            // flash on a no-op event. The flag is set in
            // whichever arm fires first; the other arm
            // sees it set and skips.
            if !*local_player_kind1_emitted {
                queued_events.borrow_mut().push(ClientEvent {
                    kind: CLIENT_EVENT_KIND_PLAYER_SPAWNED,
                    string_payload: None,
                    u32_payload: Some(player_guid_raw),
                    u32_payload_2: None,
                    f32_payload: None,
                });
                *local_player_kind1_emitted = true;
            }

            let login_complete = GameAction::LoginComplete(Box::new(
                holtburger_protocol::messages::LoginCompleteActionData,
            ));
            send_or_disconnect!(
                queued_events,
                e,
                session.send_action(login_complete).await,
                "recv_loop: send LoginComplete: {e}",
                "LoginComplete: {e}",
                LoopFlow::Exit
            );

            *state = LoopState::InWorld {
                player_guid: data.guid,
            };
            queued_events.borrow_mut().push(ClientEvent {
                kind: CLIENT_EVENT_KIND_ENTERED_WORLD,
                string_payload: None,
                u32_payload: Some(player_guid_raw),
                u32_payload_2: None,
                f32_payload: None,
            });

            // Phase 4 step 3.6: construct the
            // `WorldState` the `MovementSystemHandle`
            // will tick against. Bootstrap was loaded
            // in parallel by start_session; if it isn't
            // ready yet (rare under normal flow), the
            // movement system stays disabled until the
            // next session — log a warning and continue
            // (wire-data EntityUpdate arms keep
            // entities rendering).
            // Phase 4 step 4 follow-on: WorldState is
            // typically constructed eagerly at
            // SelectCharacter time (so PlayerDescription
            // arrivals BEFORE PlayerCreate land on a
            // ready dispatcher). If that didn't happen
            // — bootstrap wasn't loaded yet, or
            // SelectCharacter took a different path —
            // construct here as a fallback.
            // Option C: edition-2024 temp-scoping is load-bearing
            // here — the `world.borrow()` condition temp drops
            // BEFORE this block runs, so the body's
            // `*world.borrow_mut() = Some(new_world)` below does not
            // double-borrow. Under edition 2021 this would panic
            // `already borrowed`.
            if world.borrow().is_none()
                && let Some(bootstrap) = world_bootstrap.borrow().clone()
            {
                let mut new_world =
                    holtburger_world::WorldState::new(bootstrap);
                new_world.player.guid = data.guid;
                let fallback_caps =
                    fallback_self_movement_capabilities();
                new_world.set_self_movement_capabilities_override(
                    fallback_caps.clone(),
                );
                // A2-P2: arm the remote driver once at
                // world creation (composite flag).
                new_world.set_remote_interp_enabled(remote_interp_on);
                // A2-P3 R2: arm remote sticky on top
                // (stickyRetail × remoteInterp ×
                // USE_STICKY_MANAGER compose rule).
                new_world.set_remote_sticky_enabled(remote_sticky_on);
                new_world.scene.set_remote_root_motion_enabled(remote_root_motion_on);
                // COMBAT-RADII (2026-07-28): size-aware
                // standoffs (?combatRadii, default ON).
                new_world.set_combat_radii_enabled(combat_radii_on);
                // MOVE-RUNRATE-105 (2026-08-11): prefer the
                // server's my_run_rate (?serverRunRate, ON).
                new_world.set_server_run_rate_enabled(server_run_rate_on);
                // Physics-parity 2026-07-03: retail
                // LOCAL lattice (?retailLeash=on).
                new_world.set_local_retail_leash(retail_leash_on);
                // Bug-A (2026-07-03): ?leashEchoGate=on.
                new_world.set_leash_echo_gate(leash_echo_gate_on);
                // P4.2 TIMESYNC: seed the server clock before
                // the world goes live so no lifecycle stamp
                // (prune deadlines etc.) is ever taken in the
                // Unix wall-clock fallback domain and later
                // compared in the PortalYearTicks domain.
                if let Some((t, at)) = *cached_time_sync {
                    let _ = new_world.set_server_time_sync(t, at);
                }
                *world.borrow_mut() = Some(new_world);
                console_log_str(&format!(
                    "[step 3.6] WorldState constructed lazily on PlayerCreate (guid=0x{:08X}) — eager-construct path missed",
                    player_guid_raw,
                ));
                // Run-skill plumbing backstop (2026-06-02):
                // this lazy-construct path means the
                // bootstrap wasn't ready at SelectCharacter,
                // so PlayerDescription (which arrives BEFORE
                // PlayerCreate) was dropped by the top-of-loop
                // `world == None` gate. Replay the cached
                // PlayerDescription now so `player.skills`
                // (incl. Run) and attributes/vitals hydrate
                // and `resolve_self_movement_capabilities`
                // can derive the real, skill-accurate run
                // rate instead of the 4.5 fallback.
                if let (Some(cached), Some(w)) =
                    (cached_player_description.as_ref(), world.borrow_mut().as_mut())
                {
                    let mut replay_events: Vec<
                        holtburger_world::WorldEvent,
                    > = Vec::new();
                    holtburger_world::handlers::routing::handle_message(
                        w,
                        cached,
                        &mut replay_events,
                    );
                    w.clear_self_movement_capabilities_override();
                    let real_caps_ok = w
                        .resolve_self_movement_capabilities()
                        .is_ok();
                    console_log_str(&format!(
                        "[run-plumb] replayed cached PlayerDescription into late-built world (PlayerCreate); skills={} real_caps_ok={}",
                        w.player.skills.len(),
                        real_caps_ok,
                    ));
                    if !real_caps_ok {
                        w.set_self_movement_capabilities_override(
                            fallback_caps,
                        );
                    }
                }
            } else if world.borrow().is_some() {
                console_log_str(&format!(
                    "[step 3.6] WorldState already constructed (eager path); PlayerCreate guid=0x{:08X} confirms",
                    player_guid_raw,
                ));
            } else {
                console_log_str(
                    "[step 3.6] WorldBootstrap not yet loaded at PlayerCreate; \
                     MovementSystem disabled this session",
                );
            }
        }
        GameMessage::GameAction(action_msg) => {
            // Server can echo a GameAction::LoginComplete
            // back as confirmation — already InWorld at
            // that point, so just log for visibility.
            // Future steps (chat, equipment, etc.) will
            // dispatch on action_msg.action variants.
            if matches!(
                action_msg.action,
                GameAction::LoginComplete(_)
            ) {
                log::debug!(
                    "recv_loop: server-echoed LoginComplete"
                );
            }
        }
        // Phase 4 step 2b: position-bearing messages.
        // Each pushes an EntityUpdate into the entity
        // channel; JS drains via pollEntityUpdates() and
        // applies updates to its `Map<guid, sprite>`.
        // Reference handlers in the cli:
        //   - UpdatePosition:        crates/holtburger-world/src/handlers/player.rs:33-46
        //   - PrivateUpdatePosition: crates/holtburger-world/src/handlers/movement.rs:41-43
        //   - PublicUpdatePosition:  crates/holtburger-world/src/handlers/movement.rs:45-46
        //   - ObjectCreate:          crates/holtburger-world/src/handlers/inventory.rs:19-51
        //   - ObjectDelete:          crates/holtburger-world/src/handlers/inventory.rs:53-56
        GameMessage::UpdatePosition(data) => {
            let pos = &data.pos.pos;
            // Phase 4 step 3: UpdatePosition is the
            // only inbound position message that
            // carries all four sequence numbers
            // (`PositionPack` vs. the bare `WorldPosition`
            // in Public/Private updates). When ACE
            // addresses the local player by guid here,
            // capture the sequences so subsequent
            // outbound MoveToState packets carry a
            // current snapshot.
            if let LoopState::InWorld { player_guid } = &state
                && data.guid == *player_guid
            {
                // A13-W1 (2026-06-11): the `LocalPlayerSnapshot`
                // quartet copy that used to be written here was
                // a write-only dead third copy (survey A13 §3
                // row 7) — the outbound MoveToState /
                // AutonomousPosition / Jump builders all read
                // `w.player.*`. Removed outright (no gate:
                // deleting dead writes is behavior-identical).
                // F2-3: this UpdatePosition is the destination
                // pose after a teleport (its sequences were just
                // captured above, so the client is now at the
                // destination). If a `PlayerTeleport` deferred its
                // `LoginComplete`, send it now — ACE clears
                // `Teleporting` and starts accepting our
                // AutonomousPosition from the correct landblock.
                if *pending_post_teleport_login_complete {
                    *pending_post_teleport_login_complete = false;
                    let login_complete = GameAction::LoginComplete(Box::new(
                        holtburger_protocol::messages::LoginCompleteActionData,
                    ));
                    if let Err(e) = session.send_action(login_complete).await {
                        console_log_str(&format!(
                            "[F2-3] deferred post-teleport LoginComplete send failed: {e}"
                        ));
                    } else {
                        console_log_str(
                            "[F2-3] deferred post-teleport LoginComplete sent (destination UpdatePosition applied)",
                        );
                    }
                }
                // Phase 4 step 3.6: UpdatePosition for the
                // local player is the canonical position
                // packet (PrivateUpdatePosition rarely fires
                // in this flow). Seed the WorldState entity
                // here so MovementSystem::tick has a pose
                // and sequences to work with.
                if let Some(w) = world.borrow_mut().as_mut() {
                    let pose = data.pos.pos;
                    if !*entity_seeded {
                        let entity =
                            holtburger_world::entity::Entity::new(
                                *player_guid,
                                String::from("LocalPlayer"),
                                pose,
                            );
                        w.add_entity(entity);
                        let _ = w.set_local_player_runtime_pose(pose);
                        *entity_seeded = true;
                        console_log_str(&format!(
                            "[step 3.6] WorldState player entity seeded via UpdatePosition at landblock=0x{:08X} ({:.1}, {:.1}, {:.1})",
                            u32::from(pose.landblock_id),
                            pose.coords.x, pose.coords.y, pose.coords.z,
                        ));
                    } else if !wire_state_packs_stage1_on {
                        // A13-W1 (2026-06-11): this whole
                        // reconcile branch is the legacy
                        // OFF-path. Under
                        // `?wireStatePacks=stage1` the routed
                        // canonical `handlers/player.rs`
                        // UpdatePosition arm already ran
                        // `apply_position_from_server` (with
                        // `is_newer_u16` acceptance gating the
                        // hand-rolled path never had) + the
                        // SAME B1/D3-SNAP Reset-vs-Snapshot
                        // discriminant +
                        // `set_player_position_with_sync` —
                        // re-running it here would double-apply.
                        //
                        // Workstream G (3D camera/game-feel
                        // fix, 2026-05-11): always call
                        // `set_player_position` for the local
                        // player's UpdatePosition. The
                        // `reconcile_authoritative_body`
                        // implementation (in scene.rs:880-896)
                        // has a `preserve_local_runtime_pose`
                        // gate that fires when
                        //   LocalPlayer ∧ Snapshot ∧
                        //   mode ∈ {SimulatingMotionState,
                        //          SimulatingVelocity}
                        // and preserves body.pose while
                        // updating body.authoritative_pose +
                        // velocity/omega. That gate IS the
                        // load-bearing piece preventing the
                        // 2026-05-10 academy-rubberband
                        // "moves a bit, snaps back" symptom:
                        // during active simulation the
                        // integrator's mode is
                        // SimulatingMotionState so routine
                        // UpdatePosition broadcasts only
                        // refresh the auth pose, leaving the
                        // predicted runtime pose intact.
                        //
                        // The previous wasm-side
                        // `force_advanced || teleport_advanced`
                        // gate was a second-layer defense
                        // that, in retrospect, has a load-
                        // bearing failure mode for teleports:
                        // PlayerTeleport's wasm handler
                        // (above, line ~10387) advances
                        // `w.player.teleport_sequence`, so
                        // the subsequent UpdatePosition for
                        // the destination carries the SAME
                        // teleport_sequence the wasm
                        // mirrored when PlayerTeleport
                        // landed — `teleport_advanced =
                        // is_newer_u16(N, N) = false`. The
                        // gate doesn't fire, set_player_-
                        // position is never called, and
                        // body.pose stays at the source
                        // landblock while body.authoritative_-
                        // pose updates to the destination
                        // (via the implicit reconcile path
                        // through subsequent ObjectCreate /
                        // VectorUpdate / etc.). The
                        // integrator's
                        // `advance_local_pose_for_manual_-
                        // drive` then runs against the
                        // source pose, hits the academy-
                        // rubberband-fix indoor pre-bake
                        // gate if the source is an indoor
                        // cell, and zeros lateral delta —
                        // player can't walk at all.
                        //
                        // PlayerTeleport (above) now ALSO
                        // calls
                        // `suspend_runtime_bodies(Teleport-
                        // OrWorldReset)` which flips
                        // `body.sampling.mode` to Suspended.
                        // On the next UpdatePosition,
                        // unconditional set_player_position
                        // → reconcile_authoritative_body
                        // sees Suspended (NOT Simulating*),
                        // preserve=false, body.pose snaps
                        // to the destination. After that
                        // the integrator's first W press
                        // re-arms SimulatingMotionState
                        // and the preserve gate engages
                        // for routine broadcasts as before.
                        //
                        // The diagnostic log now fires on
                        // every snap so a regression where
                        // routine broadcasts overwrite the
                        // runtime pose would be visible
                        // immediately (look for
                        // `[acad-diag reconcile]` lines
                        // accumulating during active
                        // W-hold — should be empty post-fix).
                        // Only emit a diagnostic when the
                        // snap will actually take effect
                        // (mode ∉ Simulating*). During
                        // active integration the
                        // preserve-runtime-pose gate
                        // fires and the set_player_position
                        // call is a no-op on body.pose;
                        // logging on every routine
                        // broadcast floods the JS
                        // console / postMessage bridge
                        // and observably slows the
                        // recv-loop drain cadence
                        // (verified via F-capture: at-fix
                        // log-on-every-tick ran 4× slower
                        // than log-on-snap-only).
                        use holtburger_world::SpatialSampleMode;
                        let snap_will_apply = w
                            .runtime_body_id_for_guid(w.player.guid)
                            .and_then(|bid| w.runtime_body_view(bid))
                            .is_some_and(|view| {
                                !matches!(
                                    view.sample_mode,
                                    SpatialSampleMode::SimulatingMotionState
                                        | SpatialSampleMode::SimulatingVelocity
                                )
                            });
                        if snap_will_apply && DIAG_VERBOSE {
                            console_log_str(&format!(
                                "[acad-diag reconcile] snapping to server pose: force_seq={} teleport_seq={} pose=({:.2}, {:.2}, {:.2})",
                                data.pos.force_position_sequence,
                                data.pos.teleport_sequence,
                                pose.coords.x,
                                pose.coords.y,
                                pose.coords.z,
                            ));
                        }
                        // B1/D3-SNAP: choose the reconcile
                        // discriminant by sequence class. This
                        // is NOT the removed call-gating
                        // footgun discussed above —
                        // set_player_position_with_sync is
                        // ALWAYS called; we only pick Reset
                        // (hard-snap: retail BlipPlayer /
                        // TeleportPlayer, acclient.c:145196-
                        // 145253) vs Snapshot (blend behind the
                        // Simulating* preserve gate). A missed
                        // teleport advance (stamp already
                        // mirrored by PlayerTeleport) just falls
                        // back to Snapshot, which the Suspended
                        // mode PlayerTeleport set still
                        // hard-snaps — cross-LB teleports are
                        // unaffected. The genuinely new case is
                        // a force_position advance WITHOUT a
                        // PlayerTeleport (the z-hack /PKLite
                        // snapback, ACE Player_Tick.cs:488 /
                        // Player.cs:1148): force_position_-
                        // sequence is strictly newer here, so
                        // the predicted body hard-snaps to
                        // LastGroundPos instead of preserving
                        // the drifted pose beyond the blip
                        // radius (RECON-1). Compared BEFORE the
                        // sequence mirror below, so w.player
                        // still holds the previous stamps.
                        let force_or_teleport_advanced =
                            holtburger_common::sequence::is_newer_u16(
                                data.pos.teleport_sequence,
                                w.player.teleport_sequence,
                            ) || holtburger_common::sequence::is_newer_u16(
                                data.pos.force_position_sequence,
                                w.player.force_position_sequence,
                            );
                        // Soak-11 Layer-1 (2026-07-20): consume the
                        // teleport-arrival latch (consume-once). Armed
                        // by the OFF-path PlayerTeleport handler above;
                        // the take clears it whether or not it fires.
                        // NOTE: the live client runs the canonical
                        // `handlers/player.rs` path (wireStatePacks
                        // default-ON); this legacy OFF-path arm is the
                        // `?wireStatePacks=off` twin — same latch shape.
                        let teleport_arrival_pending =
                            w.player.take_teleport_arrival();
                        if teleport_arrival_pending {
                            // Teleport destination arrival (pre-mirrored
                            // stamp → not `force_or_teleport_advanced`):
                            // de-suspend the body via the Snapshot
                            // reconcile (mode ∉ Simulating* ⇒ no
                            // preserve gate, body snaps to destination),
                            // then latch the retail arrival PLACEMENT
                            // (`find_placement_position`) so the movement
                            // tick de-embeds an env-cell-wall landing.
                            // Additive: the body sync/mode trajectory
                            // matches the canonical `body_suspended` arm.
                            let _ = w.set_player_position_with_sync(
                                pose,
                                holtburger_world::AuthoritativeBodySync::Snapshot,
                            );
                            w.player.latch_arrival_placement();
                        } else if routine_pos_guard_on
                            && !force_or_teleport_advanced
                        {
                            // Movement bughunt 2026-06-19
                            // ("stall → pull-back"): a ROUTINE self
                            // UpdatePosition is the laggy ~20 Hz echo of
                            // our OWN movement; when backlog-delayed it
                            // lands tens of metres behind and the
                            // preserve path eases the avatar backward
                            // (force-position interp). Keep client
                            // prediction; update authoritative
                            // bookkeeping only.
                            let _ =
                                w.set_player_position_authoritative_only(pose);
                        } else {
                            let sync = if force_or_teleport_advanced {
                                holtburger_world::AuthoritativeBodySync::Reset
                            } else {
                                holtburger_world::AuthoritativeBodySync::Snapshot
                            };
                            let _ = w.set_player_position_with_sync(pose, sync);
                        }
                    }
                    // Mirror the quartet sequences onto the
                    // WorldState player so outbound
                    // MoveToState / AutonomousPosition pull
                    // current values. LEGACY OFF-path only:
                    // under `?wireStatePacks=stage1` the
                    // canonical `apply_position_from_server`
                    // (mutations.rs) owns these writes — with
                    // sequence-acceptance gating, plus the
                    // `position_sequence` slot this mirror
                    // always dropped (A13-W1; retail single
                    // owner `CPhysicsObj::update_times[4/5/6/8]`,
                    // acclient.c:718175-718187).
                    if !wire_state_packs_stage1_on {
                        w.player.instance_sequence =
                            data.pos.instance_sequence;
                        w.player.teleport_sequence =
                            data.pos.teleport_sequence;
                        w.player.force_position_sequence =
                            data.pos.force_position_sequence;
                    }
                    if !*heartbeat_armed && *entity_seeded {
                        let now = web_time::Instant::now();
                        movement.arm_heartbeat_schedule(now, w);
                        *heartbeat_armed = true;
                        console_log_str(
                            "[step 3.6] AutonomousPosition heartbeat armed",
                        );
                    }
                    // B3-WI4 (2026-07-21): publish the pose
                    // shadow at the UpdatePosition tail so the
                    // JS cell reflects the just-applied
                    // authoritative pose the SAME tick it
                    // arrives (death/portal reconcile) instead
                    // of waiting for the next TickMovement
                    // publish. Uses the live `&mut w`
                    // (reborrowed shared) and the distinct
                    // `local_player_pose` cell — no RefCell
                    // double-borrow. The retention rule inside
                    // keeps a good prior cell if the runtime
                    // pose is transiently NULL/absent here.
                    publish_local_player_pose(w, &local_player_pose);
                }
            }
            // OpenAC comparison 2026-10-04 (remote motion D3):
            // retail drops a stale / reordered remote position
            // entirely (`SmartBox::HandleReceivedPosition`,
            // acclient.c:145125-145240). The routed world
            // handler already ran that gate
            // (`apply_entity_position_pack`); when it REJECTED
            // this frame the entity still holds its previous
            // pose — don't hand the stale pose to JS, whose
            // setPose would retarget the heading, drop the
            // sticky glue and ease toward it.
            let remote_rejected = wire_state_packs_stage1_on
                && !matches!(&state, LoopState::InWorld { player_guid } if data.guid == *player_guid)
                && world.borrow().as_ref().is_some_and(|w| {
                    w.entities
                        .get(data.guid)
                        .is_some_and(|e| e.position != *pos)
                });
            if !remote_rejected {
            entity_updates.borrow_mut().push(EntityUpdate {
                kind: ENTITY_UPDATE_KIND_POSITION,
                guid: u32::from(data.guid),
                model_id: 0,
                landblock_id: u32::from(pos.landblock_id),
                x: pos.coords.x,
                y: pos.coords.y,
                z: pos.coords.z,
                qw: pos.rotation.w,
                qx: pos.rotation.x,
                qy: pos.rotation.y,
                qz: pos.rotation.z,
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
                // A1 (2026-05-29): non-MOTION updates carry no
                // playback speed — identity (no anim scaling).
                motion_speed: 1.0,
                physics_translucency: 0.0,
                is_autonomous: false,
            });
            }
        }
        GameMessage::PrivateUpdatePosition(data) => {
            // PrivateUpdatePosition has no guid in the
            // payload (the wire message implies "the
            // local player"). Substitute the
            // LoopState::InWorld player_guid; if we
            // somehow get a Private update before
            // PlayerCreate landed, the message has no
            // owner — drop it.
            let local_guid = match &state {
                LoopState::InWorld { player_guid } => Some(*player_guid),
                _ => None,
            };
            if let Some(guid) = local_guid {
                let pos = &data.pos;
                // (A13-W1: the `LocalPlayerSnapshot` position
                // cache formerly written here was a write-only
                // dead copy — removed.)
                // Phase 4 step 3.6: seed the WorldState
                // player entity on the first inbound
                // position (we now know the spawn pose),
                // then arm the AutonomousPosition
                // heartbeat. Subsequent updates push
                // through `set_player_position` so the
                // outbound MovementSystem tick reads
                // current sequences + pose.
                if let Some(w) = world.borrow_mut().as_mut() {
                    if !*entity_seeded {
                        let entity = holtburger_world::entity::Entity::new(
                            guid,
                            String::from("LocalPlayer"),
                            *pos,
                        );
                        w.add_entity(entity);
                        let _ = w.set_local_player_runtime_pose(*pos);
                        *entity_seeded = true;
                        console_log_str(&format!(
                            "[step 3.6] WorldState player entity seeded at landblock=0x{:08X} ({:.1}, {:.1}, {:.1})",
                            u32::from(pos.landblock_id),
                            pos.coords.x, pos.coords.y, pos.coords.z,
                        ));
                    } else {
                        // 2026-05-10 reconciliation gate:
                        // PrivateUpdatePosition has no
                        // sequence numbers in its payload
                        // (`PrivateUpdatePositionData`
                        // ships only `pos: WorldPosition`),
                        // so we can't gate on force /
                        // teleport seqs here. Conservative
                        // choice: trust the integrator's
                        // prediction unconditionally for
                        // `position_type == Location`
                        // (the routine local-player
                        // broadcast). UpdatePosition's
                        // sequence-aware gate above is
                        // where genuine force-repositions
                        // come through. If a regression
                        // shows up where ACE does send a
                        // force via PrivateUpdatePosition,
                        // wire `data.position_type` into
                        // a separate snap branch here.
                        // Diagnostic: log when we'd
                        // previously have snapped, so a
                        // future regression is visible
                        // before it bites.
                        if let Some(client_pose) =
                            w.local_player_runtime_pose()
                        {
                            let dx = client_pose.coords.x - pos.coords.x;
                            let dy = client_pose.coords.y - pos.coords.y;
                            let dz = client_pose.coords.z - pos.coords.z;
                            let dist_sq = dx * dx + dy * dy + dz * dz;
                            // 5 m drift tolerance — ACE
                            // typically broadcasts within
                            // a meter of client prediction;
                            // larger drifts indicate the
                            // integrator has gotten lost.
                            if dist_sq > 25.0 {
                                if routine_pos_guard_on {
                                    // Movement bughunt 2026-06-19
                                    // ("stall → pull-back"):
                                    // PrivateUpdatePosition carries
                                    // no force/teleport sequences →
                                    // always ROUTINE. A backlog-stale
                                    // echo drifts >5 m behind; the old
                                    // `set_player_position` snap eased
                                    // the avatar backward. Keep client
                                    // prediction; bookkeeping only.
                                    let _ = w
                                        .set_player_position_authoritative_only(
                                            *pos,
                                        );
                                } else {
                                    if DIAG_VERBOSE {
                                        console_log_str(&format!(
                                            "[acad-diag reconcile] PrivateUpdatePosition drift {:.2} m → snapping to server",
                                            dist_sq.sqrt(),
                                        ));
                                    }
                                    let _ = w.set_player_position(*pos);
                                }
                            }
                        }
                    }
                    if !*heartbeat_armed && *entity_seeded {
                        let now = web_time::Instant::now();
                        movement.arm_heartbeat_schedule(now, w);
                        *heartbeat_armed = true;
                        console_log_str(
                            "[step 3.6] AutonomousPosition heartbeat armed",
                        );
                    }
                }
                entity_updates.borrow_mut().push(EntityUpdate {
                    kind: ENTITY_UPDATE_KIND_POSITION,
                    guid: u32::from(guid),
                    model_id: 0,
                    landblock_id: u32::from(pos.landblock_id),
                    x: pos.coords.x,
                    y: pos.coords.y,
                    z: pos.coords.z,
                    qw: pos.rotation.w,
                    qx: pos.rotation.x,
                    qy: pos.rotation.y,
                    qz: pos.rotation.z,
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
                // A1 (2026-05-29): non-MOTION updates carry no
                // playback speed — identity (no anim scaling).
                motion_speed: 1.0,
                physics_translucency: 0.0,
                    is_autonomous: false,
                });
            }
        }
        GameMessage::PublicUpdatePosition(data) => {
            let pos = &data.pos;
            // (A13-W1: the `LocalPlayerSnapshot` position
            // cache formerly refreshed here on a local-player
            // echo was a write-only dead copy — removed.)
            // A2-P3 (W3+ S9): minimal TargetManager-subset
            // pose feed for the LOCAL sticky target —
            // remote entities are NOT world-routed on the
            // default wasm path (S8/A8-M2 territory), so
            // the sticky target's live pose is stashed
            // here (retail StickyManager::HandleUpdateTarget,
            // acclient.c:388691-388720). One inert compare
            // unless sticky is active (never, with
            // USE_STICKY_MANAGER off).
            if let Some(w) = world.borrow_mut().as_mut()
                && w.scene.local_sticky_target() == Some(data.guid)
            {
                w.scene.sticky_pose_feed(data.guid, data.pos);
            }
            entity_updates.borrow_mut().push(EntityUpdate {
                kind: ENTITY_UPDATE_KIND_POSITION,
                guid: u32::from(data.guid),
                model_id: 0,
                landblock_id: u32::from(pos.landblock_id),
                x: pos.coords.x,
                y: pos.coords.y,
                z: pos.coords.z,
                qw: pos.rotation.w,
                qx: pos.rotation.x,
                qy: pos.rotation.y,
                qz: pos.rotation.z,
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
                // A1 (2026-05-29): non-MOTION updates carry no
                // playback speed — identity (no anim scaling).
                motion_speed: 1.0,
                physics_translucency: 0.0,
                is_autonomous: false,
            });
        }
        GameMessage::ObjectCreate(data) => {
            // csetup_id is the SetupModel id Phase 3
            // step 6's render cache uses; absent for
            // movement-only or invisible-helper objects
            // (we surface 0, JS falls back to a
            // placeholder sprite). pos is also
            // optional — child objects (held items,
            // armour, mounts) inherit position from
            // their parent and don't carry their own.
            let model_id = data.csetup_id.unwrap_or(0);
            let (lb, x, y, z, qw, qx, qy, qz) = match &data.pos {
                Some(p) => (
                    u32::from(p.landblock_id),
                    p.coords.x,
                    p.coords.y,
                    p.coords.z,
                    p.rotation.w,
                    p.rotation.x,
                    p.rotation.y,
                    p.rotation.z,
                ),
                None => (0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0),
            };
            // Academy seed (2026-05-10): for fresh-
            // character spawns ACE's `Player_Networking
            // ::SendSelf` order is PlayerDescription
            // (no pos field populated) → PlayerCreate
            // (guid only) → ObjectCreate (carries the
            // pos in `ObjectDescriptionData.pos`). The
            // existing `UpdatePosition` /
            // `PrivateUpdatePosition` seed sites at
            // `:8866-8888` and `:8970-8983` never fire
            // for the local player on a fresh spawn
            // because ACE doesn't send those messages
            // until something forces a position
            // change. Without seeding here the player
            // entity stays unseeded forever, the
            // integrator no-ops, the heartbeat never
            // arms, and ACE eventually drops us with
            // `Network Timeout`. Seed when
            // `data.public_weenie_desc.guid` is the
            // local player and `data.pos` is `Some`;
            // the entity_updates push below still
            // fires so the local-player sprite
            // renders.
            if let Some(w) = world.borrow_mut().as_mut()
                && !*entity_seeded
                && data.public_weenie_desc.guid == w.player.guid
                && w.player.guid != holtburger_common::Guid::NULL
                && let Some(pos) = data.pos
            {
                let mut entity = holtburger_world::entity::Entity::new(
                    data.public_weenie_desc.guid,
                    String::from("LocalPlayer"),
                    pos,
                );
                // Run-4.5 root-cause fix (2026-06-02): hydrate the
                // local player's full description (MotionTable +
                // Setup → mtable_id/csetup_id, flags, wcid, …) from
                // the self-CreateObject ODD. The prior bare
                // `Entity::new` seed left the player entity with no
                // motion-table source, so
                // `resolve_player_motion_table_profile` returned
                // `MotionTableSourceUnavailable`, the movement
                // watchdog pinned the 4.5 fallback override forever,
                // and run speed was a flat ~4.5 m/s for EVERY char
                // (live-confirmed). Mirrors the non-local entity
                // path (`handlers/inventory.rs:32`). ACE ships the
                // PhysicsDesc here (`Player_Networking.cs:224`
                // CreateObject(this); MTable/CSetup flags set in
                // `WorldObject_Networking.cs:473-477`).
                entity.apply_description(&data);
                // SG-A1 (2026-06-09): mirror the resolve in
                // `apply_inventory_object_create` (lib.rs ~21890).
                // `apply_description` does NOT set
                // `physics_script_table_did` — it's resolved from
                // `Setup.default_phstable_id` / `PhysicsDesc.petable_id`
                // (not an ODD field), so this local self-seed would
                // otherwise OVERWRITE the value the ungated
                // `apply_inventory_object_create` already resolved
                // (on the same ObjectCreate) back to `0`, leaving the
                // entity field diverged from the JS-facing
                // `physics_script_table_index`. Resolve + stash so the
                // local player's self-cast/buff PhysicsScript VFX
                // (GameMessageScript 0xF755 → play_effect_vfx) resolve
                // against the right table and any future entity-field
                // reader sees the correct DID.
                let table_did = resolve_physics_script_table_did(&entity);
                entity.physics_script_table_did = table_did;
                if table_did != 0 {
                    physics_script_table_index
                        .borrow_mut()
                        .insert(u32::from(data.public_weenie_desc.guid), table_did);
                }
                w.add_entity(entity);
                let _ = w.set_local_player_runtime_pose(pos);
                *entity_seeded = true;
                console_log_str(&format!(
                    "[step 3.7] WorldState player entity seeded via ObjectCreate at landblock=0x{:08X} ({:.1}, {:.1}, {:.1})",
                    u32::from(pos.landblock_id),
                    pos.coords.x, pos.coords.y, pos.coords.z,
                ));
                if !*heartbeat_armed {
                    let now = web_time::Instant::now();
                    movement.arm_heartbeat_schedule(now, w);
                    *heartbeat_armed = true;
                    console_log_str(
                        "[step 3.7] AutonomousPosition heartbeat armed",
                    );
                }
            }
            // Academy-rubberband diagnostic
            // (2026-05-10): when ANY ObjectCreate
            // arrives for the local player, log the
            // current spawn-cell AABB + triangle count.
            // Catches the "AABB is the 1 m fallback"
            // failure mode where cells with empty
            // drawing polys but real physics polys
            // get pinned at the cell centroid by the
            // safety-net clamp. This emits ONCE per
            // session via `entity_seeded` (immediately
            // after seeding above), so the operator
            // can sanity-check the spawn cell without
            // log spam.
            if let Some(w) = world.borrow().as_ref()
                && *entity_seeded
                && data.public_weenie_desc.guid == w.player.guid
                && let Some(seed_pos) = data.pos
            {
                let cell_id = w
                    .scene
                    .current_cell(&seed_pos);
                let aabb = w.scene.cell_aabb(cell_id);
                let tri_count = w.scene.cell_triangles(cell_id).len();
                if let Some(a) = aabb {
                    console_log_str(&format!(
                        "[acad-diag init] spawn cell=0x{:08X} aabb=[{:.2},{:.2},{:.2}]→[{:.2},{:.2},{:.2}] (size {:.2}×{:.2}×{:.2}) triangles={}",
                        cell_id,
                        a.min.x, a.min.y, a.min.z,
                        a.max.x, a.max.y, a.max.z,
                        a.max.x - a.min.x,
                        a.max.y - a.min.y,
                        a.max.z - a.min.z,
                        tri_count,
                    ));
                } else {
                    console_log_str(&format!(
                        "[acad-diag init] spawn cell=0x{:08X} aabb=NONE (cell not yet baked) triangles={}",
                        cell_id, tri_count,
                    ));
                }
            }
            // Phase 4 step 6a: stop discarding the
            // PublicWeenieDescription. wcid + item_type
            // drive the JS-side category dispatch
            // (step 6b); name drives nameplates (step
            // 6e); obj_scale corrects sprite size for
            // juvenile-vs-epic creature variants;
            // palette_id + mtable_id are surfaced for
            // step 6c (palette tinting) and future
            // animation work but JS may ignore them
            // until those steps land.
            let wcid = data.public_weenie_desc.wcid;
            let item_type = data.public_weenie_desc.item_type;
            let icon_id = data.public_weenie_desc.icon_id;
            let name = data
                .public_weenie_desc
                .name
                .clone()
                .unwrap_or_default();
            let obj_scale = data.obj_scale.unwrap_or(1.0);
            let palette_id = data.model_data.palette_id.unwrap_or(0);
            let mtable_id = data.mtable_id.unwrap_or(0);

            // Phase 4 step 6f: auto-fire
            // `GameAction::IdentifyObject(guid)` for
            // every portal that arrives in vision.
            // ACE marks
            // `PropertyString::AppraisalPortalDestination`
            // with `[AssessmentProperty]` (per
            // `~/ace-server/Source/ACE.Entity/Enum/
            // Properties/PropertyString.cs:63-64`)
            // — the destination text is only sent
            // server → client in response to an
            // explicit appraisal. Auto-firing on
            // ObjectCreate means each portal sprite
            // gets its destination chip ~one
            // round-trip after appearing in vision,
            // without needing the player to manually
            // click "appraise". The response routes
            // through GameEvent::IdentifyObjectResponse
            // → world's inventory::handle_event arm
            // → entity.apply_identify_response →
            // properties.strings populated → recv
            // loop's WorldEvent::EntityIdentified
            // scan emits a kind=3 META_REFRESH
            // EntityUpdate with the destination text.
            if item_type & ITEM_TYPE_PORTAL_BIT != 0 {
                let id_action = GameAction::IdentifyObject(
                    Box::new(holtburger_protocol::messages::IdentifyObjectActionData {
                        guid: data.public_weenie_desc.guid,
                    }),
                );
                if let Err(e) = session.send_action(id_action).await {
                    log::warn!(
                        "recv_loop: send_action(IdentifyObject portal=0x{:08X}): {e}",
                        u32::from(data.public_weenie_desc.guid),
                    );
                }
            }
            // Phase 4 step 6 Phase A: ACE pre-computes
            // ClothingTable substitutions in
            // `Creature.CalculateObjDesc()` (~/ace-server
            // /Source/ACE.Server/WorldObjects/Creature_
            // Networking.cs:35-243) and ships the
            // resulting per-part GfxObj swaps + texture
            // remaps + palette overlays here. Pack each
            // into the flat-pair / flat-triple shape
            // EntityUpdate's wasm-bindgen getters
            // expose, so the JS rasterizer can pass
            // them straight through to
            // `fetchEntityModelRender`.
            let mut model_changes: Vec<u32> =
                Vec::with_capacity(data.model_data.model_changes.len() * 2);
            for mc in &data.model_data.model_changes {
                model_changes.push(mc.index as u32);
                model_changes.push(mc.animation_id);
            }
            let mut texture_changes: Vec<u32> =
                Vec::with_capacity(data.model_data.texture_changes.len() * 3);
            for tc in &data.model_data.texture_changes {
                texture_changes.push(tc.part_index as u32);
                texture_changes.push(tc.old_id);
                texture_changes.push(tc.new_id);
            }
            let mut sub_palettes: Vec<u32> =
                Vec::with_capacity(data.model_data.sub_palettes.len() * 3);
            for sp in &data.model_data.sub_palettes {
                sub_palettes.push(sp.id);
                sub_palettes.push(sp.offset as u32);
                sub_palettes.push(sp.length as u32);
            }
            // Workstream A: detect if this ObjectCreate is
            // for the local player so we can flag-track the
            // KIND_SPAWN emission. Pre-A every ObjectCreate
            // unconditionally pushed a KIND_SPAWN; that
            // remains the path for NPC / item spawns. For
            // the local player specifically we want
            // idempotent emit: if this is the local player
            // AND we've already emitted their Spawn (e.g.
            // we'll add a UpdatePosition-driven emit below
            // once we know pose), drop the duplicate so the
            // JS-side spawn handler runs once. The local-
            // player guid only equals `world.player.guid`
            // when the eager-WorldState construct already
            // ran — pre-eager-construct it's
            // `Guid::NULL` and the comparison is false, so
            // pre-spawn ObjectCreates (rare in this flow)
            // still emit unconditionally.
            let is_local_player = world.borrow()
                .as_ref()
                .map(|w| {
                    w.player.guid != holtburger_common::Guid::NULL
                        && data.public_weenie_desc.guid == w.player.guid
                })
                .unwrap_or(false);
            let skip_local_player_spawn =
                is_local_player && *local_player_spawn_emitted;
            // F16-2 — origin-ghost cull. A contained pack item
            // arrives with no world `pos` (renders at LB 0) and
            // no `wielder_id` (won't be hand-attached, so no rig
            // is needed). Its UI is already served by the
            // inventory snapshot path. Skip its KIND_SPAWN under
            // ?skipContainedSpawn=on. Wielded items keep spawning
            // (the ParentEvent attach needs the rig); world
            // objects keep spawning (pos is Some); the local
            // player always has a pos so is never skipped here.
            let skip_contained_spawn = skip_contained_spawn_on
                && data.pos.is_none()
                && data.public_weenie_desc.wielder_id.is_none();
            // F3-1 (bughunt 2026-06-09) — surface the projectile
            // launch velocity on Spawn. ACE NEVER broadcasts an
            // in-flight UpdatePosition for a `PhysicsState::MISSILE`
            // object (the missile-tick `SendUpdatePosition` is
            // commented out — WorldObject_Tick.cs), so the ONLY
            // motion datum the client ever receives for a bolt /
            // arrow / thrown weapon is the `ObjectCreate` PhysicsDesc
            // velocity (parsed at description.rs:1052-1057, stored on
            // the world entity at entity.rs:930-931). Pre-fix that
            // value was dropped here (vx/vy/vz hard-zeroed) and the
            // dead-reckon path only moves entities with a server
            // POSITION target — so every projectile sat frozen at the
            // launch point for its whole flight. Forward it on the
            // existing vx/vy/vz fields ONLY for missiles (non-missile
            // spawns keep 0 → JS never marks them ballistic); the JS
            // tick integrates it (entities.js ballistic branch). Arc
            // curvature (gravity, the `PhysicsState::GRAVITY` bit) is
            // a cosmetic follow-on: the projectile despawns on impact
            // within its sub-second flight, so constant-velocity never
            // sails off and impact VFX now plays near the target.
            let (spawn_vx, spawn_vy, spawn_vz) = if data
                .physics_state
                .contains(holtburger_common::properties::PhysicsState::MISSILE)
            {
                data.velocity
                    .map(|v| (v.x, v.y, v.z))
                    .unwrap_or((0.0, 0.0, 0.0))
            } else {
                (0.0, 0.0, 0.0)
            };
            // "why not both" (2026-06-09): the SPAWN motion_command
            // (below) hardcoded Ready on the stale assumption that
            // "the CreateObject wire payload carries no current-
            // motion state" — but it DOES (`movement_data`,
            // ObjectDescriptionData, when the MOVEMENT physics flag
            // is set; ACE WorldObject_Networking.cs:309). So an
            // already-open door (forward_command `On` 0x000B) — or
            // any non-Ready-posed entity — rendered Ready/closed at
            // spawn and only corrected if a LIVE UpdateMotion
            // followed. Under `?spawnMotionState=on`, seed the
            // spawn pose from that current motion (same parser the
            // world Entity uses for `motion_snapshot`,
            // entity.rs:947). Low-16 form matches the live kind=5
            // path. `0` / absent → keep the Ready-or-0 default.
            let spawn_motion_cmd: u32 = {
                let from_state = if spawn_motion_state_on {
                    holtburger_world::entity::EntityMotionSnapshot::from_object_description(&data)
                        .and_then(|s| s.motion_command())
                        .map(|c| u32::from(c.raw()))
                        .filter(|&c| c != 0)
                } else {
                    None
                };
                from_state.unwrap_or(if mtable_id != 0 { 0x4100_0003 } else { 0 })
            };
            if !skip_local_player_spawn && !skip_contained_spawn {
                entity_updates.borrow_mut().push(EntityUpdate {
                    kind: ENTITY_UPDATE_KIND_SPAWN,
                    guid: u32::from(data.public_weenie_desc.guid),
                    model_id,
                    landblock_id: lb,
                    x,
                    y,
                    z,
                    qw,
                    qx,
                    qy,
                    qz,
                    wcid,
                    item_type,
                    name,
                    obj_scale,
                    icon_id,
                    palette_id,
                    mtable_id,
                    model_changes,
                    texture_changes,
                    sub_palettes,
                    // A9-Stage1: wire placement id (PhysicsDesc
                    // .animation_frame); JS threads it into the
                    // rest-pose chain under ?placementId=on.
                    placement_id: data.animation_frame.unwrap_or(0),
                    portal_destination: String::new(),
                    // F3-1: launch velocity for missiles (0 otherwise).
                    vx: spawn_vx,
                    vy: spawn_vy,
                    vz: spawn_vz,
                    omega_z: 0.0,
                    // Render-completeness audit (2026-05-29):
                    // default animatable entities (those with a
                    // MotionTable) to the looping Ready idle
                    // cycle at spawn. The CreateObject wire
                    // payload carries no current-motion state,
                    // so pre-fix every entity spawned with
                    // motion_command=0 → classifyMotionCommand
                    // returned null → the rig sat frozen at the
                    // rest pose ("statue NPCs"). Ready
                    // (0x41000003) is ACE's default
                    // ForwardCommand for an idle creature
                    // (RawMotionState.cs:124). Entities with no
                    // MotionTable (items, doors, scenery) keep 0
                    // so they never attempt an idle clip (the
                    // Ready fetch would cache-miss → rest pose).
                    // If the server later broadcasts an explicit
                    // motion (combat, sit, dead), the kind=5
                    // UpdateMotion arm overrides this. "why not
                    // both" (2026-06-09): now seeded from the
                    // spawn-time current motion when
                    // `?spawnMotionState=on` (see `spawn_motion_cmd`
                    // above); falls back to this Ready-or-0 default.
                    motion_command: spawn_motion_cmd,
                    motion_stance: 0,
                    // H2 (2026-05-12): plumb the entity's
                    // PhysicsScript DID through to JS so
                    // entities.js can walk the chain.
                    //
                    // C2 (2026-06-03): the wire PhysicsDesc
                    // `DefaultScript` (data.default_script_id) is
                    // a `PScriptType` ENUM (+ intensity), NOT a
                    // 0x33 DID — feeding it raw to JS
                    // fetchPhysicsScript (which guards
                    // `did >> 24 == 0x33`) silently no-ops. Only
                    // forward an actual 0x33 PhysicsScript DID
                    // here; the PScriptType -> DID resolution (via
                    // the entity's PhysicsScriptTable / GetScript —
                    // the Wave-17 GameMessageScript path — with
                    // default_script_intensity) is a runtime
                    // resolver, deferred. The SetupModel
                    // .default_script 0x33 static path already
                    // covers the common ambient case.
                    physics_script_did: data
                        .default_script_id
                        .filter(|d| (d >> 24) == 0x33)
                        .unwrap_or(0),
                    // Task E (2026-05-12): plumb the entity's
                    // SoundTable DID. The wire field is
                    // `stable_id` (PhysicsDescriptionFlag::STABLE),
                    // backed server-side by the weenie's
                    // `PropertyDataId::SoundTable` (= 3) — see
                    // `holtburger_common::properties::world_object::stable_id()`.
                    // JS-side EntityManager prewarms its
                    // `SoundTableCache` with this DID on spawn so
                    // animation Sound/SoundTable hooks resolve
                    // synchronously after the first frame.
                    // 2026-06-05 [D7-NEW-2]: was
                    // `data.stable_id.unwrap_or(0)` (wire STABLE
                    // ONLY), which dropped the Setup-model fallback
                    // the physics-script table already honors.
                    // `resolve_sound_table_did` implements retail's
                    // two-source chain — wire `stable_id`
                    // (PhysicsDesc STABLE override,
                    // acclient.c:322308-322319) ELSE
                    // `Setup.default_stable_id`
                    // (acclient.c:320871-320884) — so entities that
                    // omit STABLE but carry a CSetup
                    // `default_sound_table` no longer play silence.
                    sound_table_did: {
                        // Event-sound coverage (2026-06-09): the
                        // local player's Setup often omits
                        // `default_sound_table` (character models
                        // are clothing-base composites; the real
                        // table is the race/gender humanoid STB),
                        // so the strict two-source resolve yields 0
                        // and every player.Guid-targeted sound
                        // (eat/pickup/drop/wield/raise-trait/…) plus
                        // animation Sound-hooks play silence. Fall
                        // back to the humanoid table for the local
                        // player only; remote entities keep 0 =
                        // genuinely no SoundTable. Mirrors the JS
                        // kind=16 safety net (index.html ~9870).
                        let stb = resolve_sound_table_did(
                            data.stable_id,
                            data.csetup_id.unwrap_or(0),
                        );
                        if stb == 0 && is_local_player {
                            DEFAULT_HUMANOID_SOUND_TABLE
                        } else {
                            stb
                        }
                    },
                    // Entity-Completeness E.B (2026-05-19):
                    // canonical-classifier inputs. WorldObjectManager
                    // pipes these through canonicalClassify(item_type,
                    // obj_desc_flags, weenie_flags) to derive the JS
                    // typed class. See docs/entity-completeness-method.md.
                    obj_desc_flags: data
                        .public_weenie_desc
                        .obj_desc_flags
                        .bits(),
                    weenie_flags: data
                        .public_weenie_desc
                        .weenie_flags
                        .bits(),
                    // A1 (2026-05-29): Spawn carries no
                    // playback speed — identity (no scaling).
                    motion_speed: 1.0,
                    // Render audit G16 / rank-6 (2026-06-09):
                    // OBJECT-level translucency from the wire
                    // PhysicsDesc (`description.rs:1043-1050`).
                    // `data.translucency` is the same
                    // `Option<f32>` ODD field that feeds the
                    // `PropertyFloat::Translucency` hydration
                    // (`hydration.rs:241-243`); source it here
                    // exactly the way `obj_scale` above does.
                    // `0.0` (opaque) when the TRANSLUCENCY flag
                    // is absent.
                    physics_translucency: data
                        .translucency
                        .unwrap_or(0.0),
                    is_autonomous: false,
                });
                // wieldedSpawn (2026-06-11): record the live rig.
                js_spawned_guids
                    .insert(u32::from(data.public_weenie_desc.guid));
                // wieldedSpawn (2026-06-11): login-hydrated wielded
                // item — case (b) of the flag comment above. ACE
                // sends the owner no ParentEvent for items already
                // wielded at login; the parent linkage rides in
                // THIS ObjectCreate's PhysicsDesc (parent_id +
                // parent_loc, written when WielderId AND
                // ParentLocation are both set —
                // WorldObject_Networking.cs:358-362). Mirror
                // retail's CreateObject-with-parent path
                // (acclient.c:391955-391961: set_parent straight
                // from PhysicsDesc, never enter_world): emit the
                // same kind=7 ATTACH the live ParentEvent arm
                // emits, with placement from the PhysicsDesc
                // animation_frame (the field hydration maps to
                // PropertyInt::Placement). The JS side parks it in
                // `_pendingAttach` until both rigs exist.
                if wielded_spawn_on
                    && let Some(parent_guid) = data.parent_id
                {
                    entity_updates.borrow_mut().push(EntityUpdate {
                        kind: ENTITY_UPDATE_KIND_ATTACH,
                        guid: u32::from(data.public_weenie_desc.guid),
                        model_id: u32::from(parent_guid),
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
                        motion_command: data.parent_loc.unwrap_or(0),
                        motion_stance: data.animation_frame.unwrap_or(0),
                        physics_script_did: 0,
                        sound_table_did: 0,
                        obj_desc_flags: 0,
                        weenie_flags: 0,
                        motion_speed: 1.0,
                        physics_translucency: 0.0,
                        is_autonomous: false,
                    });
                }
                if is_local_player {
                    *local_player_spawn_emitted = true;
                    console_log_str(&format!(
                        "[workstream-A] emitted KIND_SPAWN for local player on ObjectCreate (guid=0x{:08X}, pose lb=0x{:08X} ({:.1}, {:.1}, {:.1}))",
                        u32::from(data.public_weenie_desc.guid),
                        lb, x, y, z,
                    ));
                }
                // F16-5 (2026-06-09): spawn-time draw gate. The
                // KIND_SPAWN above carries no PhysicsState, so a
                // hidden/cloaked/no-draw entity renders at spawn.
                // Mirror `Entity::should_draw()`
                // (entity.rs:959 — HIDDEN|NO_DRAW|CLOAKED) the way
                // `upsert_entity_from_create` does for the routed
                // path: emit a kind=17 visibility:false alongside
                // the spawn so JS hides the rig until ACE clears the
                // bit (login-bubble pop, uncloak) via the existing
                // SetState→EntityVisibilityChanged path. Reaches JS
                // before the async rig exists → queued in
                // `_pendingVisibility`, drained on spawn. Behind
                // `?spawnHiddenState=on` (render pipeline).
                if spawn_hidden_state_on
                    && data.physics_state.intersects(
                        holtburger_common::properties::PhysicsState::HIDDEN
                            | holtburger_common::properties::PhysicsState::NO_DRAW
                            | holtburger_common::properties::PhysicsState::CLOAKED,
                    )
                {
                    queued_events.borrow_mut().push(ClientEvent {
                        kind: CLIENT_EVENT_KIND_ENTITY_VISIBILITY_CHANGED,
                        string_payload: None,
                        u32_payload: Some(u32::from(data.public_weenie_desc.guid)),
                        u32_payload_2: Some(0),
                        f32_payload: None,
                    });
                }
            }

            // Phase 6 step E follow-up (2026-05-09):
            // Door registration. The DOOR-flagged entity
            // was inserted into `world.entities` by
            // `apply_inventory_object_create` above, so
            // its `flags` carry the DOOR bit from
            // `PublicWeenieDescription::obj_desc_flags`
            // and its `position` is the spawn pose. We
            // sweep the per-cell building-AABB index for
            // the spawn point: the AABB whose XY
            // footprint contains the door point is the
            // building part the door lives in. Bind
            // `door_guid → (BuildingId, part_index)` in
            // the scene so subsequent
            // `set_door_aabb_active` calls can flip the
            // exact entry by GUID, AND publish a
            // `DoorPartSnapshot` carrying the placement
            // origin so the JS-side kind=15 handler can
            // map back to the building's PIXI container
            // by `${landblockId}_${x}_${y}_${modelId}`.
            //
            // Failure modes — all benign, JS keeps a 5m
            // `findClosestBuildingPart` fallback:
            // - ObjectCreate races
            //   `populateBuildingAabbsForLandblock` (no
            //   AABBs yet → empty candidate list);
            // - placement origin not yet drained from
            //   `BUILDING_ORIGIN_PENDING` (we register
            //   the door but skip the snapshot push so
            //   we don't store a bogus xy);
            // - door for an admin-spawned dynamic
            //   dungeon (no `LandblockInfo.buildings`
            //   entry → no AABB candidates).
            if let Some(w) = world.borrow_mut().as_mut() {
                use holtburger_common::properties::{
                    ObjectDescriptionFlag, PhysicsState,
                };
                let guid = data.public_weenie_desc.guid;
                // F17-3: also capture whether the door spawned
                // OPEN (ETHEREAL) so its closed-door collision
                // can be dropped at spawn under the flag.
                let door_state = w
                    .entities
                    .get(guid)
                    .filter(|e| e.flags.contains(ObjectDescriptionFlag::DOOR))
                    .map(|e| {
                        (e.position, e.physics_state.contains(PhysicsState::ETHEREAL))
                    });
                let pose = door_state.map(|(p, _)| p);
                let spawned_open = door_state.map(|(_, eth)| eth).unwrap_or(false);
                if let Some(pose) = pose {
                    let candidates = w.scene.building_aabbs_near_pose(&pose);
                    let px = pose.coords.x;
                    let py = pose.coords.y;
                    let mut hit: Option<(
                        holtburger_world::BuildingId,
                        u8,
                    )> = None;
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
                    if let Some((building_id, part_index)) = hit {
                        let door_guid = u64::from(u32::from(guid));
                        w.scene.register_door_part(
                            door_guid,
                            building_id,
                            part_index,
                        );
                        // F17-3: door spawned OPEN — drop its
                        // closed-door building AABB so it isn't
                        // an invisible wall (mirrors the live
                        // DoorStateChanged{Open} handler).
                        if spawn_door_collision_on && spawned_open {
                            let flipped = w.scene.set_door_aabb_active(
                                building_id, part_index, false,
                            );
                            console_log_str(&format!(
                                "[F17-3] door 0x{:08X} spawned OPEN → set_door_aabb_active(bid={:?}, pidx={}, active=false) flipped={}",
                                u32::from(guid), building_id, part_index, flipped,
                            ));
                        }
                        if let Some((origin_x, origin_y)) =
                            w.scene.building_origin(building_id)
                        {
                            door_part_snapshot.borrow_mut().insert(
                                u32::from(guid),
                                DoorPartSnapshot {
                                    landblock_id: building_id.landblock_id,
                                    model_id: building_id.model_id,
                                    origin_x,
                                    origin_y,
                                    part_index,
                                },
                            );
                        }
                    } else if spawn_door_collision_on && spawned_open {
                        // F17-3: indoor cell door (no building
                        // AABB enclosed the pose) that spawned
                        // OPEN — add the same cell-mesh exclusion
                        // AABB the live DoorStateChanged{Open}
                        // arm builds, so the door PANEL polys in
                        // the EnvCell BSP don't block the doorway.
                        let g = pose.global_coords();
                        let aabb = holtburger_common::Aabb {
                            min: holtburger_common::Vector3::new(
                                g.x - 1.5, g.y - 1.5, g.z - 0.5,
                            ),
                            max: holtburger_common::Vector3::new(
                                g.x + 1.5, g.y + 1.5, g.z + 3.0,
                            ),
                        };
                        w.scene.add_open_door_exclusion(u32::from(guid), aabb);
                        console_log_str(&format!(
                            "[F17-3] door 0x{:08X} spawned OPEN — INDOOR: added cell-mesh exclusion AABB @ global ({:.1},{:.1},{:.1}) (count now {})",
                            u32::from(guid), g.x, g.y, g.z,
                            w.scene.open_door_exclusion_len(),
                        ));
                    }
                }
            }
        }
        GameMessage::UpdateObject(data) => {
            // Wave 7.3 (2026-05-24): mid-game appearance
            // change. ACE re-runs `Creature.CalculateObjDesc`
            // server-side when an item is equipped /
            // unequipped, then broadcasts the full
            // `ObjectDescriptionData` on opcode 0xF7DB.
            // We pack the four substitution-relevant
            // fields into an EntityUpdate kind=6 and let
            // the JS-side `applyAppearance` re-invoke
            // the spawn-time animation cache with the
            // new substitutions. All position / weenie-
            // metadata fields are zeroed — JS reuses
            // the cached spawn meta. Flat-encoding
            // pattern mirrors the ObjectCreate arm
            // above verbatim.
            let mut model_changes: Vec<u32> =
                Vec::with_capacity(data.model_data.model_changes.len() * 2);
            for mc in &data.model_data.model_changes {
                model_changes.push(mc.index as u32);
                model_changes.push(mc.animation_id);
            }
            let mut texture_changes: Vec<u32> =
                Vec::with_capacity(data.model_data.texture_changes.len() * 3);
            for tc in &data.model_data.texture_changes {
                texture_changes.push(tc.part_index as u32);
                texture_changes.push(tc.old_id);
                texture_changes.push(tc.new_id);
            }
            let mut sub_palettes: Vec<u32> =
                Vec::with_capacity(data.model_data.sub_palettes.len() * 3);
            for sp in &data.model_data.sub_palettes {
                sub_palettes.push(sp.id);
                sub_palettes.push(sp.offset as u32);
                sub_palettes.push(sp.length as u32);
            }
            let palette_id = data.model_data.palette_id.unwrap_or(0);
            entity_updates.borrow_mut().push(EntityUpdate {
                kind: ENTITY_UPDATE_KIND_APPEARANCE,
                guid: u32::from(data.public_weenie_desc.guid),
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
                // R7 (?runtimeObjScale=on, 2026-06-09): carry the
                // runtime obj_scale from the full UpdateObject ODD so a
                // server grow/shrink reaches the rig (JS applies it when
                // >0). 1.0 = default scale when the ODD omits it.
                obj_scale: data.obj_scale.unwrap_or(1.0),
                icon_id: 0,
                palette_id,
                mtable_id: 0,
                model_changes,
                texture_changes,
                sub_palettes,
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
                // A1 (2026-05-29): non-MOTION updates carry no
                // playback speed — identity (no anim scaling).
                motion_speed: 1.0,
                // R7: carry runtime OBJECT translucency from the
                // UpdateObject ODD (JS applies when >=0; ghost/cloak
                // grow). 0.0 = opaque when the ODD omits TRANSLUCENCY.
                physics_translucency: data.translucency.unwrap_or(0.0),
                is_autonomous: false,
            });
        }
        GameMessage::ObjDescEvent(data) => {
            // Render-completeness audit (2026-05-29): the
            // *dedicated* "character changed clothes" message
            // is ObjDescEvent (0xF625), which ACE broadcasts on
            // every common in-world appearance change — equip
            // (`Creature_Equipment.cs:365`), dequip (`:438`),
            // dye/tinker recolor (`RecipeManager.cs:403`),
            // death (`Creature_Death.cs:482`), and char-option
            // changes. The UpdateObject (0xF7DB) arm above only
            // fires for full-object resends (hooks/aetheria/
            // tailoring), so without this arm the everyday
            // equip/dye/death cases were silently dropped and
            // every NPC / remote player kept its spawn-time
            // appearance forever. ObjDescEventData carries only
            // guid + model_data + sequences (no
            // PublicWeenieDescription), so we feed model_data
            // straight into a kind=6 EntityUpdate exactly like
            // the UpdateObject arm; JS-side `applyAppearance`
            // reuses the cached spawn meta for the rest.
            let mut model_changes: Vec<u32> =
                Vec::with_capacity(data.model_data.model_changes.len() * 2);
            for mc in &data.model_data.model_changes {
                model_changes.push(mc.index as u32);
                model_changes.push(mc.animation_id);
            }
            let mut texture_changes: Vec<u32> =
                Vec::with_capacity(data.model_data.texture_changes.len() * 3);
            for tc in &data.model_data.texture_changes {
                texture_changes.push(tc.part_index as u32);
                texture_changes.push(tc.old_id);
                texture_changes.push(tc.new_id);
            }
            let mut sub_palettes: Vec<u32> =
                Vec::with_capacity(data.model_data.sub_palettes.len() * 3);
            for sp in &data.model_data.sub_palettes {
                sub_palettes.push(sp.id);
                sub_palettes.push(sp.offset as u32);
                sub_palettes.push(sp.length as u32);
            }
            let palette_id = data.model_data.palette_id.unwrap_or(0);
            entity_updates.borrow_mut().push(EntityUpdate {
                kind: ENTITY_UPDATE_KIND_APPEARANCE,
                guid: u32::from(data.guid),
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
                // R7: ObjDescEvent (equip/dye/death) carries NO
                // obj_scale on the wire — send the 0.0 sentinel = "no
                // scale change" so JS keeps the entity's current scale
                // (never resets a grown mob on every equip/dye).
                obj_scale: 0.0,
                icon_id: 0,
                palette_id,
                mtable_id: 0,
                model_changes,
                texture_changes,
                sub_palettes,
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
                // A1 (2026-05-29): non-MOTION updates carry no
                // playback speed — identity (no anim scaling).
                motion_speed: 1.0,
                // R7: ObjDescEvent carries no translucency — -1.0
                // sentinel = "no translucency change" (JS keeps current).
                physics_translucency: -1.0,
                is_autonomous: false,
            });
        }
        GameMessage::ParentEvent(data) => {
            // Render-completeness audit (2026-05-29): a wielded
            // child (weapon/shield/bow) was equipped (or, when
            // parent_guid == NULL, unequipped). ACE sends the
            // child its own ObjectCreate (so the 3D rig already
            // exists) plus this ParentEvent linking it to the
            // wielder at `location` (RightHand=1, …) with a grip
            // `placement`. Pre-fix this was consumed only by the
            // world-state inventory handler (which removes the
            // child from the Rust spatial scene — correct — but
            // never re-attaches the rig), leaving wielders with
            // empty hands. We push a kind=7 ATTACH EntityUpdate
            // so the JS rig parents the child Group under the
            // wielder's part node at the holding-location frame
            // (resolved via fetchSetupHoldingLocations). Field
            // reuse documented on ENTITY_UPDATE_KIND_ATTACH:
            // model_id=parent guid (0 = detach), motion_command=
            // location, motion_stance=placement.
            //
            // wieldedSpawn (2026-06-11): pack→wield — case (a) of
            // the flag comment at recv-loop start. The child's
            // only ObjectCreate (contained: no pos, no wielder)
            // was culled by `skip_contained_spawn` and ACE never
            // re-sends a CreateObject to the equipping player, so
            // the kind=7 ATTACH below would park in JS
            // `_pendingAttach` forever. Synthesize the missing
            // KIND_SPAWN from the cached world entity (hydrated
            // from that login ObjectCreate by
            // `apply_inventory_object_create`) so the existing
            // spawn→_flushPendingAttach machinery attaches it.
            // LOSSY by design: the entity cache keeps the
            // Setup/MTable/STable DIDs + scale + translucency but
            // NOT the ObjDesc model_data (palette/texture swaps,
            // hydration.rs:190-251) — base weapon look only.
            // Spawn pose = the wielder's cached pose (the attach
            // overrides it; paired with the JS-side
            // pending-attach hide so nothing flashes at origin).
            // Skipped when the guid already has a live rig
            // (ground-pickup→wield, re-equip) — no double spawn.
            if wielded_spawn_on
                && data.parent_guid != holtburger_common::Guid::NULL
                && !js_spawned_guids.contains(&u32::from(data.child_guid))
                && let Some(w) = world.borrow().as_ref()
                && let Some(entity) = w.entities.get(data.child_guid)
            {
                use holtburger_common::properties::{
                    PropertyFloat, WorldObjectExt as _,
                    WorldObjectPropertyAccessors as _,
                };
                let setup_did =
                    entity.csetup_id().map(u32::from).unwrap_or(0);
                // No cached Setup → JS `_spawnImpl` would bail on
                // setupId 0 anyway; skip (nothing to render).
                if setup_did != 0 {
                    let mtable_id =
                        entity.mtable_id().map(u32::from).unwrap_or(0);
                    let (lb, x, y, z, qw, qx, qy, qz) = w
                        .entities
                        .get(data.parent_guid)
                        .map(|p| {
                            (
                                u32::from(p.position.landblock_id),
                                p.position.coords.x,
                                p.position.coords.y,
                                p.position.coords.z,
                                p.position.rotation.w,
                                p.position.rotation.x,
                                p.position.rotation.y,
                                p.position.rotation.z,
                            )
                        })
                        .unwrap_or((0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0));
                    entity_updates.borrow_mut().push(EntityUpdate {
                        kind: ENTITY_UPDATE_KIND_SPAWN,
                        guid: u32::from(data.child_guid),
                        model_id: setup_did,
                        landblock_id: lb,
                        x,
                        y,
                        z,
                        qw,
                        qx,
                        qy,
                        qz,
                        wcid: entity.wcid.unwrap_or(0),
                        item_type: entity.item_type_int().unwrap_or(0),
                        name: entity.name().to_string(),
                        obj_scale: entity
                            .get_float_prop(PropertyFloat::DefaultScale)
                            .map(|v| v as f32)
                            .unwrap_or(1.0),
                        icon_id: entity.icon_id.unwrap_or(0),
                        // model_data is not cached on the entity —
                        // base palette / no swaps (see arm comment).
                        palette_id: 0,
                        mtable_id,
                        model_changes: Vec::new(),
                        texture_changes: Vec::new(),
                        sub_palettes: Vec::new(),
                        placement_id: 0,
                        portal_destination: String::new(),
                        vx: 0.0,
                        vy: 0.0,
                        vz: 0.0,
                        omega_z: 0.0,
                        // Mirror the ObjectCreate spawn default:
                        // Ready idle when a MotionTable exists.
                        motion_command: if mtable_id != 0 {
                            0x4100_0003
                        } else {
                            0
                        },
                        motion_stance: 0,
                        physics_script_did: entity
                            .default_script_id()
                            .map(u32::from)
                            .filter(|d| (d >> 24) == 0x33)
                            .unwrap_or(0),
                        sound_table_did: resolve_sound_table_did(
                            entity.stable_id().map(u32::from),
                            setup_did,
                        ),
                        obj_desc_flags: entity.flags.bits(),
                        weenie_flags: entity.weenie_flags.bits(),
                        motion_speed: 1.0,
                        physics_translucency: entity
                            .get_float_prop(PropertyFloat::Translucency)
                            .map(|v| v as f32)
                            .unwrap_or(0.0),
                        is_autonomous: false,
                    });
                    js_spawned_guids.insert(u32::from(data.child_guid));
                }
            }
            // Bug #4 (2026-06-29): on unwield/detach
            // (parent_guid == NULL) drop the live-rig ledger
            // entry. Unwield arrives as THIS ParentEvent (not an
            // ObjectDelete/PickupEvent), so without this the guid
            // lingered in `js_spawned_guids` and the wieldedSpawn
            // synthesis above was skipped on a later re-wield —
            // the re-equipped item then showed empty hands.
            if data.parent_guid == holtburger_common::Guid::NULL {
                js_spawned_guids.remove(&u32::from(data.child_guid));
            }
            entity_updates.borrow_mut().push(EntityUpdate {
                kind: ENTITY_UPDATE_KIND_ATTACH,
                guid: u32::from(data.child_guid),
                model_id: u32::from(data.parent_guid),
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
                motion_command: data.location,
                motion_stance: data.placement,
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
        GameMessage::ObjectDelete(data) => {
            // wieldedSpawn (2026-06-11): rig removed — drop the
            // live-rig ledger entry.
            js_spawned_guids.remove(&u32::from(data.guid));
            entity_updates.borrow_mut().push(EntityUpdate {
                kind: ENTITY_UPDATE_KIND_REMOVE,
                guid: u32::from(data.guid),
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
                // A1 (2026-05-29): non-MOTION updates carry no
                // playback speed — identity (no anim scaling).
                motion_speed: 1.0,
                physics_translucency: 0.0,
                is_autonomous: false,
            });
        }
        GameMessage::PickupEvent(data) => {
            // F16-3: an item was picked up (by you or anyone
            // else) — incl. arrows/bolts after missile combat.
            // ACE sends this instead of an ObjectDelete, so
            // without a handler the mesh stayed on the ground
            // (and clickable) for the rest of the session.
            // Treat it as a removal, keyed by guid (the drop-
            // to-ground case re-creates via a fresh ObjectCreate).
            // wieldedSpawn (2026-06-11): rig removed — drop the
            // live-rig ledger entry, so a later wield-from-pack
            // of this picked-up item re-synthesizes its spawn.
            js_spawned_guids.remove(&u32::from(data.guid));
            entity_updates.borrow_mut().push(EntityUpdate {
                kind: ENTITY_UPDATE_KIND_REMOVE,
                guid: u32::from(data.guid),
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
        GameMessage::UpdateMotion(data) => {
            // OpenAC comparison 2026-10-04 (remote motion D8):
            // the routed world handler applies retail's
            // CPhysics::SetObjectMovement stamp gate and
            // records an accepted stamp. A REMOTE UpdateMotion
            // whose stamp it did not record was stale or
            // reordered — don't animate it (a replayed swing,
            // a snap back to Ready mid-run).
            let remote_motion_stale = wire_state_packs_stage1_on
                && !matches!(&state, LoopState::InWorld { player_guid } if data.guid == *player_guid)
                && world.borrow().as_ref().is_some_and(|w| {
                    w.entities
                        .get(data.guid)
                        .is_some_and(|e| e.movement_sequence() != data.movement_sequence)
                });
            if !remote_motion_stale {
            // Phase 4 step 3 wire validation: ACE
            // broadcasts UpdateMotion in response to
            // our outbound MoveToState (see
            // `Player_Networking.cs::BroadcastMovement`
            // line 365 — `EnqueueBroadcast(true, ...)`
            // includes the originator). Receiving this
            // confirms ACE accepted our packet and is
            // simulating motion. The local player's
            // sprite still won't slide — retail AC
            // expects the client to predict locally —
            // but the round-trip is observable here.
            if DIAG_VERBOSE {
                console_log_str(&format!(
                    "[step3-trace] UpdateMotion guid=0x{:08X} (ACE accepted MoveToState)",
                    u32::from(data.guid),
                ));
            }
            // Animation-gate hint: derive the active
            // forward locomotion command so JS can
            // gate walk-cycle animation on a server-
            // authoritative state instead of the
            // EMA-on-position-deltas heuristic. Source
            // of truth varies by `MovementType`:
            //   - StopCompletely → STOP (definitive idle)
            //   - Invalid (the autonomous/raw envelope
            //     player movement uses): pull
            //     `state.forward_command` if the flag
            //     bit is set; else 0 (no signal).
            //   - MoveToObject / MoveToPosition → server
            //     pathing; treat as RUN_FORWARD (these
            //     carry a `run_rate` but no command code,
            //     and AI-pathed creatures default to run
            //     speed in retail).
            //   - TurnToObject / TurnToHeading → no
            //     forward locomotion; 0 lets JS keep
            //     the EMA gate's current state.
            use holtburger_protocol::messages::movement::{
                InterpretedMotionCommand, MovementType, MovementTypeData,
            };
            let motion_command_u16: u16 = match (data.movement_type, &data.data) {
                (MovementType::StopCompletely, _) => {
                    InterpretedMotionCommand::STOP.raw()
                }
                (_, MovementTypeData::Invalid(inv)) => inv
                    .state
                    .forward_command
                    .map(|c| c.raw())
                    // Wave 2 (2026-06-08, review B6) — SINGLE-ROUTE
                    // guarantee. A use-action (Eat 0x4000001A /
                    // Drink 0x4000001B) rides the `forward_command`
                    // slot on a stock ACE server, and the Wave-2
                    // action surfacing now picks it up here as a
                    // `KIND_MOTION_ACTION` one-shot. If we ALSO let
                    // it fall through to the locomotion
                    // `motion_command`, a REMOTE eater would play
                    // the eat clip TWICE (KIND_MOTION classifies
                    // 0x1A/0x1B as an INTERACTION LoopOnce overlay,
                    // and KIND_MOTION_ACTION plays it again). Drop
                    // it from the locomotion path so it plays on
                    // KIND_MOTION_ACTION ONLY. Locomotion / stance /
                    // state forward_commands are NOT actions and
                    // pass through unchanged (the gait still drives
                    // off the server echo for remotes).
                    .filter(|raw| {
                        !holtburger_world::player::expand_motion_command_low16(*raw)
                            .is_some_and(holtburger_world::player::is_action_motion_command)
                    })
                    .unwrap_or(0),
                (
                    MovementType::MoveToObject | MovementType::MoveToPosition,
                    mtd,
                ) => {
                    // C1 (2026-06-03): gate the walk/run cycle on
                    // the MoveToParameters MovementParams flags
                    // instead of hardcoding RunForward — a
                    // walk-only creature now hints Walk. See
                    // `moveto_locomotion_hint`.
                    // F6 (2026-07-27): the distance branch of
                    // retail's hold-key rule (acclient.c:346217)
                    // is evaluated too — `origin` is the
                    // destination and the mover's last-known pose
                    // reconstructs `curr_distance`.
                    let params = match mtd {
                        MovementTypeData::MoveToObject(m) => {
                            Some((&m.params, &m.origin))
                        }
                        MovementTypeData::MoveToPosition(m) => {
                            Some((&m.params, &m.origin))
                        }
                        _ => None,
                    };
                    match params {
                        Some((mp, origin)) => {
                            let curr_distance = world
                                .borrow()
                                .as_ref()
                                .and_then(|w| {
                                    w.entities.get(data.guid).map(|e| e.position)
                                })
                                .map(|mover| {
                                    mover.distance_to(
                                        &holtburger_common::position::WorldPosition {
                                            landblock_id: origin.cell_id,
                                            coords: origin.position,
                                            rotation:
                                                holtburger_common::Quaternion::identity(),
                                        },
                                    )
                                });
                            moveto_locomotion_hint(
                                mp.movement_parameters,
                                curr_distance,
                                mp.distance_to_object,
                                mp.walk_run_threshold,
                            )
                        }
                        None => InterpretedMotionCommand::RUN_FORWARD.raw(),
                    }
                }
                _ => 0,
            };
            // Render-completeness Waves-2 A1 (2026-05-29):
            // surface the per-motion playback speed
            // (`InterpretedMotionState.forward_speed`,
            // `movement/types.rs:233`) so JS can scale the
            // locomotion animation framerate (retail
            // `Framerate *= speed`). Only the interpreted
            // (`Invalid`) envelope carries a forward speed;
            // server-pathed Move/Turn variants don't, so they
            // fall through to the `1.0` identity (no scaling —
            // fail-soft, matching the field's non-MOTION
            // default). Non-positive / non-finite values are
            // clamped to `1.0` so a bad scalar can't freeze the
            // rig.
            // F15-2 (2026-06-09): preserve the SIGN. A backstep
            // is WalkForward with `forward_speed` negated upstream
            // (× -0.65); the old `*s > 0.0` filter dropped the
            // negative and fell back to 1.0, so a remote backstep
            // played the forward walk at full speed = moonwalk.
            // Keep finite NON-ZERO values (incl. negative); JS
            // clamps the magnitude for the gait/velScale getter and
            // only USES the sign (reverse clip playback) under the
            // default-off `?signedMotionSpeed` flag, so the default
            // wire→JS behavior is unchanged.
            let motion_speed_f32: f32 = match &data.data {
                MovementTypeData::Invalid(inv) => inv
                    .state
                    .forward_speed
                    .filter(|s| s.is_finite() && *s != 0.0)
                    .unwrap_or(1.0),
                _ => 1.0,
            };
            // F3-4 (bughunt 2026-06-09) — sticky target. ACE
            // STOPS broadcasting a monster's position while it
            // is sticky-attacking (`Monster_Tick` calls
            // `UpdatePosition(false)` — netsend FALSE — relying
            // on the retail client's StickyManager to keep the
            // attacker glued to the moving target). We never
            // consumed sticky, so melee mobs froze in place when
            // the player kited. Surface the sticky target guid
            // so the JS tick can pin the mob to it. Two wire
            // sources: the `Invalid` (case-0) `sticky_object`,
            // and a `MoveToObject` carrying the MovementParams
            // `sticky` bit (0x80, acclient.h bit 7 — ACE sets it
            // on every chase, Creature_Navigation.cs:307). `0`
            // (no sticky / a fresh non-sticky command) clears it
            // JS-side. Carried on `model_id` (zeroed for
            // KIND_MOTION — same per-kind field-reuse as
            // KIND_ATTACH's parent-guid).
            let sticky_target: u32 = match &data.data {
                MovementTypeData::Invalid(inv) => {
                    inv.sticky_object.map(u32::from).unwrap_or(0)
                }
                MovementTypeData::MoveToObject(m)
                    if moveto_is_sticky(m.params.movement_parameters) =>
                {
                    u32::from(m.target)
                }
                _ => 0,
            };
            // A2-P3 (2026-06-12, W3+ S9; RULINGS item 4)
            // — LOCAL-player sticky install on the
            // DEFAULT wasm path (NOT ?wireStatePacks-
            // gated), mirroring how the JS arm consumes
            // the same `model_id` field for remotes.
            // Retail `unpack_movement` sticks the
            // addressed object UNCONDITIONALLY — incl.
            // the local player (acclient.c:339546-339560
            // after the :339518-339519 unstick
            // preamble); the player's own melee-swing
            // echo carries the bit + guid (ACE
            // Player_Melee.cs:420-427; live-server
            // MovementInvalid.cs:45-46). `0` ⇒ unstick.
            // The JS local-guid exclusion at
            // loop.js:1951/:2222 STAYS — the local rig
            // is never JS-glued; its pose comes from the
            // wasm pose getters (spec S9 §3 L1 step 2).
            // COMBAT-RADII (2026-07-28): the target
            // radius is retail's `CPartArray::GetRadius`
            // (acclient.c:319755) via
            // `combat_sticky_radius`; `?combatRadii=off`
            // restores the 0.0 CPartArray-null fallback.
            if holtburger_world::spatial::USE_STICKY_MANAGER
                && let Some(w) = world.borrow_mut().as_mut()
                && w.player.guid != holtburger_common::Guid::NULL
                && data.guid == w.player.guid
            {
                if sticky_target != 0 {
                    let target =
                        holtburger_common::Guid(sticky_target);
                    let target_radius =
                        w.combat_sticky_radius(target);
                    w.scene.stick_local_player_to(
                        target,
                        target_radius,
                    );
                } else {
                    w.scene.unstick_local_player();
                }
            }
            // A2-P3 R2 (2026-06-12, W3+ S9 Stage R2;
            // ?stickyRetail=on) — REMOTE sticky install
            // from the SAME ride-along, on the S8
            // remote bodies. Retail sticks whatever
            // object the message addresses
            // (acclient.c:339546-339560); `0` ⇒ the
            // per-unpack preamble unstick subset
            // (:339518-339519). The JS F3-4 arms stay
            // untouched — ownership hands over per
            // sticky-flagged pollRemotePoses row
            // (drainRemotePoses clears the glue), so
            // every degrade case self-restores to the
            // glue path. Inert unless the full compose
            // rule holds (remote_sticky_on).
            if remote_sticky_on
                && let Some(w) = world.borrow_mut().as_mut()
                && w.player.guid != holtburger_common::Guid::NULL
                && data.guid != w.player.guid
            {
                if sticky_target != 0 {
                    // Retail sticky keeps cylinder distance
                    // between the two BODIES (radius each,
                    // remote motion D6); same radius source
                    // as the local lane's `?combatRadii`.
                    let target = holtburger_common::Guid(sticky_target);
                    let holder_radius = w.combat_part_dims(data.guid).0;
                    let target_radius = w.combat_sticky_radius(target);
                    w.scene.stick_remote_entity_to(
                        data.guid,
                        target,
                        holder_radius,
                        target_radius,
                    );
                } else {
                    w.scene.unstick_remote_entity(data.guid);
                }
            }
            // F3-5 (bughunt 2026-06-09) — per-creature run rate.
            // A MoveTo* envelope carries the mover's OWN run_rate
            // (`MoveToObject/MoveToPosition.run_rate`, ACE sets a
            // genuine per-creature rate on every chase —
            // Creature_Navigation.cs:300). Retail stores it into
            // that object's `motion_interpreter->my_run_rate` and
            // scales its gait from it (acclient.c:339571,343502).
            // We dropped it: the JS velScale path fed the LOCAL
            // player's run rate to EVERY remote rig, so a whole
            // field of mobs animated at YOUR tempo and changed
            // with YOUR buffs. Surface it on the spare `vx` field
            // (zeroed for KIND_MOTION; distinct from `motion_speed`
            // which stays the forward_speed/anim-framerate scalar)
            // so JS can stash a per-entity rate. `0` = no rate this
            // event (JS keeps the last / falls back to a neutral
            // 1.0 for non-local, NOT the local player's rate).
            let entity_run_rate: f32 = match &data.data {
                MovementTypeData::MoveToObject(m) => m.run_rate,
                MovementTypeData::MoveToPosition(m) => m.run_rate,
                _ => 0.0,
            }
            .max(0.0);
            if entity_run_rate > 0.0
                && let Some(w) = world.borrow_mut().as_mut()
            {
                w.scene.set_remote_run_rate(data.guid, entity_run_rate);
            }
            entity_updates.borrow_mut().push(EntityUpdate {
                kind: ENTITY_UPDATE_KIND_MOTION,
                guid: u32::from(data.guid),
                // F3-4: sticky target guid (0 = none/clear).
                model_id: sticky_target,
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
                obj_scale: 0.0,
                icon_id: 0,
                palette_id: 0,
                mtable_id: 0,
                model_changes: Vec::new(),
                texture_changes: Vec::new(),
                sub_palettes: Vec::new(),
                placement_id: 0,
                portal_destination: String::new(),
                // F3-5: per-creature run rate (0 = none); JS
                // stashes it for the velScale gait tempo.
                vx: entity_run_rate,
                vy: 0.0,
                vz: 0.0,
                omega_z: 0.0,
                motion_command: u32::from(motion_command_u16),
                motion_stance: u32::from(data.current_style),
                physics_script_did: 0,
                sound_table_did: 0,
                obj_desc_flags: 0,
                weenie_flags: 0,
                // A1 (2026-05-29): per-motion playback speed
                // (`forward_speed`) → JS anim framerate scale.
                motion_speed: motion_speed_f32,
                physics_translucency: 0.0,
                is_autonomous: data.is_autonomous,
            });
            // F3-3 (bughunt 2026-06-09) — TurnTo execution. Both
            // TurnToHeading and TurnToObject carry an ABSOLUTE
            // target `desired_heading` (ACE pre-computes the
            // toward-target heading), so emit a KIND_TURN with the
            // heading as an AC z-up quaternion + the turn speed.
            // The JS heading-ease then slerps the rig to face it —
            // previously this envelope was decoded then dropped and
            // NPCs never turned to face the player. The KIND_MOTION
            // above (motion_command 0 for TurnTo) still carries the
            // stance; this is an additional event.
            let turn_directive: Option<(f32, f32)> = match &data.data {
                MovementTypeData::TurnToHeading(t) => {
                    Some((t.params.desired_heading, t.params.speed))
                }
                MovementTypeData::TurnToObject(t) => {
                    Some((t.desired_heading, t.params.speed))
                }
                _ => None,
            };
            if let Some((heading, turn_speed)) = turn_directive {
                let half = heading * 0.5;
                entity_updates.borrow_mut().push(EntityUpdate {
                    kind: ENTITY_UPDATE_KIND_TURN,
                    guid: u32::from(data.guid),
                    model_id: 0,
                    landblock_id: 0,
                    x: 0.0,
                    y: 0.0,
                    z: 0.0,
                    qw: half.cos(),
                    qx: 0.0,
                    qy: 0.0,
                    qz: half.sin(),
                    wcid: 0,
                    item_type: 0,
                    name: String::new(),
                    obj_scale: 0.0,
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
                    omega_z: turn_speed,
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
            // Wave 2 (2026-06-08) — MAIN-PATH action command.
            // The `commands` list carries the one-shot
            // Action-class command (creature attack swing B10,
            // local eat/drink B6, emote/gesture) that the
            // locomotion `motion_command` emit above DROPS
            // (`forward_command` and the action list are
            // independent slots on the wire). Surface the FIRST
            // (wire-order) Action-class command — §A6; already
            // EXPANDED to its full
            // 32-bit `MotionCommand` by the shared Wave-2 expander
            // (the MotionTable link inner key is the full value,
            // C3) — as a dedicated `KIND_MOTION_ACTION`
            // EntityUpdate. This is the SINGLE playback route for
            // it (C2): the JS arm plays it as a LoopOnce overlay
            // for EVERY guid, INCLUDING the local player, WITHOUT
            // carrying a locomotion command, so the local-gait
            // skip stays intact (C1). The extraction reuses the
            // canonical `EntityMotionSnapshot` so the wasm and
            // non-wasm (cli/TUI) paths agree byte-for-byte.
            let action_snapshot =
                holtburger_world::entity::EntityMotionSnapshot::from_movement_event(
                    &data,
                );
            // §A6: the snapshot's action is the HEAD of the wire
            // list, so a multi-scarab windup starts with scarab 1.
            let main_path_action = action_snapshot
                .and_then(|s| s.action_command.map(|cmd| (cmd, s)));
            // 15-bit stamp-dedup: only emit when this action's
            // sequence is NEWER than the last one played for this
            // guid, so a re-broadcast UpdateMotion doesn't restart
            // the swing/eat clip. An action with no sequence
            // (shouldn't happen — the snapshot pairs them) emits.
            let action_is_new = match &main_path_action {
                Some((_, snap)) => match snap.action_sequence {
                    Some(seq) => MOTION_ACTION_STAMPS.with(|m| {
                        let mut m = m.borrow_mut();
                        let guid_key = u32::from(data.guid);
                        let fresh = m
                            .get(&guid_key)
                            .map(|&prev| {
                                holtburger_common::sequence::is_newer_u16(seq, prev)
                            })
                            .unwrap_or(true);
                        if fresh {
                            m.insert(guid_key, seq);
                        }
                        fresh
                    }),
                    None => true,
                },
                None => false,
            };
            if let Some((action_cmd, snap)) =
                main_path_action.filter(|_| action_is_new)
            {
                let action_speed = snap
                    .action_speed
                    .map(|s| s.to_f32())
                    .filter(|s| s.is_finite() && *s > 0.0)
                    .unwrap_or(1.0);
                entity_updates.borrow_mut().push(EntityUpdate {
                    kind: ENTITY_UPDATE_KIND_MOTION_ACTION,
                    guid: u32::from(data.guid),
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
                    obj_scale: 0.0,
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
                    // C3: full 32-bit command, no masking.
                    motion_command: action_cmd,
                    motion_stance: u32::from(data.current_style),
                    physics_script_did: 0,
                    sound_table_did: 0,
                    obj_desc_flags: 0,
                    weenie_flags: 0,
                    motion_speed: action_speed,
                    physics_translucency: 0.0,
                    is_autonomous: false,
                });
            }
            // Multi-action queue (2026-06-06, approach B):
            // surface the Action-class `commands` Vec
            // (emotes/gestures) the single `motion_command` emit
            // above DROPS, so JS can FIFO-play them with
            // stamp-dedup. Only the Invalid (autonomous) envelope
            // carries `InterpretedMotionState.commands`. The
            // `len() > 1` log is the reachability probe (does
            // vanilla ACE ever pack >=2?).
            //
            // Wave 2 (2026-06-08, C2): the main-path Action-class
            // command already plays via `KIND_MOTION_ACTION`
            // above, so SKIP it here — otherwise the
            // side-channel (when `?multiAction=on`) and the main
            // path would double-play the same swing/eat. That
            // item is identified by its 15-bit sequence.
            // Remaining items keep their WIRE order (§A6 — the
            // multi-scarab windup run), and are appended to the
            // FIFO the JS drain reads after the entity drain.
            #[cfg(target_arch = "wasm32")]
            {
                if let MovementTypeData::Invalid(inv) = &data.data {
                    let actions = &inv.state.commands;
                    if DIAG_VERBOSE && actions.len() > 1 {
                        console_log_str(&format!(
                            "[multi-action] guid=0x{:08X} commands={} (>=2 reachable)",
                            u32::from(data.guid),
                            actions.len(),
                        ));
                    }
                    let rows = motion_action_queue_rows(
                        actions,
                        main_path_action.as_ref().and_then(|(_, s)| s.action_sequence),
                        u32::from(data.guid),
                        u32::from(data.current_style),
                    );
                    if !rows.is_empty() {
                        MOTION_ACTIONS.with(|q| {
                            q.borrow_mut().extend_from_slice(&rows);
                        });
                    }
                    // Casting-ingredient axes: surface the remote
                    // sidestep + turn axes the forward_command emit
                    // above drops (strafe-cast footwork + turn-in-
                    // place cycle). 5 u32: [guid, stance,
                    // sidestep_low, turn_low, forward_idle].
                    let side_cmd = inv
                        .state
                        .sidestep_command
                        .map(|c| u32::from(c.raw()))
                        .unwrap_or(0);
                    let turn_cmd = inv
                        .state
                        .turn_command
                        .map(|c| u32::from(c.raw()))
                        .unwrap_or(0);
                    if side_cmd != 0 || turn_cmd != 0 {
                        let guid = u32::from(data.guid);
                        let stance = u32::from(data.current_style);
                        let forward_idle =
                            u32::from(inv.state.forward_command.is_none());
                        MOTION_AXES.with(|q| {
                            q.borrow_mut().extend_from_slice(&[
                                guid,
                                stance,
                                side_cmd,
                                turn_cmd,
                                forward_idle,
                            ]);
                        });
                    }
                }
            }
            }
        }
        GameMessage::VectorUpdate(data) => {
            // Remote-airborne heuristic. ACE
            // broadcasts VectorUpdate immediately after
            // a player jumps (Player.cs:954
            // `EnqueueBroadcast(new GameMessageVectorUpdate(this))`)
            // with the jump velocity, and again on the
            // physics-state change when motion settles
            // back to ~zero vertical velocity. A
            // simple |vz| threshold turns that into a
            // grounded↔airborne signal for the JS-side
            // jump pose. Skips the local player
            // (authoritative state already wired in the
            // Jump cmd / TickMovement arms).
            //
            // Threshold is conservative — walking on
            // terrain produces vz ≈ 0; even up/down a
            // slope wouldn't reach 1.0 m/s vertical.
            let remote_guid = u32::from(data.guid);
            let local_guid = world.borrow().as_ref()
                .map(|w| u32::from(w.player.guid))
                .unwrap_or(0);
            if remote_guid != local_guid && remote_guid != 0 {
                const VZ_THRESHOLD: f32 = 1.0;
                let now_airborne = data.velocity.z.abs() > VZ_THRESHOLD;
                let fire = REMOTE_AIRBORNE_STATE.with(|m| {
                    let mut s = m.borrow_mut();
                    let was = *s.get(&remote_guid).unwrap_or(&false);
                    if was != now_airborne {
                        s.insert(remote_guid, now_airborne);
                        true
                    } else {
                        false
                    }
                });
                if fire {
                    queued_events.borrow_mut().push(ClientEvent {
                        kind: CLIENT_EVENT_KIND_ENTITY_AIRBORNE_CHANGED,
                        string_payload: None,
                        u32_payload: Some(remote_guid),
                        u32_payload_2: Some(
                            if now_airborne { 1 } else { 0 },
                        ),
                        f32_payload: None,
                    });
                }
            }
            // Velocity-extrapolation polish: ACE
            // broadcasts VectorUpdate whenever an
            // entity's physics state changes
            // (start/stop walking, change direction).
            // The recv loop dropped these in the
            // catch-all arm pre-this commit; surfacing
            // them as kind=4 EntityUpdate lets JS
            // extrapolate sprite position past the
            // catch-up lerp so motion stays smooth
            // across the ~100-300 ms gap between
            // PublicUpdatePosition echoes.
            //
            // Position fields are zeroed — only
            // (guid, vx/y/z, omega_z) carry data on
            // kind=4. JS reads via the velocity
            // getters and stores `velX/Y/UpdatedMs`
            // on the entityMap entry.
            entity_updates.borrow_mut().push(EntityUpdate {
                kind: ENTITY_UPDATE_KIND_VELOCITY,
                guid: u32::from(data.guid),
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
                obj_scale: 0.0,
                icon_id: 0,
                palette_id: 0,
                mtable_id: 0,
                model_changes: Vec::new(),
                texture_changes: Vec::new(),
                sub_palettes: Vec::new(),
                placement_id: 0,
                portal_destination: String::new(),
                vx: data.velocity.x,
                vy: data.velocity.y,
                vz: data.velocity.z,
                // AC is z-up; entity rotation is
                // yaw-only (one quat axis), so the
                // x/y omega components are dropped
                // — only the z-axis angular velocity
                // matters for the top-down renderer.
                omega_z: data.omega.z,
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
        // Phase 4 step 4: chat-bearing surfaces. Each
        // variant gets normalised into a single display
        // line + a `CHAT_CATEGORY_*` ID so JS can
        // append to the chat panel without knowing
        // each AC packet's shape. Reference handlers
        // in the cli are scattered across
        // `crates/holtburger-core/src/client/messages.rs`
        // and `apps/holtburger-cli/src/pages/game/panels/
        // chat.rs`; we don't reuse them because the cli
        // formats for stdout (ratatui spans) and we
        // format for the DOM. Categories below mirror
        // the cli's `chat_message_tags()` mapping.
        GameMessage::ServerMessage(data) => {
            // System chat — ChatMessageType in the
            // payload routes the tab (Combat → combat,
            // Magic → magic, Advancement → advancement,
            // Recall / Craft / etc. likewise).
            // ChatMessageType::WorldBroadcast lands here
            // too (server-wide announcements).
            let category = chat_category_for_message_type(data.chat_type);
            queued_events.borrow_mut().push(ClientEvent {
                kind: CLIENT_EVENT_KIND_CHAT_RECEIVED,
                string_payload: Some(format!("[Server] {}", data.message)),
                u32_payload: Some(data.chat_type),
                u32_payload_2: Some(category),
                f32_payload: None,
            });
        }
        GameMessage::ServerName(data) => {
            // HUD rec #83 (2026-06-16): ACE pushes the
            // world identity + connection counts as part
            // of the post-login handshake. Stash the
            // snapshot + signal JS with kind=57 so the
            // post-login status line can render
            // "Server: <name> | Players: X/Max".
            let snapshot = ServerInfoJs {
                name: data.name.clone(),
                current_connections: data.current_connections,
                max_connections: data.max_connections,
            };
            *latest_server_info.borrow_mut() = Some(snapshot);
            queued_events.borrow_mut().push(ClientEvent {
                kind: CLIENT_EVENT_KIND_SERVER_INFO,
                string_payload: Some(data.name.clone()),
                u32_payload: Some(data.current_connections),
                u32_payload_2: Some(data.max_connections as u32),
                f32_payload: None,
            });
        }
        GameMessage::DddInterrogation(data) => {
            // HUD rec #68 (2026-06-16): ACE sends the server's
            // language context (name_rule_language +
            // servers_region + supported_languages) during the
            // DDD handshake, before CharacterList. Stash it +
            // signal JS with kind=59 so window.__acLocalization
            // is seeded before string-table preloads run.
            //
            // NOTE: we deliberately do NOT send
            // DddInterrogationResponse here. The web login
            // handshake already completes without it (ACE does
            // not block on the DDD response in this flow — this
            // arm was previously the `_ => {}` fallthrough and
            // login worked); the native core Client models the
            // echo at holtburger-core messages.rs. Adding an
            // unvalidated wire send to the working login
            // handshake is out of scope per [Keep ACE vanilla]
            // + can't-validate-without-1070.
            let snapshot = LocalizationJs {
                lang_id: data.name_rule_language,
                servers_region: data.servers_region,
                product_id: data.product_id,
                supported_languages: data.supported_languages.clone(),
            };
            *latest_localization.borrow_mut() = Some(snapshot);
            queued_events.borrow_mut().push(ClientEvent {
                kind: CLIENT_EVENT_KIND_LOCALIZATION,
                string_payload: None,
                u32_payload: Some(data.name_rule_language),
                u32_payload_2: Some(data.servers_region),
                f32_payload: None,
            });
        }
        GameMessage::HearSpeech(data) => {
            // Local say within speech-radius. chat_type
            // is usually `Speech` but ACE also uses this
            // packet for spell-casting words (chat_type
            // = Spellcasting), so the category lookup
            // routes spell incantations to the magic
            // tab instead of local.
            let category = chat_category_for_message_type(data.chat_type);
            queued_events.borrow_mut().push(ClientEvent {
                kind: CLIENT_EVENT_KIND_CHAT_RECEIVED,
                string_payload: Some(format!(
                    "{} says, \"{}\"",
                    data.sender_name, data.message
                )),
                u32_payload: Some(data.chat_type),
                u32_payload_2: Some(category),
                f32_payload: None,
            });
            // F17-5 (2026-06-09): overhead bubble companion.
            // The chat line above goes to the DOM panel; this
            // surfaces the speaker guid + raw words so JS can
            // float a fading bubble over the 3D speaker.
            // Additive — inert unless `?speechBubbles=on`.
            queued_events.borrow_mut().push(ClientEvent {
                kind: CLIENT_EVENT_KIND_OVERHEAD_SPEECH,
                string_payload: Some(data.message.clone()),
                u32_payload: Some(data.sender),
                u32_payload_2: Some(category),
                f32_payload: None,
            });
        }
        GameMessage::HearRangedSpeech(data) => {
            // Greater-range speech variant (e.g. heralds,
            // World Crier). Same chat_type taxonomy as
            // HearSpeech.
            let category = chat_category_for_message_type(data.chat_type);
            queued_events.borrow_mut().push(ClientEvent {
                kind: CLIENT_EVENT_KIND_CHAT_RECEIVED,
                string_payload: Some(format!(
                    "{} says, \"{}\"",
                    data.sender_name, data.message
                )),
                u32_payload: Some(data.chat_type),
                u32_payload_2: Some(category),
                f32_payload: None,
            });
            // F17-5 (2026-06-09): overhead bubble companion (see
            // HearSpeech arm).
            queued_events.borrow_mut().push(ClientEvent {
                kind: CLIENT_EVENT_KIND_OVERHEAD_SPEECH,
                string_payload: Some(data.message.clone()),
                u32_payload: Some(data.sender),
                u32_payload_2: Some(category),
                f32_payload: None,
            });
        }
        GameMessage::EmoteText(data) => {
            // EmoteText.text is already self-contained —
            // ACE pre-renders it as e.g. "Alice waves at
            // you." — so don't re-prepend the sender
            // name. Mirror the cli's display path.
            queued_events.borrow_mut().push(ClientEvent {
                kind: CLIENT_EVENT_KIND_CHAT_RECEIVED,
                string_payload: Some(data.text.clone()),
                u32_payload: Some(0),
                u32_payload_2: Some(CHAT_CATEGORY_EMOTE),
                f32_payload: None,
            });
            // F17-5 (2026-06-09): overhead bubble companion. The
            // pre-rendered emote text floats over the actor (its
            // `sender` guid). Additive — inert unless
            // `?speechBubbles=on`.
            queued_events.borrow_mut().push(ClientEvent {
                kind: CLIENT_EVENT_KIND_OVERHEAD_SPEECH,
                string_payload: Some(data.text.clone()),
                u32_payload: Some(data.sender),
                u32_payload_2: Some(CHAT_CATEGORY_EMOTE),
                f32_payload: None,
            });
        }
        GameMessage::SoulEmote(data) => {
            // SoulEmote.text is identical in shape to
            // EmoteText.text — pre-rendered. Same
            // formatting rule.
            queued_events.borrow_mut().push(ClientEvent {
                kind: CLIENT_EVENT_KIND_CHAT_RECEIVED,
                string_payload: Some(data.text.clone()),
                u32_payload: Some(0),
                u32_payload_2: Some(CHAT_CATEGORY_EMOTE),
                f32_payload: None,
            });
            // F17-5 (2026-06-09): overhead bubble companion (see
            // EmoteText arm).
            queued_events.borrow_mut().push(ClientEvent {
                kind: CLIENT_EVENT_KIND_OVERHEAD_SPEECH,
                string_payload: Some(data.text.clone()),
                u32_payload: Some(data.sender),
                u32_payload_2: Some(CHAT_CATEGORY_EMOTE),
                f32_payload: None,
            });
        }
        GameMessage::PlayerKilled(data) => {
            // Death broadcast — the formatted message
            // already reads "Player has been slain by
            // Monster!" or "Player killed by Player."
            // (PK kill). victim_id / killer_id are
            // GUIDs the wasm bundle could colour by
            // friendliness in a future step; today we
            // just surface the line.
            queued_events.borrow_mut().push(ClientEvent {
                kind: CLIENT_EVENT_KIND_CHAT_RECEIVED,
                string_payload: Some(data.death_message.clone()),
                u32_payload: Some(u32::from(data.killer_id)),
                u32_payload_2: Some(CHAT_CATEGORY_DEATH),
                f32_payload: None,
            });
            // Q1a (2026-05-26): structured Death event.
            // Chorizite Character.OnDeath analogue —
            // JS-side filters by victim==local for the
            // "You died." overlay; lets plugins
            // subscribe without polling chat text.
            queued_events.borrow_mut().push(ClientEvent {
                kind: CLIENT_EVENT_KIND_DEATH,
                string_payload: Some(data.death_message.clone()),
                u32_payload: Some(u32::from(data.victim_id)),
                u32_payload_2: Some(u32::from(data.killer_id)),
                f32_payload: None,
            });
        }
        GameMessage::TurbineChat(data) => {
            // Modern (post-Turbine) channel chat —
            // General / Trade / LFG / Roleplay /
            // Allegiance / Society / Olthoi. ACE wraps
            // the receive side in a SendToRoomByName
            // event blob; the request-side payload is
            // for outbound (which we don't speak yet).
            // Response blobs are RPC echoes — silent.
            use holtburger_protocol::messages::chat::turbine::TurbineChatPayload;
            match &data.payload {
                TurbineChatPayload::EventSendToRoom {
                    sender_name,
                    message,
                    chat_type,
                    ..
                } => {
                    let chat_type_raw = chat_type.raw();
                    let label = turbine_chat_type_label(chat_type_raw);
                    let category =
                        chat_category_for_turbine_chat_type(chat_type_raw);
                    queued_events.borrow_mut().push(ClientEvent {
                        kind: CLIENT_EVENT_KIND_CHAT_RECEIVED,
                        string_payload: Some(format!(
                            "[{label}] {sender_name} says, \"{message}\""
                        )),
                        u32_payload: Some(chat_type_raw),
                        u32_payload_2: Some(category),
                        f32_payload: None,
                    });
                }
                TurbineChatPayload::RequestSendToRoomById { .. }
                | TurbineChatPayload::Response { .. }
                | TurbineChatPayload::Unknown(_) => {
                    // RPC echo / outbound — nothing to
                    // render.
                }
            }
        }
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
                        queued_events.borrow_mut().push(ClientEvent {
                            kind: CLIENT_EVENT_KIND_CHAT_RECEIVED,
                            string_payload: Some(label),
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
                    let label = format!("{:?}({})", data.error, data.parameter);
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
        GameMessage::PlaySound(data) => {
            // Task F (ambient-sounds-chain, 2026-05-12):
            // ACE broadcast `GameMessageSound` (opcode
            // 0xF750) — server-triggered audio for
            // lifestone bind, switch activation, hotspot
            // trigger, craft event, etc. Wire layout:
            // `[u32 guid, u32 sound_id, f32 volume]`
            // (16 bytes total incl. the 4-byte opcode).
            //
            // The parser is `PlaySoundData` in
            // `crates/holtburger-protocol/src/messages/
            // effects/types.rs` — pre-existing from the
            // protocol-crate buildout; the `target` /
            // `sound_id` / `volume` field names track
            // ACE's GameMessageSound constructor 1:1.
            //
            // Forward to JS as a kind=16 SoundTriggered
            // ClientEvent. JS-side (`index.html`'s
            // `drainEvents` block) looks up the entity
            // in `liveScene3d.entityManager.entityMap`,
            // reads `inst.soundTableDid` (Task E
            // plumbing), resolves the Sound enum via
            // `soundTableCache.resolveSound(...)`, and
            // plays the resulting Wave at the entity's
            // current world position via
            // `audioManager.play(...)` scaled by
            // `entry.volume * scale`.
            //
            // Soft cases handled JS-side (each logs
            // debug + skips, never errors):
            //   - entity GUID unknown (despawned mid-
            //     flight between ACE send and client
            //     recv)
            //   - entity has no SoundTable
            //     (`inst.soundTableDid == 0`)
            //   - Sound enum has no entry in the
            //     resolved SoundTable
            //   - `scale <= 0` (treated as 1.0 with a
            //     one-shot warn)
            queued_events.borrow_mut().push(ClientEvent {
                kind: CLIENT_EVENT_KIND_SOUND_TRIGGERED,
                string_payload: None,
                u32_payload: Some(u32::from(data.target)),
                u32_payload_2: Some(data.sound_id),
                f32_payload: Some(data.volume),
            });
        }
        GameMessage::EnvironChange(data) => {
            // AdminEnvirons (0xEA60) — server-pushed fog/sound
            // environment change. Forward the raw
            // EnvironChangeType to JS as a kind=60 ClientEvent;
            // the drainEvents handler applies the fog tint
            // override (0x00-0x06) or plays the environ sound
            // (0x65-0x7B). Retail: acclient.c:396298.
            queued_events.borrow_mut().push(ClientEvent {
                kind: CLIENT_EVENT_KIND_ENVIRON_CHANGE,
                string_payload: None,
                u32_payload: Some(data.change_type),
                u32_payload_2: None,
                f32_payload: None,
            });
        }
        GameMessage::CharacterError(data) => {
            // 2026-05-21 — surface to JS so the autoLogin
            // orchestrator can detect "account in use"
            // (CharacterError::Logon) or "character
            // in-world" (EnterGameCharacterInWorld) and
            // trigger the kick-then-reconnect retry
            // path. See CLIENT_EVENT_KIND_CHARACTER_ERROR
            // doc comment for the wire-side context.
            let raw = data.error_id;
            let name = holtburger_protocol::errors::CharacterError::from_repr(raw)
                .map(|e| format!("{:?}", e))
                .unwrap_or_else(|| format!("Unknown({:#x})", raw));
            log::warn!("[character-error] code={:#x} name={}", raw, name);
            queued_events.borrow_mut().push(ClientEvent {
                kind: CLIENT_EVENT_KIND_CHARACTER_ERROR,
                string_payload: Some(name),
                u32_payload: Some(raw),
                u32_payload_2: None,
                f32_payload: None,
            });
        }
        _ => {
            // Other GameMessages are dropped silently —
            // VectorUpdate (step 2b extension — not
            // strictly needed for position rendering),
            // vitals / equipment / inventory panels
            // (step 4 follow-on for non-chat surfaces),
            // interactive entities (step 5) all live
            // downstream. The recv loop's job here is
            // to stay alive + deliver the InWorld
            // signal + relay position-bearing messages
            // + relay chat.
        }
    }
    LoopFlow::Continue
}
