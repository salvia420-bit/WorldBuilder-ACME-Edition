//! `GameMessage` arms: Object lifecycle: ObjectCreate, UpdateObject,
//! ObjDescEvent, ParentEvent, ObjectDelete, PickupEvent.
//!
//! Moved verbatim from the inbound `match message` (2026-10-05 recv_loop
//! split); see `session::messages::dispatch_game_message` for the routing.

use crate::*;
use crate::session::{LoopCtx, LoopFlags, LoopFlow};
use holtburger_protocol::messages::{GameAction, GameMessage};

pub(super) async fn handle(ctx: &mut LoopCtx, message: GameMessage) -> LoopFlow {
    let LoopFlags {
        spawn_motion_state_on,
        spawn_door_collision_on,
        skip_contained_spawn_on,
        spawn_hidden_state_on,
        wielded_spawn_on,
        ..
    } = ctx.flags;
    let LoopCtx {
        session,
        queued_events,
        entity_updates,
        physics_script_table_index,
        door_part_snapshot,
        world,
        movement,
        entity_seeded,
        heartbeat_armed,
        local_player_spawn_emitted,
        js_spawned_guids,
        ..
    } = &mut *ctx;
    match message {
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
            // Spawn pose = none (landblock 0, bug 14 — see below);
            // the attach places it, and the JS-side pending-attach
            // hide keeps it from flashing at the origin.
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
                    // Bug 14 (2026-10-07): POSELESS, like ACE's own
                    // parented CreateObject (no Position — the wasm
                    // surfaces landblock 0 / origin). The old wielder
                    // pose sent the JS spawn through the distance-LOD
                    // lookup on the low-priority fetch lane, behind
                    // world streaming — the 3-4 s before a freshly
                    // wielded weapon/shield showed. Poseless spawns skip
                    // that lookup and take the urgent lanes; the rig is
                    // hidden until its attach mounts it, and the stale
                    // reaper spares landblock 0.
                    let (lb, x, y, z, qw, qx, qy, qz) =
                        (0u32, 0.0f32, 0.0f32, 0.0f32, 1.0f32, 0.0f32, 0.0f32, 0.0f32);
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
        _ => unreachable!("GameMessage routed to the wrong handler module"),
    }
    LoopFlow::Continue
}
