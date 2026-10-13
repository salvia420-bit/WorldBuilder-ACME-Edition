use std::collections::{HashMap, HashSet};

use holtburger_common::Guid;
use holtburger_common::properties::WorldObjectExt as _;

use crate::WorldEvent;
use crate::context::WorldContextExt;
use crate::entity::Entity;
use crate::state::WorldState;

const ACE_DESTRUCTION_TIMEOUT_SECS: f64 = 25.0;
const CONSERVATIVE_VISIBILITY_DISTANCE_M: f32 = 384.0;
/// streaming-residency-1 (2026-10-13): the prune deadline under
/// `?aceObjMaint=on` — ACE's 25 s `ObjectMaint.DestructionTime` plus the same
/// margin as entities.js `REAP_GRACE_MS` (30 s). ACE expires its queue in
/// `DestroyObjects`, which runs on the player's cell change and on the ~5 s
/// player `Heartbeat` (Player_Tick.cs), so it forgets an object 25-30 s after
/// the leave. The ACE-parity set is narrow, so the client must land on the
/// late side: a late prune is harmless (once ACE has forgotten the object it
/// re-sends ObjectCreate on re-entry), an early one is not (ACE still knows it
/// and never re-creates it).
const ACE_OBJECT_MAINT_DESTRUCTION_TIMEOUT_SECS: f64 = 30.0;

/// Same range as `spatial::scene::is_envcell_id` (private to `spatial`):
/// EnvCell stabs are `0x0100..=0xFFFD`; outdoor land cells are `1..=64`, and
/// `0xFFFE`/`0xFFFF` are landblock markers, not cells.
#[inline]
fn is_envcell_id(cell_id: u32) -> bool {
    (0x100..=0xFFFD).contains(&(cell_id & 0xFFFF))
}

/// streaming-residency-1 (2026-10-13): the player half of ACE's visible set
/// (`ObjectMaint.GetVisibleObjects`, ACE.Server Physics/Common/ObjectMaint.cs),
/// resolved once per maint pass by [`WorldState::ace_object_maint_view`].
struct AceObjectMaintView {
    /// The player's full ObjCellID.
    player_cell: u32,
    /// The player's landblock grid coordinates (ObjCellID bytes 3 and 2).
    landblock_x: i32,
    landblock_y: i32,
    /// Player in an EnvCell: that cell plus its visibility neighbours
    /// (`SpatialScene::cell_visibility_neighbours` = portals ∪ the DAT
    /// `visible_cells[]`, a superset of ACE's `EnvCell.VisibleCells`).
    /// `None` = the player is outdoors.
    env_cells: Option<HashSet<u32>>,
    /// The player's EnvCell is SeenOutside (always `false` outdoors).
    seen_outside: bool,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct EntityLifecycleState {
    pub explicit_delete_requested: bool,
    pub prune_deadline: Option<f64>,
    pub trade_preview: bool,
    pub container_preview: bool,
}

impl EntityLifecycleState {
    fn is_empty(&self) -> bool {
        !self.explicit_delete_requested
            && self.prune_deadline.is_none()
            && !self.trade_preview
            && !self.container_preview
    }
}

#[derive(Debug, Default)]
pub(crate) struct EntityLifecycleStore {
    by_guid: HashMap<Guid, EntityLifecycleState>,
    /// streaming-residency-1 (2026-10-13) — runtime carrier of
    /// `?aceObjMaint=on` (OPT-IN, default OFF). ON: the visibility prune arms
    /// its deadline from the ACE-parity visible set
    /// (`WorldState::is_ace_visible_world_entity`) with a 30 s deadline
    /// instead of the conservative 3x3-or-384 m set. Set once at world
    /// creation by the wasm bundle; native keeps the default. Kept on the
    /// lifecycle store (the CObjectMaint-style owner); it is not per-guid
    /// state, so `tracked_guids` / `compact` never see it.
    ace_object_maint: bool,
}

impl EntityLifecycleStore {
    pub fn get(&self, guid: Guid) -> Option<&EntityLifecycleState> {
        self.by_guid.get(&guid)
    }

    pub fn get_or_default_mut(&mut self, guid: Guid) -> &mut EntityLifecycleState {
        self.by_guid.entry(guid).or_default()
    }

    pub fn clear(&mut self, guid: Guid) {
        self.by_guid.remove(&guid);
    }

    pub fn compact(&mut self, guid: Guid) {
        if self
            .by_guid
            .get(&guid)
            .is_some_and(EntityLifecycleState::is_empty)
        {
            self.by_guid.remove(&guid);
        }
    }

    pub fn tracked_guids(&self) -> impl Iterator<Item = Guid> + '_ {
        self.by_guid.keys().copied()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum EntityUpsertKind {
    Inserted,
    Replaced,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub(crate) struct EntityRetentionSnapshot {
    pub in_world: bool,
    pub held_by_player: bool,
    pub equipped_by_player: bool,
    pub inside_open_container: bool,
    pub has_container_owner: bool,
    pub has_wielder_owner: bool,
    pub has_parent_owner: bool,
    pub trade_preview: bool,
    pub container_preview: bool,
    pub explicit_delete_requested: bool,
    pub prune_deadline_expired: bool,
}

impl EntityRetentionSnapshot {
    pub fn has_preview_retention(self) -> bool {
        self.trade_preview || (self.container_preview && self.inside_open_container)
    }

    pub fn has_nonworld_retention(self) -> bool {
        self.held_by_player
            || self.equipped_by_player
            || self.inside_open_container
            || self.has_container_owner
            || self.has_wielder_owner
            || self.has_parent_owner
            || self.has_preview_retention()
    }

    pub fn has_authoritative_retention(self) -> bool {
        self.in_world
            || self.held_by_player
            || self.equipped_by_player
            || self.inside_open_container
            || self.has_container_owner
            || self.has_wielder_owner
            || self.has_parent_owner
    }

    pub fn is_retained(self) -> bool {
        self.has_authoritative_retention() || self.has_preview_retention()
    }
}

impl WorldState {
    fn current_visible_world_guids(&self) -> HashSet<Guid> {
        if self.player.guid == Guid::NULL {
            return HashSet::new();
        }

        let Some(player_landblock) = self.player_landblock() else {
            return HashSet::new();
        };

        // streaming-residency-1 (2026-10-13): `?aceObjMaint=on` with the
        // player's cell data loaded → the ACE-parity set. Flag off (the
        // default), or an EnvCell whose record has not arrived yet → the
        // conservative set below, unchanged.
        if let Some(view) = self.ace_object_maint_view() {
            return self
                .entities
                .iter()
                .filter(|entity| entity.guid != self.player.guid)
                .filter(|entity| entity.position.landblock_id != Guid::NULL)
                .filter(|entity| self.is_entity_world_participant(entity.guid))
                .filter(|entity| self.is_ace_visible_world_entity(entity, &view))
                .map(|entity| entity.guid)
                .collect();
        }

        let nearby_guids = self.scene.get_nearby_entities(player_landblock);

        self.entities
            .iter()
            .filter(|entity| entity.guid != self.player.guid)
            .filter(|entity| entity.position.landblock_id != Guid::NULL)
            .filter(|entity| self.is_entity_world_participant(entity.guid))
            .filter(|entity| self.is_conservatively_visible_world_entity(entity, &nearby_guids))
            .map(|entity| entity.guid)
            .collect()
    }

    /// streaming-residency-1 (2026-10-13): install `?aceObjMaint=on`
    /// (see `EntityLifecycleStore::ace_object_maint`). The wasm bundle calls
    /// this once at world creation; native keeps the default (OFF).
    pub fn set_ace_object_maint_enabled(&mut self, enabled: bool) {
        self.entity_lifecycle.ace_object_maint = enabled;
    }

    pub fn ace_object_maint_enabled(&self) -> bool {
        self.entity_lifecycle.ace_object_maint
    }

    /// streaming-residency-1 (2026-10-13): resolve the player side of ACE's
    /// `ObjectMaint.GetVisibleObjects(cell)` from the player's full ObjCellID
    /// (the server-authoritative `player_position()`, which is also the cell
    /// ACE decides from). `None` = use the conservative predicate: the flag
    /// is off, there is no player pose, or the player stands in an EnvCell
    /// whose record (SeenOutside bit + visible edges, queued together by
    /// `fetchEnvCellsInLandblock`) has not been loaded — the native CLI never
    /// loads one.
    fn ace_object_maint_view(&self) -> Option<AceObjectMaintView> {
        if !self.entity_lifecycle.ace_object_maint {
            return None;
        }
        let cell = self.player_landblock()?.0;
        let landblock_x = ((cell >> 24) & 0xFF) as i32;
        let landblock_y = ((cell >> 16) & 0xFF) as i32;
        if !is_envcell_id(cell) {
            return Some(AceObjectMaintView {
                player_cell: cell,
                landblock_x,
                landblock_y,
                env_cells: None,
                seen_outside: false,
            });
        }
        let seen_outside = self.scene.cell_seen_outside_opt(cell)?;
        let mut env_cells: HashSet<u32> = self
            .scene
            .cell_visibility_neighbours(cell)
            .iter()
            .copied()
            .collect();
        env_cells.insert(cell);
        Some(AceObjectMaintView {
            player_cell: cell,
            landblock_x,
            landblock_y,
            env_cells: Some(env_cells),
            seen_outside,
        })
    }

    /// streaming-residency-1 (2026-10-13): ACE-parity visibility of one world
    /// entity. ACE judges it with two rules and keeps whichever ran last: the
    /// set rebuilt on the PLAYER's cell change (`ObjectMaint.GetVisibleObjects`
    /// in `handle_visible_cells`) and the pair test run on the OBJECT's cell
    /// change (`ObjCell.IsVisible` / `EnvCell.IsVisibleIndoors` in
    /// `handle_visible_obj`). Neither re-runs while both stand still, so this
    /// takes their UNION — pruning earlier than ACE forgets would lose the
    /// object for good (no re-create while ACE still knows it):
    /// - player in an EnvCell: the entity is in that cell or one of its
    ///   VisibleCells; or the player's cell is SeenOutside and the entity's
    ///   landblock is within 1 (IsVisibleIndoors does not filter the
    ///   entity's cell, so a cellar seen from a building interior stays);
    /// - player outdoors: the entity's landblock is within 1
    ///   (`CurLandblock.GetServerObjects(true)`) AND the entity is outdoors or
    ///   in a SeenOutside EnvCell (an unloaded bit counts as visible), or it
    ///   is in an EnvCell of the same landblock whose VisibleCells hold the
    ///   player's cell.
    ///
    /// No 384 m term. ACE culls an object 25 s after it leaves this set and
    /// then sends nothing about it — no UpdatePosition, no DeleteObject — just
    /// as retail drops an object whose cell it releases
    /// (`CObjectMaint::AddObjectToBeDestroyed` +25 s, acclient.c:310651;
    /// `CLandBlock::notify_change_size` → `release_objs`, acclient.c:352430).
    /// A dungeon landblock has no adjacents in ACE, but a sealed-cell player
    /// never takes the adjacency clause, so no IsDungeon test is needed.
    fn is_ace_visible_world_entity(&self, entity: &Entity, view: &AceObjectMaintView) -> bool {
        let cell = entity.position.landblock_id.0;
        let dx = ((cell >> 24) & 0xFF) as i32 - view.landblock_x;
        let dy = ((cell >> 16) & 0xFF) as i32 - view.landblock_y;
        let block_dist = dx.abs().max(dy.abs());
        match &view.env_cells {
            Some(cells) => cells.contains(&cell) || (view.seen_outside && block_dist <= 1),
            None => {
                if block_dist > 1 {
                    return false;
                }
                if !is_envcell_id(cell) {
                    return true;
                }
                self.scene.cell_seen_outside_opt(cell) != Some(false)
                    || (block_dist == 0
                        && self
                            .scene
                            .cell_visibility_neighbours(cell)
                            .contains(&view.player_cell))
            }
        }
    }

    // TODO: Replace this conservative approximation with ACE-parity cell visibility.
    // ACE decides visibility from the current ObjCell, not just from landblock adjacency.
    // Proper parity here requires consulting cell.dat envcell records so we can:
    // 1. detect whether the player's current cell is an EnvCell,
    // 2. read SeenOutside for that cell,
    // 3. union the current envcell with its VisibleCells,
    // 4. merge outdoor landblock-neighborhood visibility only for SeenOutside envcells.
    // Until we wire that up, prefer retaining too much over pruning too aggressively.
    // streaming-residency-1 (2026-10-13): that predicate now exists behind
    // `?aceObjMaint=on` (`is_ace_visible_world_entity`). This one stays the
    // default, and the fallback while the player's EnvCell is unloaded,
    // until a live walk-away + dungeon room-to-room soak clears the flip.
    fn is_conservatively_visible_world_entity(
        &self,
        entity: &Entity,
        nearby_guids: &HashSet<Guid>,
    ) -> bool {
        nearby_guids.contains(&entity.guid)
            || self.player_position().is_some_and(|position| {
                position.distance_to(&entity.position) <= CONSERVATIVE_VISIBILITY_DISTANCE_M
            })
    }

    fn maintain_visibility_prune_deadlines(&mut self, now: f64) {
        // Bug 10 (2026-10-07): without a player landblock the visible set
        // below is EMPTY, so every world entity got a 25 s prune deadline and
        // was swept out of the store while its 3D rig stayed selectable — and
        // every later UpdateHealth / property read for it found nothing. The
        // TODO above says prefer retaining too much: with no player pose we
        // cannot judge visibility at all, so leave the deadlines alone (ACE's
        // ObjectDelete still removes objects explicitly).
        if self.player_landblock().is_none() {
            return;
        }
        let visible_guids = self.current_visible_world_guids();
        // streaming-residency-1: 30 s under `?aceObjMaint=on` (see
        // `ACE_OBJECT_MAINT_DESTRUCTION_TIMEOUT_SECS`); 25 s by default.
        let destruction_timeout = if self.entity_lifecycle.ace_object_maint {
            ACE_OBJECT_MAINT_DESTRUCTION_TIMEOUT_SECS
        } else {
            ACE_DESTRUCTION_TIMEOUT_SECS
        };
        let world_entity_guids: Vec<_> = self
            .entities
            .iter()
            .filter(|entity| entity.guid != self.player.guid)
            .filter(|entity| entity.position.landblock_id != Guid::NULL)
            .map(|entity| entity.guid)
            .collect();

        for guid in world_entity_guids {
            if visible_guids.contains(&guid) {
                self.clear_entity_prune_deadline(guid);
                continue;
            }

            let Some(snapshot) = self.retention_snapshot(guid, now) else {
                continue;
            };

            if snapshot.explicit_delete_requested || snapshot.has_nonworld_retention() {
                self.clear_entity_prune_deadline(guid);
                continue;
            }

            if self
                .entity_lifecycle_state(guid)
                .and_then(|state| state.prune_deadline)
                .is_none()
            {
                self.set_entity_prune_deadline(guid, now + destruction_timeout);
            }
        }
    }

    pub(crate) fn trade_contains_item(&self, guid: Guid) -> bool {
        self.trade.as_ref().is_some_and(|trade| {
            trade.self_side.items.contains(&guid) || trade.partner_side.items.contains(&guid)
        })
    }

    pub(crate) fn entity_lifecycle_state(&self, guid: Guid) -> Option<&EntityLifecycleState> {
        self.entity_lifecycle.get(guid)
    }

    pub(crate) fn mark_entity_explicit_delete(&mut self, guid: Guid) {
        self.entity_lifecycle
            .get_or_default_mut(guid)
            .explicit_delete_requested = true;
    }

    pub(crate) fn clear_entity_explicit_delete(&mut self, guid: Guid) {
        if let Some(state) = self.entity_lifecycle.by_guid.get_mut(&guid) {
            state.explicit_delete_requested = false;
        }
        self.entity_lifecycle.compact(guid);
    }

    pub(crate) fn set_entity_prune_deadline(&mut self, guid: Guid, deadline: f64) {
        self.entity_lifecycle
            .get_or_default_mut(guid)
            .prune_deadline = Some(deadline);
    }

    pub(crate) fn clear_entity_prune_deadline(&mut self, guid: Guid) {
        if let Some(state) = self.entity_lifecycle.by_guid.get_mut(&guid) {
            state.prune_deadline = None;
        }
        self.entity_lifecycle.compact(guid);
    }

    pub(crate) fn mark_trade_preview(&mut self, guid: Guid) {
        self.entity_lifecycle.get_or_default_mut(guid).trade_preview = true;
    }

    pub(crate) fn clear_trade_preview(&mut self, guid: Guid) {
        if let Some(state) = self.entity_lifecycle.by_guid.get_mut(&guid) {
            state.trade_preview = false;
        }
        self.entity_lifecycle.compact(guid);
    }

    pub(crate) fn mark_container_preview(&mut self, guid: Guid) {
        self.entity_lifecycle
            .get_or_default_mut(guid)
            .container_preview = true;
    }

    pub(crate) fn clear_container_preview(&mut self, guid: Guid) {
        if let Some(state) = self.entity_lifecycle.by_guid.get_mut(&guid) {
            state.container_preview = false;
        }
        self.entity_lifecycle.compact(guid);
    }

    pub(crate) fn retention_snapshot(
        &self,
        guid: Guid,
        now: f64,
    ) -> Option<EntityRetentionSnapshot> {
        let entity = self.entities.get(guid)?;
        let container_id = entity.container_id();
        let open_container =
            container_id.is_some_and(|container| self.open_containers.contains(&container));
        let lifecycle = self.entity_lifecycle.get(guid);
        let container_preview = lifecycle.is_some_and(|state| state.container_preview);

        Some(EntityRetentionSnapshot {
            in_world: entity.position.landblock_id != Guid::NULL,
            held_by_player: self.is_in_player_inventory(guid),
            equipped_by_player: self.is_equipped_item(guid),
            inside_open_container: open_container,
            has_container_owner: container_id.is_some() && (!container_preview || open_container),
            has_wielder_owner: entity
                .wielder_id()
                .is_some_and(|wielder| self.entities.get(wielder).is_some()),
            has_parent_owner: entity.physics_parent_id.is_some(),
            trade_preview: lifecycle.is_some_and(|state| state.trade_preview),
            container_preview,
            explicit_delete_requested: lifecycle
                .is_some_and(|state| state.explicit_delete_requested),
            prune_deadline_expired: lifecycle
                .and_then(|state| state.prune_deadline)
                .is_some_and(|deadline| deadline <= now),
        })
    }

    pub(crate) fn reconcile_entity_retention(
        &mut self,
        guid: Guid,
    ) -> Option<EntityRetentionSnapshot> {
        let snapshot = self.retention_snapshot(guid, self.current_server_time())?;
        if snapshot.is_retained() {
            self.clear_entity_prune_deadline(guid);
        }
        Some(snapshot)
    }

    pub(crate) fn should_evict_entity(&self, guid: Guid, now: f64) -> bool {
        let Some(snapshot) = self.retention_snapshot(guid, now) else {
            return false;
        };

        if snapshot.explicit_delete_requested {
            return true;
        }

        if snapshot.has_nonworld_retention() {
            return false;
        }

        snapshot.prune_deadline_expired
    }

    pub(crate) fn sweep_entity(
        &mut self,
        guid: Guid,
        now: f64,
        events: &mut Vec<WorldEvent>,
    ) -> bool {
        if !self.should_evict_entity(guid, now) {
            return false;
        }

        if self.remove_entity(guid).is_some() {
            if let Some(body_id) = self.runtime_body_id_for_guid(guid) {
                events.push(WorldEvent::RuntimeBodyRemoved { body_id });
            }
            events.push(WorldEvent::EntityDespawned(guid));
            true
        } else {
            self.entity_lifecycle.clear(guid);
            false
        }
    }

    pub(crate) fn sweep_eviction_queue(&mut self, now: f64, events: &mut Vec<WorldEvent>) {
        let candidates: Vec<_> = self.entity_lifecycle.tracked_guids().collect();
        for guid in candidates {
            let _ = self.sweep_entity(guid, now, events);
        }
    }

    pub fn is_entity_client_visible(&self, guid: Guid) -> bool {
        self.entities.get(guid).is_some()
            && !self
                .entity_lifecycle
                .get(guid)
                .is_some_and(|state| state.explicit_delete_requested)
    }

    pub fn is_entity_world_participant(&self, guid: Guid) -> bool {
        self.get_visible_entity(guid)
            .is_some_and(|entity| entity.position.landblock_id != Guid::NULL)
    }

    pub fn get_visible_entity(&self, guid: Guid) -> Option<&Entity> {
        self.entities
            .get_filtered(guid, |entity| self.is_entity_client_visible(entity.guid))
    }

    pub fn iter_visible_entities(&self) -> impl Iterator<Item = &Entity> + '_ {
        self.entities
            .iter_filtered(move |entity| self.is_entity_client_visible(entity.guid))
    }

    pub fn get_nearby_world_entities(&self) -> Vec<Entity> {
        if self.player.guid == Guid::NULL {
            return Vec::new();
        }

        let Some(lb) = self.player_landblock() else {
            return Vec::new();
        };

        let nearby_guids = self.scene.get_nearby_entities(lb);
        nearby_guids
            .into_iter()
            .filter(|guid| self.is_entity_world_participant(*guid))
            .filter_map(|guid| self.entities.get(guid).cloned())
            .collect()
    }

    pub fn tick(&mut self) -> Vec<WorldEvent> {
        let mut events = Vec::new();
        let now = self.current_server_time();
        // ORACLE open defect #1 (2026-08-12): the eviction sweep is NOT a
        // message handler, so a wipe here is invisible to the probe in
        // `handle_message`. It is also the only place the player entity is
        // actually REMOVED — `ObjectDelete` merely calls
        // `mark_entity_explicit_delete` (handlers/inventory.rs) and the removal
        // lands on a later sweep — so leaving this uninstrumented would hide
        // the single most plausible culprit.
        let aug_before = self.aug_probe();
        self.sweep_eviction_queue(now, &mut events);
        self.maintain_visibility_prune_deadlines(now);
        if self.aug_probe() != aug_before {
            self.note_aug_transition("tick/sweep", aug_before);
        }

        events
    }

    pub(crate) fn upsert_entity_from_create(
        &mut self,
        mut entity: Entity,
        events: &mut Vec<WorldEvent>,
    ) -> EntityUpsertKind {
        let guid = entity.guid;
        // ACE re-sends the local player's own ObjectCreate (portal and
        // visibility transitions), and the create carries only the public
        // weenie baseline — replacing the entity wholesale dropped every
        // PlayerDescription-only property (live soak v6.4: Level read 0
        // from the first in-dungeon re-create until relog, while the later
        // XP int64 updates repopulated TotalExperience around it). Keep the
        // private dump underneath; the fresh create still wins on every
        // property it actually carries.
        // Base = the live entity's properties when it still exists, else the
        // stashed PlayerDescription dump (the entity may have been removed —
        // explicit delete + recreate — leaving nothing to merge from; observed
        // live in soak v6.5 where Level flipped 1 -> 0 minutes into the run
        // despite the existing-entity merge below).
        if guid != Guid::NULL && guid == self.player.guid {
            let base = self
                .entities
                .get(guid)
                .map(|existing| existing.properties.clone())
                .or_else(|| self.player_description_properties.clone());
            if let Some(mut merged) = base {
                merged.merge(std::mem::take(&mut entity.properties));
                entity.properties = merged;
            }
        }
        let preserve_container_preview = entity
            .container_id()
            .is_some_and(|container| self.open_containers.contains(&container))
            || self
                .entities
                .get(guid)
                .and_then(|existing| existing.container_id())
                .is_some_and(|container| self.open_containers.contains(&container));

        self.clear_entity_explicit_delete(guid);
        self.clear_entity_prune_deadline(guid);
        if !self.trade_contains_item(guid) {
            self.clear_trade_preview(guid);
        }
        if !preserve_container_preview {
            self.clear_container_preview(guid);
        }

        // Spawn-time hidden case: if the entity comes online with
        // HIDDEN/NO_DRAW/CLOAKED set, emit EntityVisibilityChanged
        // immediately so the renderer never draws a frame of the
        // entity in its visible-by-default state. Cheap snapshot —
        // most entities have NONE here so the gate is false and no
        // event fires.
        let spawn_hidden = !entity.should_draw();
        let spawn_guid = entity.guid;

        if let Some(old_lb) = self
            .entities
            .get(guid)
            .map(|existing| existing.position.landblock_id)
        {
            self.entities.insert(entity.clone());
            self.scene.update_entity(guid, old_lb, entity.position);
            self.reconcile_authoritative_body(
                guid,
                entity.position,
                entity.velocity,
                entity.omega,
                crate::spatial::AuthoritativeBodySync::Snapshot,
            );
            events.push(WorldEvent::EntityReplaced(Box::new(entity)));
            if spawn_hidden {
                events.push(WorldEvent::EntityVisibilityChanged {
                    guid: spawn_guid,
                    visible: false,
                });
            }
            EntityUpsertKind::Replaced
        } else {
            self.add_entity(entity.clone());
            events.push(WorldEvent::EntitySpawned(Box::new(entity)));
            if spawn_hidden {
                events.push(WorldEvent::EntityVisibilityChanged {
                    guid: spawn_guid,
                    visible: false,
                });
            }
            EntityUpsertKind::Inserted
        }
    }
}
