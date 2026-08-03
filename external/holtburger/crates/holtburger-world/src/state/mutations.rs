use super::*;
use crate::context::WorldContextExt;
use crate::entity::EntityPositionSyncOutcome;
use crate::spatial::{
    AuthoritativeBodySync, ContactState, RemoteCorrectionCtx, RuntimeBodyResetCause,
    RuntimeSpatialBodyView, SolvedBodyKinematics, SpatialBodyEvent, SpatialBodyId,
    SpatialSampleMode, SpatialSamplingConfig,
};
use holtburger_common::math::Quaternion;
use holtburger_common::position::WorldPosition;
use holtburger_common::properties::WorldObjectExt as _;
use holtburger_common::sequence::is_newer_u16;
use std::collections::HashSet;
use holtburger_protocol::messages::movement::{
    PositionPack, PositionType, ServerAutonomousPositionData, UpdatePositionFlag,
};
use web_time::Instant;

/// Movement-protocol parity (2026-06-04, item A3 / OQ-1): when `true`,
/// authoritative `VectorUpdate` (velocity/omega) frames are gated on a
/// newer-than-stored `vector_sequence` (retail
/// `SmartBox::DoVectorUpdate` → `CPhysicsObj::update_times[3]`,
/// acclient.c:143459-143480) before being applied, and the stamp is
/// advanced on accept. When `false`, VectorUpdate is applied
/// unconditionally (the prior behaviour).
///
/// **Enabled (2026-06-04).** OQ-1 was settled by the running server's own
/// source (`~/ace-server`): `GameMessageVectorUpdate` writes
/// `GetNextSequence(SequenceType.ObjectVector)` on every broadcast, so the
/// stamp is strictly monotonic per object — the gate accepts in-order
/// frames and drops only genuinely reordered/stale UDP, matching retail.
/// Remote baselines are seeded from ObjectCreate (`hydrate_from_odd` copies
/// all 9 sequences incl. `ObjectVector`); the self player's baseline (0)
/// matches a fresh-login server `ObjectVector`, so no first-update drop.
const USE_VECTOR_SEQUENCE_GATE: bool = true;

/// B1 snapback fix (2026-06-19): the local player must NOT reconcile its
/// predicted runtime body to its OWN autonomous-position echoes. ACE rebroadcasts
/// the player's client-initiated movement (`AutonomousPosition` 0xF753) at ~20 Hz
/// with gaps up to ~1.2 s; reconciling the predicted body toward that laggy echo
/// is the "outrun then get pulled back, constant cadence" rubberband (amplified on
/// high-Run chars). Retail snaps the local player ONLY on a sequence-class ADVANCE
/// (teleport / force_position — see `set_player_position_with_sync` doc), never on
/// every echo; this mirrors the 2D path's deliberate skip of syncing the local
/// sprite to Public/PrivateUpdatePosition. ON (default): autonomous self-echoes
/// update authoritative bookkeeping only (the runtime body keeps client prediction);
/// a forced teleport/force_position advance still hard-snaps. OFF: legacy
/// (Snapshot-reconcile on every accepted echo).
const USE_LOCAL_PLAYER_AUTONOMOUS_GUARD: bool = true;

impl WorldState {
    pub(crate) fn authoritative_body_id_for_guid(&self, guid: Guid) -> Option<SpatialBodyId> {
        if guid == Guid::NULL {
            return None;
        }

        Some(if guid == self.player.guid {
            SpatialBodyId::LocalPlayer(guid)
        } else {
            SpatialBodyId::Entity(guid)
        })
    }

    pub(crate) fn reconcile_authoritative_body(
        &mut self,
        guid: Guid,
        pose: WorldPosition,
        velocity: Vector3,
        omega: Vector3,
        sync: AuthoritativeBodySync,
    ) {
        self.reconcile_authoritative_body_with_remote(guid, pose, velocity, omega, sync, None);
    }

    /// A2-P2 (2026-06-12, W3+ S8): reconcile with the optional remote
    /// wire context (see [`RemoteCorrectionCtx`]). `None` = the legacy
    /// reconcile, byte-identical.
    pub(crate) fn reconcile_authoritative_body_with_remote(
        &mut self,
        guid: Guid,
        pose: WorldPosition,
        velocity: Vector3,
        omega: Vector3,
        sync: AuthoritativeBodySync,
        remote: Option<RemoteCorrectionCtx>,
    ) {
        let Some(body_id) = self.authoritative_body_id_for_guid(guid) else {
            return;
        };

        if pose.landblock_id == Guid::NULL {
            // WP-2 (no-retire-on-transient-NULL): a NULL-landblock pose is
            // normally a world-exit and retires the runtime body. But a
            // transient NULL for the LOCAL player — a null `posA` that precedes
            // the real arrival `posB` — must NOT drop the rig: retiring here
            // strands `getLocalPlayerPose().objCellId` at 0, and a never-placed
            // object cannot be re-placed. While the local player holds a
            // last-known-good cell (an arrival is pending, not a genuine
            // world-exit), HOLD the body Suspended at that cell instead of
            // retiring; the liveness watchdog recreates it via a `Reset` if
            // `posB` never lands. Remote entities and a local player that never
            // established a cell still retire — their NULL genuinely means
            // "left the scene" / "never entered".
            let hold_pose = (guid == self.player.guid
                && self.player.last_valid_landblock.is_some())
            .then(|| {
                self.scene.body(body_id).and_then(|body| {
                    body.authoritative_pose
                        .filter(|held| held.landblock_id != Guid::NULL)
                        .or(Some(body.pose))
                        .filter(|held| held.landblock_id != Guid::NULL)
                })
            })
            .flatten();
            if let Some(hold_pose) = hold_pose {
                self.scene
                    .apply_runtime_body_pose(body_id, hold_pose, SpatialSampleMode::Suspended);
                return;
            }
            self.scene.retire_authoritative_body(body_id);
            return;
        }

        self.scene.reconcile_authoritative_body_with_remote(
            body_id,
            pose,
            velocity,
            omega,
            sync,
            Instant::now(),
            remote,
        );
    }

    /// A2-P2: flip the scene's remote-driver runtime switch (set once at
    /// world creation from the parsed `?remoteInterp=on` flag; wasm-only
    /// caller this stage — native stays off, S8 OPEN Q9).
    pub fn set_remote_interp_enabled(&mut self, enabled: bool) {
        self.scene.set_remote_interp_enabled(enabled);
    }

    /// A2-P3 R2: flip the scene's REMOTE sticky runtime switch (set once
    /// at world creation from `?stickyRetail` AND the effective
    /// `?remoteInterp` composite AND `USE_STICKY_MANAGER`; wasm-only
    /// caller — native has no remote driver to compose with). F5
    /// (2026-07-27): all of those conjuncts read ON when their flag is
    /// absent, so the shipped wasm default for this switch is `true` —
    /// see the field doc on `SpatialScene::remote_sticky_enabled`.
    pub fn set_remote_sticky_enabled(&mut self, enabled: bool) {
        self.scene.set_remote_sticky_enabled(enabled);
    }

    /// COMBAT-RADII (2026-07-28): flip the scene's size-aware
    /// combat-standoff switch (set once at world creation from
    /// `?combatRadii`, which is ON unless `=off`). See the field doc on
    /// `SpatialScene::combat_radii_enabled`.
    pub fn set_combat_radii_enabled(&mut self, enabled: bool) {
        self.scene.set_combat_radii_enabled(enabled);
    }

    /// Physics-parity 2026-07-03 (dossier A F9/F14): flip the scene's
    /// retail LOCAL position lattice (set once at world creation from
    /// `?retailLeash=on`; default off = shipped behavior).
    pub fn set_local_retail_leash(&mut self, enabled: bool) {
        self.scene.set_local_retail_leash(enabled);
    }

    /// Bug-A leash echo gate (2026-07-03): the local leash arm's
    /// InterpolateTo pull gates on the retail `UsePositionFromServer`
    /// predicate instead of the control mirror (set once at world
    /// creation from `?leashEchoGate`; browser DEFAULT-ON since
    /// F-2026-07-04, `=off` escape).
    pub fn set_leash_echo_gate(&mut self, enabled: bool) {
        self.scene.set_leash_echo_gate(enabled);
    }

    /// Physics-parity 2026-07-03 (dossier A F8): the LOCAL
    /// force-position step with retail `UseTime` velocity routing — a
    /// drain-applied velocity (blip-recovery tail velocity,
    /// acclient.c:389365-389368) lands in the player's split velocity
    /// store via `PlayerState::set_velocity` (dedupe + two-step 50
    /// clamp), not just the spatial-body mirror.
    pub fn step_local_force_position(
        &mut self,
        body_id: SpatialBodyId,
        quantum: f32,
        max_speed: f32,
        on_contact: bool,
    ) -> crate::spatial::InterpStep {
        let (step, commands) = self
            .scene
            .step_force_position_interpolation(body_id, quantum, max_speed, on_contact);
        if matches!(body_id, SpatialBodyId::LocalPlayer(_)) {
            for command in commands {
                if let crate::spatial::InterpolationCommand::SetVelocity(v) = command {
                    self.player.set_velocity(v);
                }
            }
        }
        step
    }

    /// Physics-parity 2026-07-03 (dossier A F9b): the manual-drive
    /// constraint chain slot — scales the local player's per-slice
    /// movement delta through the armed leash (see
    /// [`SpatialScene::constrain_local_manual_delta`]). Passthrough
    /// with the leash off or no local body.
    pub fn constrain_local_manual_delta(&mut self, delta: Vector3) -> Vector3 {
        let Some(body_id) = self.authoritative_body_id_for_guid(self.player.guid) else {
            return delta;
        };
        self.scene.constrain_local_manual_delta(body_id, delta)
    }

    /// FU5 (row 64) — retail `TakeControlFromServer`'s
    /// `StopInterpolating` arm (acclient.c:716950) for the LOCAL player
    /// body: interp stops, the leash constraint survives.
    pub fn stop_local_player_interpolation(&mut self) {
        let Some(body_id) = self.authoritative_body_id_for_guid(self.player.guid) else {
            return;
        };
        self.scene.stop_interpolation_only(body_id);
    }

    /// Physics-parity 2026-07-03 (dossier B row 45): retail
    /// `CPhysicsObj::IsFullyConstrained` for the LOCAL player body —
    /// the `jump_is_allowed` error-71 input (acclient.c:343947-343951).
    /// `false` with no body; a disarmed leash holds budget = max = 0,
    /// so this only trips once `?retailLeash` arms the constraint and
    /// the travel budget crosses `0.9 * max`.
    pub fn local_player_fully_constrained(&self) -> bool {
        let Some(body_id) = self.authoritative_body_id_for_guid(self.player.guid) else {
            return false;
        };
        self.scene
            .body(body_id)
            .is_some_and(|body| body.position_manager.constraint.is_fully_constrained())
    }

    pub(crate) fn retire_authoritative_body_for_guid(&mut self, guid: Guid) {
        let Some(body_id) = self.authoritative_body_id_for_guid(guid) else {
            return;
        };

        self.scene.retire_authoritative_body(body_id);
    }

    pub fn runtime_body_id_for_guid(&self, guid: Guid) -> Option<SpatialBodyId> {
        self.authoritative_body_id_for_guid(guid)
    }

    pub fn runtime_pose_for_guid(&self, guid: Guid) -> Option<WorldPosition> {
        let body_id = self.runtime_body_id_for_guid(guid)?;
        if let Some(body) = self.scene.body(body_id) {
            let mut pose = body.pose;
            // Cell-continuity guard (NavAtlas objCellId=0 — RIG root cause,
            // 2026-07-19): the per-frame solve write-back can leave the local
            // player's WORKING body pose with a NULL landblock while keeping
            // valid landblock-local coords. `project_pose_by_offset`
            // (physics.rs) re-derives the landblock from
            // `authoritative_pose.global_coords()`, but once the landblock is
            // 0 the global collapses to just the local coords (e.g. 72.8,18.6),
            // so it re-derives 0 EVERY frame — a self-perpetuating feedback
            // null that keeps the local coords. An IDLE solo player never
            // receives the inbound echo that would reconcile-heal it, so
            // `getLocalPlayerPose().landblockId` (→ rynth objCellId) reads 0
            // permanently and MoveToPosition grinds against the wrong
            // landblock. A NULL working cell is never legitimate: surface the
            // correct cell from the server-authoritative pose (which stays
            // correct — physics diag shows server == predicted == real global),
            // falling back to the authoritative entity position. This read is
            // the single chokepoint both `getLocalPlayerPose` AND the movement
            // solve input (`current_local_solve_body_input` →
            // `local_player_runtime_pose`) go through, so the solve then
            // re-derives a valid landblock from the corrected global and writes
            // it back, self-healing `body.pose` within a frame. Keeps the
            // working local coords — they are valid for the authoritative cell.
            // Fires ONLY while the working landblock is NULL (the bug state);
            // a valid cell is returned untouched.
            if pose.landblock_id == Guid::NULL {
                let heal_landblock = body
                    .authoritative_pose
                    .map(|auth| auth.landblock_id)
                    .filter(|lb| *lb != Guid::NULL)
                    .or_else(|| {
                        self.entities
                            .get(guid)
                            .map(|entity| entity.position.landblock_id)
                            .filter(|lb| *lb != Guid::NULL)
                    });
                if let Some(landblock_id) = heal_landblock {
                    pose.landblock_id = landblock_id;
                } else if guid == self.player.guid
                    && let Some(last_valid_pose) = self.player.last_valid_pose
                {
                    // WP-2 (last-known-good cell), C2-fixed (rynth-review 07,
                    // 2026-07-23): the FINAL fallback — when BOTH the working
                    // authoritative pose AND the entity position are NULL (a
                    // null `posA` the arrival `posB` never reconciled), heal
                    // the LOCAL player to its last-known-good pose so the
                    // source cell is reported, not 0. Swaps in the WHOLE
                    // stored pose (cell + matching coords + rotation) rather
                    // than splicing just the cell onto the CURRENT working
                    // `pose.coords` — those coords can already have advanced
                    // into a different cell's local frame while the landblock
                    // is momentarily NULL, which would otherwise emit a mixed
                    // cell+coords pose (see `PlayerState::last_valid_pose`
                    // doc). Scoped to the local player — `last_valid_pose` is
                    // the local player's own history and must never leak onto
                    // a remote guid.
                    pose = last_valid_pose;
                }
            }
            return Some(pose);
        }

        // Body-absent arm: fall back to the authoritative entity position.
        // WP-2 (last-known-good cell), C2-fixed: if the body was retired and
        // only a NULL-landblock entity pose remains, heal the LOCAL player to
        // its last-known-good WHOLE pose (not just the cell spliced onto the
        // stale entity coords) so the source cell is still reported (not 0)
        // and the reported coords stay consistent with it.
        let mut pose = self.entities.get(guid).map(|entity| entity.position)?;
        if pose.landblock_id == Guid::NULL
            && guid == self.player.guid
            && let Some(last_valid_pose) = self.player.last_valid_pose
        {
            pose = last_valid_pose;
        }
        Some(pose)
    }

    /// C1 fix (rynth-review 07/17-SYNTHESIS streamline #5, 2026-07-23) —
    /// honest "is `guid`'s pose cell resolved RIGHT NOW?" query, bypassing
    /// both retention layers stacked on top of the raw pose:
    /// [`Self::runtime_pose_for_guid`]'s WP-2 `last_valid_pose` heal (this
    /// fn), and the wasm-side WP-3 whole-pose shadow
    /// (`lib.rs::next_local_pose_shadow`, never surfaced through
    /// `WorldState` at all). Both are designed to NEVER regress the
    /// reported `landblock_id`/`objCellId` to 0 once a good pose has been
    /// seen — which silently voided the `objCellId==0` "position
    /// unresolved, hold" sentinel the nav layer (`ai/actions.js`,
    /// `ai/tools/dungeon_nav.js`, `ai/explore_memory.js`,
    /// `indoor_router.js`) still depends on. Nav consumers should read
    /// THIS instead of inferring resolution from `landblock_id == 0`.
    ///
    /// Mirrors the FIRST TWO heal sources in `runtime_pose_for_guid`
    /// (`body.authoritative_pose`, then the entity position) as "still
    /// genuinely resolved" — both read a CURRENTLY-accurate alternate
    /// field, not history (see the `NavAtlas objCellId=0` doc above).
    /// Only the WP-2 `last_valid_pose` fallback is excluded: THAT one
    /// invents a cell from history when there is truly no live data
    /// anywhere, which is exactly the case nav consumers need to see
    /// honestly rather than have masked.
    pub fn runtime_pose_cell_resolved_for_guid(&self, guid: Guid) -> bool {
        let Some(body_id) = self.runtime_body_id_for_guid(guid) else {
            return false;
        };
        let Some(body) = self.scene.body(body_id) else {
            return self
                .entities
                .get(guid)
                .is_some_and(|entity| entity.position.landblock_id != Guid::NULL);
        };
        if body.pose.landblock_id != Guid::NULL {
            return true;
        }
        body.authoritative_pose
            .is_some_and(|auth| auth.landblock_id != Guid::NULL)
            || self
                .entities
                .get(guid)
                .is_some_and(|entity| entity.position.landblock_id != Guid::NULL)
    }

    /// [`Self::runtime_pose_cell_resolved_for_guid`] scoped to the local
    /// player — the wasm `getLocalPlayerPoseCellResolved` export's
    /// backing query.
    pub fn local_player_pose_cell_resolved(&self) -> bool {
        self.runtime_pose_cell_resolved_for_guid(self.player.guid)
    }

    pub fn runtime_kinematics_for_guid(
        &self,
        guid: Guid,
    ) -> Option<(SpatialBodyId, WorldPosition, Vector3, Vector3)> {
        let body_id = self.runtime_body_id_for_guid(guid)?;
        if let Some(body) = self.scene.body(body_id) {
            return Some((body_id, body.pose, body.velocity, body.omega));
        }

        self.entities
            .get(guid)
            .map(|entity| (body_id, entity.position, entity.velocity, entity.omega))
    }

    pub fn local_player_runtime_pose(&self) -> Option<WorldPosition> {
        self.runtime_pose_for_guid(self.player.guid)
    }

    pub fn local_player_runtime_kinematics(&self) -> Option<(WorldPosition, Vector3, Vector3)> {
        self.runtime_kinematics_for_guid(self.player.guid)
            .map(|(_, pose, velocity, omega)| (pose, velocity, omega))
    }

    pub fn runtime_sampling_config(&self) -> SpatialSamplingConfig {
        self.scene.runtime_sampling_config()
    }

    pub fn set_runtime_sampling_config(&mut self, config: SpatialSamplingConfig) {
        self.scene.set_runtime_sampling_config(config);
    }

    pub fn runtime_body_view(&self, body_id: SpatialBodyId) -> Option<RuntimeSpatialBodyView> {
        if let Some(view) = self.scene.runtime_body_view(body_id) {
            return Some(view);
        }

        let guid = body_id.authoritative_guid()?;
        self.entities
            .get(guid)
            .map(|entity| RuntimeSpatialBodyView {
                body_id,
                authoritative_pose: Some(entity.position),
                runtime_pose: entity.position,
                velocity: entity.velocity,
                omega: entity.omega,
                motion_state: entity.motion_snapshot,
                contact: ContactState::Unknown,
                sample_mode: SpatialSampleMode::AuthoritativeOnly,
            })
    }

    pub fn runtime_body_views(&self) -> Vec<RuntimeSpatialBodyView> {
        self.scene.iter_runtime_body_views().collect()
    }

    pub(crate) fn ensure_runtime_body(&mut self, body_id: SpatialBodyId) -> bool {
        if self.scene.body(body_id).is_some() {
            return true;
        }

        let Some(guid) = body_id.authoritative_guid() else {
            return false;
        };

        let Some((_, pose, velocity, omega)) = self.runtime_kinematics_for_guid(guid) else {
            return false;
        };

        self.scene.reconcile_authoritative_body(
            body_id,
            pose,
            velocity,
            omega,
            AuthoritativeBodySync::Snapshot,
            Instant::now(),
        );
        true
    }

    pub fn suspend_runtime_bodies(&mut self, cause: RuntimeBodyResetCause) -> Vec<WorldEvent> {
        self.scene.suspend_runtime_bodies(Instant::now());
        let mut events = Vec::new();
        Self::emit_runtime_bodies_reset(&mut events, cause);
        events
    }

    pub(crate) fn update_runtime_body_motion_snapshot_for_guid(
        &mut self,
        guid: Guid,
        motion_state: Option<crate::entity::EntityMotionSnapshot>,
    ) -> Option<SpatialBodyId> {
        let body_id = self.runtime_body_id_for_guid(guid)?;
        if !self.ensure_runtime_body(body_id) {
            return None;
        }

        self.scene
            .update_runtime_body_motion_state(body_id, motion_state);
        Some(body_id)
    }

    fn emit_runtime_body_changed(events: &mut Vec<WorldEvent>, body_id: SpatialBodyId) {
        events.push(WorldEvent::RuntimeBodyChanged { body_id });
    }

    fn emit_runtime_body_removed(events: &mut Vec<WorldEvent>, body_id: SpatialBodyId) {
        events.push(WorldEvent::RuntimeBodyRemoved { body_id });
    }

    fn emit_runtime_bodies_reset(events: &mut Vec<WorldEvent>, cause: RuntimeBodyResetCause) {
        events.push(WorldEvent::RuntimeBodiesReset { cause });
    }

    pub fn set_local_player_runtime_pose(&mut self, pose: WorldPosition) -> Vec<WorldEvent> {
        let Some(body_id) = self.runtime_body_id_for_guid(self.player.guid) else {
            return Vec::new();
        };

        if !self.ensure_runtime_body(body_id) {
            return Vec::new();
        }

        if !self.scene.apply_runtime_body_pose(
            body_id,
            pose,
            SpatialSampleMode::SimulatingMotionState,
        ) {
            return Vec::new();
        }

        vec![WorldEvent::RuntimeBodyChanged { body_id }]
    }

    pub fn apply_solved_body_kinematics(
        &mut self,
        solved: &SolvedBodyKinematics,
    ) -> Vec<WorldEvent> {
        if !self.ensure_runtime_body(solved.body_id) {
            return Vec::new();
        }

        if !self.scene.apply_solved_runtime_body_kinematics(solved) {
            return Vec::new();
        }

        let mut events = Vec::new();
        Self::emit_runtime_body_changed(&mut events, solved.body_id);

        if matches!(solved.body_id, SpatialBodyId::LocalPlayer(_)) {
            self.apply_player_contact_state(solved.contact, &mut events);
        }

        events
    }

    pub fn apply_spatial_body_event(&mut self, event: &SpatialBodyEvent) -> Vec<WorldEvent> {
        match *event {
            SpatialBodyEvent::ContactChanged { body_id, contact } => {
                if !self.ensure_runtime_body(body_id) {
                    return Vec::new();
                }

                if !self.scene.apply_runtime_body_contact(body_id, contact) {
                    return Vec::new();
                }

                let mut events = Vec::new();
                Self::emit_runtime_body_changed(&mut events, body_id);

                if matches!(body_id, SpatialBodyId::LocalPlayer(_)) {
                    self.apply_player_contact_state(contact, &mut events);
                    events
                } else {
                    events
                }
            }
            SpatialBodyEvent::ForcedReposition { body_id, pose } => {
                if !self.ensure_runtime_body(body_id) {
                    return Vec::new();
                }

                self.scene
                    .apply_forced_reposition_reset(body_id, pose, Instant::now());

                body_id.authoritative_guid().map_or_else(Vec::new, |guid| {
                    vec![
                        WorldEvent::RuntimeBodyChanged { body_id },
                        WorldEvent::ForcedReposition {
                            guid,
                            pos: pose,
                            sequence: 0,
                        },
                    ]
                })
            }
        }
    }

    fn apply_player_contact_state(&mut self, contact: ContactState, events: &mut Vec<WorldEvent>) {
        let Some(grounded) = contact.grounded() else {
            return;
        };

        if self.player.last_server_grounded == Some(grounded) {
            return;
        }

        self.player.last_server_grounded = Some(grounded);
        events.push(WorldEvent::PlayerGroundedUpdated { grounded });
    }

    /// A2-P2 (2026-06-12, W3+ S8): build the remote wire context for an
    /// entity position sync — `Some` only when the remote driver is on
    /// AND the sync came from a wire position correction (`contact` is
    /// the frame's `IS_GROUNDED` bit when it carries one). Internal
    /// bookkeeping syncs (rotation writes) pass `wire = None` and keep
    /// the legacy reconcile, so a TurnTo heading write can never feed —
    /// and deadband-cancel — an in-flight interpolation.
    fn remote_correction_ctx(&self, wire: Option<Option<bool>>) -> Option<RemoteCorrectionCtx> {
        if !self.scene.remote_interp_enabled() {
            return None;
        }
        wire.map(|contact| RemoteCorrectionCtx {
            contact,
            // The at-ingest analog of retail's per-frame cached
            // `player_distance` (acclient.c:323107-323114; S8 OPEN Q3).
            player_pose: self.local_player_runtime_pose(),
        })
    }

    fn emit_entity_position_sync(
        &mut self,
        guid: Guid,
        old_lb: Guid,
        pos: WorldPosition,
        outcome: EntityPositionSyncOutcome,
        wire_contact: Option<Option<bool>>,
        events: &mut Vec<WorldEvent>,
    ) {
        let remote_ctx = self.remote_correction_ctx(wire_contact);
        match outcome {
            EntityPositionSyncOutcome::Rejected => {}
            EntityPositionSyncOutcome::Moved => {
                self.scene.update_entity(guid, old_lb, pos);
                let (velocity, omega) = self
                    .entities
                    .get(guid)
                    .map(|entity| (entity.velocity, entity.omega))
                    .unwrap_or((Vector3::zero(), Vector3::zero()));
                self.reconcile_authoritative_body_with_remote(
                    guid,
                    pos,
                    velocity,
                    omega,
                    AuthoritativeBodySync::Snapshot,
                    remote_ctx,
                );
                if let Some(body_id) = self.runtime_body_id_for_guid(guid) {
                    Self::emit_runtime_body_changed(events, body_id);
                }
                events.push(WorldEvent::EntityMoved { guid, pos })
            }
            EntityPositionSyncOutcome::Reset { sequence } => {
                self.scene.update_entity(guid, old_lb, pos);
                let (velocity, omega) = self
                    .entities
                    .get(guid)
                    .map(|entity| (entity.velocity, entity.omega))
                    .unwrap_or((Vector3::zero(), Vector3::zero()));
                self.reconcile_authoritative_body_with_remote(
                    guid,
                    pos,
                    velocity,
                    omega,
                    AuthoritativeBodySync::Reset,
                    remote_ctx,
                );
                if let Some(body_id) = self.runtime_body_id_for_guid(guid) {
                    Self::emit_runtime_body_changed(events, body_id);
                }
                events.push(WorldEvent::ForcedReposition {
                    guid,
                    pos,
                    sequence,
                });
            }
        }
    }

    pub(crate) fn mark_entity_immediately_eligible_for_pruning_if_unretained(
        &mut self,
        guid: Guid,
    ) -> bool {
        let now = self.current_server_time();

        let Some(snapshot) = self.reconcile_entity_retention(guid) else {
            return false;
        };

        if snapshot.is_retained() {
            return false;
        }

        self.set_entity_prune_deadline(guid, now);
        true
    }

    pub(crate) fn sync_player_ownership_for_entity(&mut self, guid: Guid) {
        // Invariant: the player is never an item in its own inventory, so it
        // must never be reconciled through the ownership path. A self
        // ObjectCreate (guid == player guid) lands here with container_id and
        // wielder_id both unset → held/wielded compute false → the recursive
        // pass below would remove the player guid AND its whole contained
        // subtree (every carried item + coins) from `player.inventory`,
        // wiping the client-side inventory set. Guard it at the top.
        if guid == self.player.guid {
            return;
        }

        let Some((container_id, wielder_id, equip_mask)) = self.entities.get(guid).map(|entity| {
            (
                entity.container_id(),
                entity.wielder_id(),
                entity.wield_location(),
            )
        }) else {
            return;
        };

        let held_by_player = container_id.is_some_and(|owner_guid| {
            owner_guid == self.player.guid || self.is_in_player_inventory(owner_guid)
        });
        let wielded_by_player = wielder_id == Some(self.player.guid);

        self.update_player_inventory_recursive(guid, held_by_player || wielded_by_player);

        if wielded_by_player {
            self.player.wield_item(guid, equip_mask);
        } else {
            self.player.unwield_item(guid);
        }
    }

    /// One-shot re-file of every entity the player already owns.
    ///
    /// Varek coins=0 follow-up (2026-07-20). `sync_player_ownership_for_entity`
    /// files an item into `player.inventory` at the instant its `ObjectCreate`
    /// is processed, from `container_id == player.guid` / `wielder_id ==
    /// player.guid`. If that create is ever handled BEFORE the player's guid is
    /// established (NULL at the time), both comparisons are false, the item is
    /// silently dropped, and — because the ownership sync only runs off the
    /// create itself — NOTHING re-reconciles it afterwards. The live wasm
    /// pipeline sets `player.guid` eagerly at SelectCharacter so this ordering
    /// doesn't bite it today, but the world crate carries no such guarantee and
    /// a wiped/mis-ordered set otherwise stays wiped until relog.
    ///
    /// This runs when the player's OWN entity becomes known in the world (its
    /// self-`ObjectCreate` — see `handlers/inventory.rs`), re-syncing ownership
    /// for every entity whose container or wielder already points at the player.
    /// Bounded (single pass over the entity map), NULL-guid-safe (no-op until
    /// the guid lands), and idempotent (re-syncing an already-filed item is a
    /// no-op). It never touches the player guid itself — the c6040ae0 self-guid
    /// guard in `sync_player_ownership_for_entity` short-circuits that — so it
    /// only ever ADDS legitimately-owned items, never wipes.
    pub(crate) fn reconcile_player_owned_entities(&mut self) {
        let player_guid = self.player.guid;
        if player_guid == Guid::NULL {
            return;
        }

        let owned: Vec<Guid> = self
            .entities
            .entities
            .iter()
            .filter_map(|(guid, entity)| {
                let guid = *guid;
                (guid != player_guid
                    && (entity.container_id() == Some(player_guid)
                        || entity.wielder_id() == Some(player_guid)))
                .then_some(guid)
            })
            .collect();

        for guid in owned {
            self.sync_player_ownership_for_entity(guid);
        }
    }

    pub(crate) fn emit_level_info(&self, events: &mut Vec<WorldEvent>) {
        events.push(WorldEvent::LevelInfoUpdated(self.get_level_info()));
    }

    pub(crate) fn emit_player_info(&self, events: &mut Vec<WorldEvent>) {
        let Some(entity) = self.player_entity() else {
            return;
        };

        events.push(WorldEvent::PlayerInfo(Box::new(crate::PlayerInfoData {
            entity: Box::new(entity.clone()),
            attributes: self.player.attribute_snapshot(),
            vitals: self.player.vital_snapshot(),
            skills: self.player.skill_snapshot(),
            enchantments: self.player.enchantments.clone(),
            spells: self.player.spells.keys().cloned().collect(),
            level_info: self.get_level_info(),
            resistances: self.player_resistances(),
            armor: self.player_armor(),
            vitae: self.player_vitae(),
            inventory: self.player.inventory.clone(),
            equipment: self.player.equipment.clone(),
        })));
    }

    fn bootstrap_player_entity_from_description(
        &mut self,
        data: &PlayerDescriptionEventData,
    ) -> Option<WorldPosition> {
        let guid = data.guid;
        let mut properties = data.properties.clone();
        properties
            .strings
            .0
            .entry(PropertyString::Name)
            .or_insert_with(|| data.name.clone());
        // Stash the private dump for upsert_entity_from_create's re-seed
        // (lvl=0 soak bug 2026-07-18 — see the field doc in types.rs).
        self.player_description_properties = Some(properties.clone());

        let bootstrap_position = data
            .pos
            .or_else(|| self.entities.get(guid).map(|entity| entity.position))
            .unwrap_or_default();

        if let Some(entity) = self.entities.get_mut(guid) {
            entity.properties = properties;
            entity.position = bootstrap_position;
            entity.set_string_prop(PropertyString::Name, data.name.clone());
        } else {
            let mut entity =
                crate::entity::Entity::new(guid, data.name.clone(), bootstrap_position);
            entity.properties = properties;
            self.add_entity(entity);
        }

        if data.pos.is_some() {
            self.sync_player_position(bootstrap_position);
        }

        self.entities.get(guid).map(|entity| entity.position)
    }

    /// Phase 4 step 3.7 — exposed `pub` so the wasm recv loop can call
    /// it on inbound `GameEvent::PlayerDescription`. Cli call sites
    /// (login + player handlers) live inside `holtburger-world`; the
    /// wasm bundle is the only outside caller. Body is unchanged.
    pub fn apply_player_description_world_state(
        &mut self,
        data: &PlayerDescriptionEventData,
        events: &mut Vec<WorldEvent>,
    ) {
        self.bootstrap_player_entity_from_description(data);

        self.emit_player_info(events);
        self.emit_level_info(events);
    }

    pub(crate) fn update_player_inventory_recursive(&mut self, root: Guid, owned: bool) {
        // Rust review 2026-08-03 (F2): this walk had NO visited set, and
        // `container_id()` is a raw wire property (`PropertyInstanceId::Container`,
        // set by ObjectCreate / UpdateInstanceId). A container CYCLE therefore
        // spun forever and hung the browser tab — the degenerate case being a
        // single entity whose Container points at ITSELF (pop X, scan finds X,
        // push X, repeat), with A→B→A equally fatal. The client must not trust
        // the server to keep the containment graph acyclic.
        //
        // `visited` also collapses the diamond case (an entity reachable by two
        // paths was previously re-scanned once per path), so this is strictly
        // less work as well. Set semantics are unchanged for well-formed trees:
        // add/remove_from_inventory is idempotent, so skipping a repeat visit
        // cannot alter the resulting inventory.
        let mut visited: HashSet<Guid> = HashSet::new();
        let mut stack = vec![root];
        while let Some(current) = stack.pop() {
            if !visited.insert(current) {
                continue;
            }
            if owned {
                self.player.add_to_inventory(current);
            } else {
                self.player.remove_from_inventory(current);
            }

            for (&guid, entity) in &self.entities.entities {
                if entity.container_id() == Some(current) && !visited.contains(&guid) {
                    stack.push(guid);
                }
            }
        }
    }

    pub(crate) fn apply_entity_position_pack(
        &mut self,
        guid: Guid,
        pos_pack: &PositionPack,
        events: &mut Vec<WorldEvent>,
    ) -> bool {
        let Some(entity) = self.entities.get_mut(guid) else {
            return false;
        };

        let old_lb = entity.position.landblock_id;
        let pos = pos_pack.pos;
        let outcome = entity.apply_server_position_update(
            pos,
            pos_pack.instance_sequence,
            Some(pos_pack.position_sequence),
            pos_pack.teleport_sequence,
            pos_pack.force_position_sequence,
            None,
        );
        let accepted = !matches!(outcome, EntityPositionSyncOutcome::Rejected);

        let mut velocity_event = None;
        if accepted {
            if let Some(velocity) = pos_pack.velocity {
                // F9: wire velocity is length-validated but not value-validated;
                // a non-finite component would poison the integrator permanently.
                let velocity = velocity.finite_or_zero();
                entity.velocity = velocity;
                velocity_event = Some((velocity, entity.omega));
            } else if pos_pack.flags.contains(UpdatePositionFlag::IS_GROUNDED)
                && entity.velocity != Vector3::zero()
            {
                entity.velocity = Vector3::zero();
                velocity_event = Some((entity.velocity, entity.omega));
            }
        }

        // A2-P2: a wire UpdatePosition correction — `pp.has_contact` is
        // the IS_GROUNDED flag bit (acclient.c:145287 / position.rs).
        let wire_contact = Some(Some(
            pos_pack.flags.contains(UpdatePositionFlag::IS_GROUNDED),
        ));
        self.emit_entity_position_sync(guid, old_lb, pos, outcome, wire_contact, events);
        if let Some((velocity, omega)) = velocity_event {
            events.push(WorldEvent::EntityVectorUpdated {
                guid,
                velocity,
                omega,
            });
        }
        accepted
    }

    pub(crate) fn apply_entity_autonomous_position(
        &mut self,
        data: &ServerAutonomousPositionData,
        events: &mut Vec<WorldEvent>,
    ) -> bool {
        let Some(entity) = self.entities.get_mut(data.guid) else {
            return false;
        };

        let old_lb = entity.position.landblock_id;
        // The 0xF753 frame carries no cell id (ACE writeLandblock:false) —
        // carry the entity's current landblock forward.
        let pos = data.position_in(old_lb);
        let outcome = entity.apply_server_position_update(
            pos,
            data.instance_sequence,
            None,
            data.teleport_sequence,
            data.force_position_sequence,
            Some(data.server_control_sequence),
        );
        let accepted = !matches!(outcome, EntityPositionSyncOutcome::Rejected);
        // A2-P2: 0xF753 carries no contact bit — `Some(None)` = wire
        // correction with contact assumed (S8 OPEN Q2 ruling).
        self.emit_entity_position_sync(data.guid, old_lb, pos, outcome, Some(None), events);
        accepted
    }

    pub(crate) fn apply_private_position_update(
        &mut self,
        position_type: PositionType,
        position: WorldPosition,
        events: &mut Vec<WorldEvent>,
    ) {
        if position_type == PositionType::Location {
            events.extend(self.set_player_position(position));
            return;
        }

        self.player
            .set_local_position_overlay(position_type, position);
    }

    /// Updates the player's authoritative entity position and keeps the SpatialScene
    /// reconciliation state aligned with that world-owned pose.
    fn update_player_position(
        &mut self,
        pos: WorldPosition,
        sync: AuthoritativeBodySync,
    ) -> Option<(Guid, WorldPosition)> {
        self.update_player_position_core(pos, Some(sync))
    }

    /// B1 snapback fix ([`USE_LOCAL_PLAYER_AUTONOMOUS_GUARD`]): update the
    /// authoritative player position bookkeeping WITHOUT reconciling the runtime
    /// spatial body, so the predicted pose keeps running on client prediction.
    fn update_player_position_authoritative_only(
        &mut self,
        pos: WorldPosition,
    ) -> Option<(Guid, WorldPosition)> {
        self.update_player_position_core(pos, None)
    }

    fn update_player_position_core(
        &mut self,
        mut pos: WorldPosition,
        sync: Option<AuthoritativeBodySync>,
    ) -> Option<(Guid, WorldPosition)> {
        let guid = self.player.guid;
        if guid == Guid::NULL {
            return None;
        }

        if !pos.rotation.w.is_finite()
            || !pos.rotation.x.is_finite()
            || !pos.rotation.y.is_finite()
            || !pos.rotation.z.is_finite()
        {
            pos.rotation = self
                .player_position()
                .map(|current| current.rotation)
                .unwrap_or_default();
        }

        // Rust review 2026-08-03 (F9): the rotation was NaN-guarded above but the
        // COORDS were not, in this same function. `PositionPack::unpack` reads
        // x/y/z as raw `read_f32` with bounds checks but no value validation, so
        // one UpdatePosition carrying 0x7FC00000 wrote NaN into the player entity,
        // the scene body pose, and every downstream physics term.
        //
        // Nothing recovered it: `WorldPosition::rebucket_outdoor_landblock` is
        // NaN-inert (all its `>=`/`<` comparisons are false, so `moved` stays
        // false and the clamp arm never fires), leaving the pose NaN for the rest
        // of the session. Reject the update outright rather than half-applying it
        // — a non-finite server pose is not a pose.
        if !pos.coords.x.is_finite() || !pos.coords.y.is_finite() || !pos.coords.z.is_finite() {
            log::warn!(
                "rejecting non-finite server position for player {:?}: ({}, {}, {})",
                guid,
                pos.coords.x,
                pos.coords.y,
                pos.coords.z
            );
            return None;
        }

        // Physics deep-dive 2026-06-01 (cliff_slide Stage-2) — any
        // server-driven reposition (teleport, force-position resync,
        // autonomous-position sync) is a discontinuous pose change, so
        // the wall the local-drive solver was tracking
        // (`PlayerState::last_known_wall_normal`, the cliff_slide
        // `N_last` carrier) is meaningless afterwards. Invalidate it,
        // mirroring retail clearing `CollisionInfo.LastKnownContactPlane`
        // on a contact reset. The Stage-2 seam-skid only consumes this
        // when `USE_CLIFF_SLIDE` is on; clearing it unconditionally keeps
        // the carrier correct regardless of the flag.
        self.player.last_known_wall_normal = None;

        let old_lb = self.player_landblock().unwrap_or(Guid::NULL);
        if let Some(entity) = self.player_entity_mut() {
            entity.position = pos;
        } else {
            return None;
        }
        self.scene.update_entity(guid, old_lb, pos);

        // Cell-continuity heal (NavAtlas login `objCellId == 0`, 2026-07-19):
        // the login message race can leave the local player's runtime (working)
        // body pose with a NULL landblock even though the ENTITY carries the
        // real cell — the ObjectCreate seed populates `entity.position` and the
        // body pose (0x860201AD live-confirmed), but a later write can zero the
        // body's `landblock_id` while keeping the landblock-local coords, and the
        // `preserve_local_runtime_pose` gate then freezes that NULL cell. With
        // `routinePosGuard` ON every routine self-echo routes to the
        // authoritative-ONLY path (`sync = None`) which never reconciles the body,
        // so `getLocalPlayerPose().landblockId` (→ rynth `objCellId`) stays 0
        // forever and movement/teleports break (a never-placed object cannot be
        // re-placed). Whenever we apply a server pose with a valid cell and the
        // working body pose is still NULL, adopt authority onto the body so the
        // cell recovers — on BOTH the reconcile and authoritative-only paths.
        // Fires ONLY while the working landblock is NULL (the bug window); a valid
        // working cell is left untouched, so prediction / academy-rubberband paths
        // are unaffected. Companion to the `preserve_local_runtime_pose` NULL guard
        // in `scene.rs` (which covers the reconcile paths, e.g. VectorUpdate).
        if pos.landblock_id != Guid::NULL {
            // WP-2 (last-known-good cell): remember the most recent non-null
            // landblock the local player was placed at so a later transient
            // NULL-landblock pose (a null `posA` the arrival `posB` never
            // reconciles) can heal to the source cell rather than reporting
            // `objCellId` 0. Purely additive — a valid apply only records the
            // cell; nothing gates on it here.
            self.player.last_valid_landblock = Some(pos.landblock_id);
            // C2 fix (rynth-review 07, 2026-07-23): stamp the WHOLE pose
            // atomically alongside the cell — see `PlayerState::last_valid_pose`
            // doc — so the FINAL heal fallback in `runtime_pose_for_guid` never
            // has to splice a healed cell onto stale/mismatched working coords.
            self.player.last_valid_pose = Some(pos);
            if let Some(body_id) = self.runtime_body_id_for_guid(guid) {
                let working_cell_null = self
                    .scene
                    .body(body_id)
                    .is_some_and(|body| body.pose.landblock_id == Guid::NULL);
                if working_cell_null {
                    let mode = self
                        .scene
                        .body(body_id)
                        .map(|body| body.sampling.mode)
                        .unwrap_or(SpatialSampleMode::AuthoritativeOnly);
                    self.scene.apply_runtime_body_pose(body_id, pos, mode);
                }
            }
        }

        let (velocity, omega) = self
            .entities
            .get(guid)
            .map(|entity| (entity.velocity, entity.omega))
            .unwrap_or((Vector3::zero(), Vector3::zero()));
        if let Some(sync) = sync {
            self.reconcile_authoritative_body(guid, pos, velocity, omega, sync);
        }

        Some((guid, pos))
    }

    pub fn set_player_position(&mut self, pos: WorldPosition) -> Vec<WorldEvent> {
        self.set_player_position_with_sync(pos, AuthoritativeBodySync::Snapshot)
    }

    /// Movement bughunt 2026-06-19 ("stall → pull-back"): apply a ROUTINE
    /// (non-forced) server position broadcast to the local player WITHOUT
    /// reconciling the runtime spatial body — authoritative bookkeeping
    /// only (`entity.position` + scene authoritative pose + outbound
    /// sequence mirror, done by the caller), leaving the predicted body on
    /// client prediction. The `UpdatePosition`/`PrivateUpdatePosition`
    /// sibling of the B1 `apply_player_autonomous_position` guard: it
    /// stops a backlog-delayed ~20 Hz echo (which can land tens of metres
    /// behind) from installing a `force_position` interpolation that eases
    /// the avatar backward (scene.rs `preserve_local_runtime_pose`). Emits
    /// NO `EntityMoved`/runtime-changed event — the local rig follows the
    /// runtime body, so re-emitting the laggy authoritative pose would tug
    /// it back. Only a FORCED correction (sequence advance) routes through
    /// [`Self::set_player_position_with_sync`] and snaps the body.
    pub fn set_player_position_authoritative_only(&mut self, pos: WorldPosition) -> Vec<WorldEvent> {
        let _ = self.update_player_position_authoritative_only(pos);
        Vec::new()
    }

    /// Applies a server-authored player position with an explicit reconcile
    /// discriminant (B1/D3-SNAP). `Reset` hard-snaps the working pose — retail
    /// BlipPlayer / TeleportPlayer on a force_position OR teleport sequence
    /// advance (acclient.c:145196-145253); `Snapshot` blends/constrains toward
    /// it (a position-only update). The local player's snap is keyed on a
    /// sequence-class ADVANCE, never on every UpdatePosition — ACE bumps
    /// ObjectForcePosition only on the z-hack (Player_Tick.cs:488) and PKLite
    /// (Player.cs:1148), so routine play cannot rubberband to spawn. Does NOT
    /// zero velocity on the force path (ACE-VELZERO-1: retail's force reconcile
    /// is BlipPlayer/SetPositionSimple with no velocity zero; only the teleport
    /// path zeroes, and that is handled by the PlayerTeleport suspend).
    pub fn set_player_position_with_sync(
        &mut self,
        pos: WorldPosition,
        sync: AuthoritativeBodySync,
    ) -> Vec<WorldEvent> {
        let mut events = Vec::new();
        let Some((guid, pos)) = self.update_player_position(pos, sync) else {
            return events;
        };

        // Arrival-placement latch: a hard positional discontinuity (teleport
        // `Reset` / force-blip resync) can land the capsule embedded in an
        // env-cell wall. Retail runs a PLACEMENT transition on arrival
        // (`CPhysicsObj::SetPosition` → `find_placement_position`,
        // acclient.c:313341) that de-embeds the pose; schedule the same on the
        // next movement tick. `Snapshot` (routine ~20 Hz echoes) is smooth — no
        // discontinuity, no placement.
        if matches!(
            sync,
            AuthoritativeBodySync::Reset | AuthoritativeBodySync::ForceBlip
        ) {
            // Shared with the teleport-arrival path (soak-11 Layer-1): sets
            // `pending_arrival_placement` and clears the transient
            // stationary-fall carry (the 0x10/0x20 bits belong to the OLD
            // location's stuck fall, not the arrival's).
            self.player.latch_arrival_placement();
        }

        if let Some(body_id) = self.runtime_body_id_for_guid(guid) {
            Self::emit_runtime_body_changed(&mut events, body_id);
        }
        events.push(WorldEvent::EntityMoved { guid, pos });
        events
    }

    /// Synchronizes the authoritative player position without emitting movement events.
    ///
    /// This is intended for hydration/bootstrap flows where the client is seeding authoritative
    /// state rather than reacting to a live movement update packet.
    pub fn sync_player_position(&mut self, pos: WorldPosition) {
        let _ = self.update_player_position(pos, AuthoritativeBodySync::Snapshot);
    }

    pub fn set_player_vector(&mut self, velocity: Vector3, omega: Vector3) -> Vec<WorldEvent> {
        let mut events = Vec::new();
        let guid = self.player.guid;
        if guid == Guid::NULL {
            return events;
        }
        // F9: same non-finite wire-vector guard as `apply_entity_position_pack`.
        let velocity = velocity.finite_or_zero();
        let omega = omega.finite_or_zero();

        if let Some(entity) = self.entities.get_mut(guid) {
            entity.velocity = velocity;
            entity.omega = omega;
            let pose = entity.position;
            self.reconcile_authoritative_body(
                guid,
                pose,
                velocity,
                omega,
                AuthoritativeBodySync::Snapshot,
            );
            if let Some(body_id) = self.runtime_body_id_for_guid(guid) {
                Self::emit_runtime_body_changed(&mut events, body_id);
            }
            events.push(WorldEvent::EntityVectorUpdated {
                guid,
                velocity,
                omega,
            });
        }

        events
    }

    /// Self `VectorUpdate` application with the optional `vector_sequence`
    /// newer-than gate (item A3). When [`USE_VECTOR_SEQUENCE_GATE`] is
    /// off this is exactly [`Self::set_player_vector`]; when on it
    /// mirrors retail `SmartBox::DoVectorUpdate` (acclient.c:143459-143480):
    /// apply velocity/omega ONLY if `incoming_vector_sequence` is newer
    /// than the stored `player.vector_sequence`, and advance the stored
    /// stamp on accept.
    ///
    /// NOTE: the caller records the raw frame's `instance_sequence` via
    /// `PlayerState::record_vector_update_sequences` BEFORE calling this;
    /// it intentionally does NOT touch `player.vector_sequence`, so with
    /// the gate on this function performs the accept decision against the
    /// true PRE-record stored value and owns the stamp advance on accept.
    pub fn set_player_vector_gated(
        &mut self,
        velocity: Vector3,
        omega: Vector3,
        incoming_vector_sequence: u16,
    ) -> Vec<WorldEvent> {
        if USE_VECTOR_SEQUENCE_GATE {
            let stored = self.player.vector_sequence;
            if !is_newer_u16(incoming_vector_sequence, stored) {
                return Vec::new();
            }
            self.player.vector_sequence = incoming_vector_sequence;
        }
        self.set_player_vector(velocity, omega)
    }

    /// Applies an authoritative server-side movement sync to the player.
    pub fn apply_player_autonomous_position(
        &mut self,
        data: &ServerAutonomousPositionData,
    ) -> Vec<WorldEvent> {
        // Autonomous frames carry no position stamp (server_control occupies that
        // slot in AutonomousPositionPack), so the position-only gate does not apply.
        let accepted = self.player.should_accept_server_position_sequences(
            data.teleport_sequence,
            data.force_position_sequence,
            None,
        );

        // The 0xF753 frame carries no cell id (ACE writeLandblock:false) —
        // carry the player's current landblock forward.
        let position = data.position_in(self.player_landblock().unwrap_or(Guid::NULL));

        let runtime_delta_m = self
            .local_player_runtime_pose()
            .map(|pose| pose.distance_to(&position));
        let auth_delta_m = self
            .player_position()
            .map(|current| current.distance_to(&position))
            .unwrap_or_default();

        log::debug!(
            "player: self AutonomousPosition {} pos {:?} runtime_delta={:?} auth_delta={:.2}m seqs inst={} server={} teleport={} force={} current teleport={} force={} server={}",
            if accepted { "accepted" } else { "rejected" },
            position,
            runtime_delta_m,
            auth_delta_m,
            data.instance_sequence,
            data.server_control_sequence,
            data.teleport_sequence,
            data.force_position_sequence,
            self.player.teleport_sequence,
            self.player.force_position_sequence,
            self.player.server_control_sequence,
        );

        if !accepted {
            return Vec::new();
        }

        let mut events = vec![WorldEvent::SelfAutonomousPosition {
            teleport_sequence: data.teleport_sequence,
            force_position_sequence: data.force_position_sequence,
            server_control_sequence: data.server_control_sequence,
        }];

        // B1 snapback fix: a routine autonomous self-echo (the server rebroadcasting
        // our OWN client-initiated movement) must NOT reconcile the predicted runtime
        // body to the laggy ~20 Hz echo — that is the "outrun then snap back, constant
        // cadence" rubberband (amplified on high-Run chars). Only a FORCED correction
        // (teleport / force_position sequence ADVANCE) snaps the body. Compared against
        // the STORED sequences (still pre-update here; advanced at the bottom).
        let forced = data.teleport_sequence != self.player.teleport_sequence
            || data.force_position_sequence != self.player.force_position_sequence;
        if USE_LOCAL_PLAYER_AUTONOMOUS_GUARD && !forced {
            // Authoritative bookkeeping only (entity.position + scene + sequences below);
            // the runtime body keeps client prediction. No EntityMoved/runtime-changed —
            // the local rig follows the runtime body, and emitting the authoritative
            // (laggy) pose would tug it back.
            let _ = self.update_player_position_authoritative_only(position);
        } else {
            if forced {
                // Bug-A round-2 diag: the retail-legit snap lane
                // (teleport / force_position sequence advance).
                crate::pose_snap_diag::record(2, auth_delta_m);
            }
            events.extend(self.set_player_position(position));
        }

        self.player.instance_sequence = data.instance_sequence;
        self.player.server_control_sequence = data.server_control_sequence;
        self.player.teleport_sequence = data.teleport_sequence;
        self.player.force_position_sequence = data.force_position_sequence;

        events
    }

    pub(crate) fn apply_public_position_update(
        &mut self,
        guid: Guid,
        position_type: PositionType,
        position: WorldPosition,
        events: &mut Vec<WorldEvent>,
    ) -> bool {
        if position_type == PositionType::Location {
            if guid == self.player.guid {
                // Bug-A round-2 diag: this arm applies a server position to
                // the AUTONOMOUS local player unconditionally — retail's
                // full-autonomy client ignores these unless forced
                // (`CommandInterpreter::UsePositionFromServer`,
                // acclient.c:717529). Counted so live captures can convict
                // or clear it as the snapback carrier before any gating
                // change lands.
                let delta_m = self
                    .player_position()
                    .map(|current| current.distance_to(&position))
                    .unwrap_or_default();
                crate::pose_snap_diag::record(1, delta_m);
                events.extend(self.set_player_position(position));
                return true;
            }

            let Some(entity) = self.entities.get_mut(guid) else {
                return false;
            };

            let old_lb = entity.position.landblock_id;
            entity.position = position;
            // A2-P2: bare wire position frame, no contact bit.
            self.emit_entity_position_sync(
                guid,
                old_lb,
                position,
                EntityPositionSyncOutcome::Moved,
                Some(None),
                events,
            );
            return true;
        }

        if guid == self.player.guid {
            self.player
                .set_local_position_overlay(position_type, position);
        }

        true
    }

    pub(crate) fn update_entity_velocity(
        &mut self,
        guid: Guid,
        velocity: Vector3,
        omega: Vector3,
        incoming_vector_sequence: u16,
        events: &mut Vec<WorldEvent>,
    ) -> bool {
        if let Some(entity) = self.entities.get_mut(guid) {
            if USE_VECTOR_SEQUENCE_GATE {
                // Retail SmartBox::DoVectorUpdate gates remote velocity
                // on update_times[3] (ObjectVector) — acclient.c:143459-143480.
                if !is_newer_u16(incoming_vector_sequence, entity.vector_sequence()) {
                    return false;
                }
                entity.set_vector_sequence(incoming_vector_sequence);
            }
            entity.velocity = velocity;
            entity.omega = omega;
            let pose = entity.position;
            self.reconcile_authoritative_body(
                guid,
                pose,
                velocity,
                omega,
                AuthoritativeBodySync::Snapshot,
            );
            if let Some(body_id) = self.runtime_body_id_for_guid(guid) {
                Self::emit_runtime_body_changed(events, body_id);
            }
            events.push(WorldEvent::EntityVectorUpdated {
                guid,
                velocity,
                omega,
            });
            true
        } else {
            false
        }
    }

    pub(crate) fn update_health_fraction(
        &mut self,
        guid: Guid,
        health_fraction: f32,
        events: &mut Vec<WorldEvent>,
    ) -> bool {
        if guid == Guid::NULL || !health_fraction.is_finite() {
            return false;
        }

        let health_fraction = health_fraction.clamp(0.0, 1.0);
        let mut updated = false;

        if guid == self.player.guid
            && let Some(vital_obj) = self.player.vitals.get_mut(&crate::stats::VitalType::Health)
        {
            let new_current = (health_fraction * vital_obj.buffed_max as f32) as u32;
            if vital_obj.current != new_current {
                // === Wave 6 polish — vitalChanged oldValue (2026-05-28) ===
                // Snapshot prior value BEFORE the in-place mutation so the
                // health-fraction-driven update path also carries OldValue.
                // This path fires on UpdateHealthFraction broadcasts which
                // ACE sends for damage-taken bar-fill animations; the
                // delta is exactly what combat-hud needs to animate the
                // shrink. See VitalChangedEventArgs.cs:13-35 for contract.
                let prev_current = Some(vital_obj.current);
                vital_obj.current = new_current;
                events.push(WorldEvent::VitalUpdated {
                    vital: vital_obj.clone(),
                    prev_current,
                });
                updated = true;
            }
        }

        if let Some(entity) = self.entities.get_mut(guid)
            && entity.health_fraction != Some(health_fraction)
        {
            entity.health_fraction = Some(health_fraction);
            events.push(WorldEvent::EntityHealthUpdated {
                guid,
                health_fraction,
            });
            updated = true;
        }

        updated
    }

    pub(crate) fn set_entity_rotation(
        &mut self,
        guid: Guid,
        rotation: Quaternion,
        events: &mut Vec<WorldEvent>,
    ) -> bool {
        let (old_lb, pos) = {
            let Some(entity) = self.entities.get_mut(guid) else {
                return false;
            };

            let old_lb = entity.position.landblock_id;
            entity.position.rotation = rotation;
            (old_lb, entity.position)
        };

        // A2-P2: internal rotation bookkeeping — NOT a wire correction
        // (`None` keeps the legacy reconcile; see remote_correction_ctx).
        self.emit_entity_position_sync(
            guid,
            old_lb,
            pos,
            EntityPositionSyncOutcome::Moved,
            None,
            events,
        );
        true
    }

    pub(crate) fn clear_entity_world_presence(&mut self, guid: Guid) -> Option<WorldPosition> {
        if let Some(entity) = self.entities.get_mut(guid) {
            let old_lb = entity.position.landblock_id;
            if old_lb == Guid::NULL {
                return None;
            }

            entity.position.landblock_id = Guid::NULL;
            let position = entity.position;
            self.scene.remove_entity(guid, old_lb);
            self.retire_authoritative_body_for_guid(guid);
            Some(position)
        } else {
            None
        }
    }

    fn emit_entity_world_presence_cleared(&mut self, guid: Guid, events: &mut Vec<WorldEvent>) {
        if let Some(pos) = self.clear_entity_world_presence(guid) {
            if let Some(body_id) = self.runtime_body_id_for_guid(guid) {
                Self::emit_runtime_body_removed(events, body_id);
            }
            events.push(WorldEvent::EntityMoved { guid, pos });
        }
    }

    fn set_entity_inventory_location(
        &mut self,
        guid: Guid,
        container_guid: Guid,
        wielder_guid: Guid,
        equip_mask: EquipMask,
    ) -> bool {
        let Some(entity) = self.entities.get_mut(guid) else {
            return false;
        };

        entity.set_iid_prop(PropertyInstanceId::Container, container_guid);
        entity.set_iid_prop(PropertyInstanceId::Wielder, wielder_guid);
        entity.set_int_prop(
            PropertyInt::CurrentWieldedLocation,
            equip_mask.bits() as i32,
        );

        true
    }

    fn finalize_entity_inventory_location_update(
        &mut self,
        guid: Guid,
        clear_world_presence: bool,
        updates: Vec<PropertyUpdate>,
        events: &mut Vec<WorldEvent>,
    ) {
        if clear_world_presence {
            self.emit_entity_world_presence_cleared(guid, events);
        }

        self.sync_player_ownership_for_entity(guid);
        let _ = self.reconcile_entity_retention(guid);

        events.push(WorldEvent::PropertiesUpdated { guid, updates });
    }

    pub(crate) fn move_entity_into_container(
        &mut self,
        item_guid: Guid,
        container_guid: Guid,
        events: &mut Vec<WorldEvent>,
    ) -> bool {
        if !self.set_entity_inventory_location(
            item_guid,
            container_guid,
            Guid::NULL,
            EquipMask::NONE,
        ) {
            return false;
        }

        self.finalize_entity_inventory_location_update(
            item_guid,
            true,
            vec![
                PropertyUpdate::InstanceId(PropertyInstanceId::Container, container_guid),
                PropertyUpdate::InstanceId(PropertyInstanceId::Wielder, Guid::NULL),
                PropertyUpdate::Int(
                    PropertyInt::CurrentWieldedLocation,
                    EquipMask::NONE.bits() as i32,
                ),
            ],
            events,
        );

        true
    }

    pub(crate) fn move_entity_into_world(
        &mut self,
        guid: Guid,
        events: &mut Vec<WorldEvent>,
    ) -> bool {
        if !self.set_entity_inventory_location(guid, Guid::NULL, Guid::NULL, EquipMask::NONE) {
            return false;
        }

        self.finalize_entity_inventory_location_update(
            guid,
            false,
            vec![
                PropertyUpdate::InstanceId(PropertyInstanceId::Container, Guid::NULL),
                PropertyUpdate::InstanceId(PropertyInstanceId::Wielder, Guid::NULL),
                PropertyUpdate::Int(
                    PropertyInt::CurrentWieldedLocation,
                    EquipMask::NONE.bits() as i32,
                ),
            ],
            events,
        );

        true
    }

    pub(crate) fn wield_entity_for(
        &mut self,
        object_guid: Guid,
        wielder_guid: Guid,
        equip_mask: EquipMask,
        events: &mut Vec<WorldEvent>,
    ) -> bool {
        if !self.set_entity_inventory_location(object_guid, Guid::NULL, wielder_guid, equip_mask) {
            return false;
        }

        self.finalize_entity_inventory_location_update(
            object_guid,
            true,
            vec![
                PropertyUpdate::InstanceId(PropertyInstanceId::Wielder, wielder_guid),
                PropertyUpdate::InstanceId(PropertyInstanceId::Container, Guid::NULL),
                PropertyUpdate::Int(
                    PropertyInt::CurrentWieldedLocation,
                    equip_mask.bits() as i32,
                ),
            ],
            events,
        );

        true
    }

    pub(crate) fn resolve_property_target_guid(&self, guid: Guid) -> Guid {
        if guid == Guid::NULL {
            self.player.guid
        } else {
            guid
        }
    }

    pub(crate) fn apply_property_update_to_target(
        &mut self,
        guid: Guid,
        update: &PropertyUpdate,
    ) -> Guid {
        let target_guid = self.resolve_property_target_guid(guid);

        if let Some(entity) = self.entities.get_mut(target_guid) {
            entity.set_property(update.clone());
        } else if let Some(vendor) = self.vendor.as_mut()
            && let Some(item) = vendor
                .items
                .iter_mut()
                .find(|item| item.guid == target_guid)
        {
            item.set_property(update.clone());
        }

        target_guid
    }

    pub(crate) fn apply_instance_id_side_effect(
        &mut self,
        target_guid: Guid,
        property: PropertyInstanceId,
        value: Guid,
        events: &mut Vec<WorldEvent>,
    ) {
        let mut clear_world_presence = false;
        // Wave A / PR1 (2026-06-06): track Wielder transitions. The new
        // Wielder is `value`; the prior Wielder (if any) is whatever we
        // last recorded in `prior_wielders` for this entity. When `value`
        // is NULL and we have a prior non-NULL wielder, emit
        // `EntityDetached` so JS / paperdoll consumers can react to the
        // dequip without having to track prior state themselves.
        let mut detached_prior_wielder: Option<u32> = None;
        // Wave C / PR8 (2026-06-06): also track the new wielder on
        // non-NULL transitions so we can emit `EntityAttached` after the
        // state mutation lands. The detach path stays Wave A logic.
        let mut attached_new_wielder: Option<u32> = None;
        if property == PropertyInstanceId::Wielder {
            let item_guid_u32 = u32::from(target_guid);
            if value == Guid::NULL {
                if let Some(prior) = self.prior_wielders.remove(&item_guid_u32) {
                    detached_prior_wielder = Some(prior);
                }
            } else {
                attached_new_wielder = Some(u32::from(value));
                self.prior_wielders.insert(item_guid_u32, u32::from(value));
            }
        }

        if let Some(entity) = self.entities.get_mut(target_guid) {
            match property {
                PropertyInstanceId::Container
                    if value != Guid::NULL && target_guid != self.player.guid =>
                {
                    clear_world_presence = true;
                }
                PropertyInstanceId::Wielder => {
                    if value == Guid::NULL {
                        entity.physics_parent_id = None;
                    }

                    if value != Guid::NULL && target_guid != self.player.guid {
                        clear_world_presence = true;
                    }
                }
                _ => {}
            }
        }

        if let Some(prior_wielder_guid) = detached_prior_wielder {
            events.push(WorldEvent::EntityDetached {
                entity_guid: u32::from(target_guid),
                prior_wielder_guid,
            });
        }
        // Wave C / PR8 (2026-06-06): mirror the EntityDetached emission.
        // JS consumes this as kind=49 to drive PaperdollViewport reload
        // + 3D world rig wielded-children attach.
        if let Some(new_wielder_guid) = attached_new_wielder {
            events.push(WorldEvent::EntityAttached {
                entity_guid: u32::from(target_guid),
                new_wielder_guid,
            });
        }

        if clear_world_presence {
            self.emit_entity_world_presence_cleared(target_guid, events);
        }

        match property {
            PropertyInstanceId::Container | PropertyInstanceId::Wielder => {
                if property == PropertyInstanceId::Container {
                    if value == Guid::NULL {
                        self.clear_container_preview(target_guid);
                    } else if self.open_containers.contains(&value) {
                        self.mark_container_preview(target_guid);
                    }
                }

                self.sync_player_ownership_for_entity(target_guid);
                let _ = self.reconcile_entity_retention(target_guid);
            }
            _ => {}
        }
    }

    pub(crate) fn apply_set_state_update(
        &mut self,
        data: &SetStateData,
        events: &mut Vec<WorldEvent>,
    ) -> bool {
        use holtburger_common::properties::{ObjectDescriptionFlag, PhysicsState};
        if data.guid == self.player.guid {
            self.player.instance_sequence = data.instance_sequence;
            // Physics deep-dive 2026-06-01 (gap 3 follow-up: edge_slide).
            // A runtime physics-state announcement for the local player
            // can flip `EdgeSlide`; mirror it into `PlayerState` so the
            // local-prediction edge_slide path stays in sync (same flag
            // also hydrated into `PropertyBool::AllowEdgeSlide` below via
            // `hydrate_from_set_state`).
            self.player.allow_edge_slide = data.physics_state.contains(PhysicsState::EDGE_SLIDE);
        }

        // A7-R6 (2026-06-12): the overlap input for the ethereal-expiry
        // re-check, computed BEFORE the mutable entity borrow. Flag off:
        // never consulted.
        let recheck_overlap = crate::entity::USE_ETHEREAL_RECHECK
            && self.player_overlaps_entity_cylinder(data.guid);
        if let Some(entity) = self.entities.get_mut(data.guid) {
            let is_door = entity.flags.contains(ObjectDescriptionFlag::DOOR);
            // Capture pre-mutation should_draw so we can detect a flip
            // on the HIDDEN/NO_DRAW/CLOAKED gate after applying the new
            // physics_state. Mirrors how ACE's `WorldObject_Networking`
            // path watches PhysicsState diffs for visibility changes.
            let was_drawable = entity.should_draw();
            if crate::entity::USE_ETHEREAL_RECHECK {
                // Retail set_ethereal(0) overlap defer
                // (acclient.c:319047-319071): a door/entity solidifying
                // on top of the player stays passable until the player
                // steps clear (resolution runs in the movement tick's
                // entity arm). The WorldEvent below still reports the
                // WIRE state — the defer is collision-side only.
                entity.set_physics_state_with_ethereal_recheck(
                    data.physics_state,
                    recheck_overlap,
                );
            } else {
                entity.physics_state = data.physics_state;
            }
            let is_drawable = entity.should_draw();
            entity.properties.hydrate_from_set_state(data);
            events.push(WorldEvent::EntityStateUpdated {
                guid: data.guid,
                physics_state: data.physics_state,
            });
            if was_drawable != is_drawable {
                events.push(WorldEvent::EntityVisibilityChanged {
                    guid: data.guid,
                    visible: is_drawable,
                });
            }
            // Phase 6 step E: derive DoorState from ETHEREAL on SetState
            // updates for door-flagged entities. ACE's Door.cs::Open()
            // sets `Ethereal = true` and Door.cs::Close()/FinalizeClose()
            // clears it; both broadcast via EnqueueBroadcastPhysicsState()
            // → GameMessageSetState. Emit unconditionally (not gated on a
            // diff against the previous physics_state) so the JS state
            // map syncs on every door state announcement, including the
            // initial spawn-time state from a recv-loop reconnect.
            if is_door {
                let state = if data.physics_state.contains(PhysicsState::ETHEREAL) {
                    crate::events::DoorState::Open
                } else {
                    crate::events::DoorState::Closed
                };
                events.push(WorldEvent::DoorStateChanged {
                    guid: data.guid,
                    state,
                });
            }
            true
        } else {
            data.guid == self.player.guid
        }
    }

    pub(crate) fn handle_trade_complete(&mut self, events: &mut Vec<WorldEvent>) {
        let trade_item_guids = self.current_trade_item_guids();
        self.mark_trade_preview_entities_for_prune(&trade_item_guids);

        if let Some(trade) = self.trade.as_mut() {
            trade.self_side.accepted = false;
            trade.partner_side.accepted = false;
            trade.self_side.items.clear();
            trade.partner_side.items.clear();
            events.push(WorldEvent::TradeStateUpdated(Some(trade.clone())));
        }
    }

    pub(crate) fn register_trade(
        &mut self,
        initiator: Guid,
        partner: Guid,
        events: &mut Vec<WorldEvent>,
    ) {
        let partner_guid = if initiator == self.player.guid {
            partner
        } else {
            initiator
        };

        let trade_state = TradeState {
            partner_guid,
            initiator_guid: initiator,
            trade_stamp: 0.0,
            self_side: TradeSide {
                guid: self.player.guid,
                accepted: false,
                items: Vec::new(),
            },
            partner_side: TradeSide {
                guid: partner_guid,
                accepted: false,
                items: Vec::new(),
            },
        };

        self.trade = Some(trade_state.clone());
        events.push(WorldEvent::TradeStateUpdated(Some(trade_state)));
    }

    pub(crate) fn add_trade_item(
        &mut self,
        trade_side: u32,
        object_guid: Guid,
        events: &mut Vec<WorldEvent>,
    ) {
        let should_mark_preview = self
            .retention_snapshot(object_guid, self.current_server_time())
            .is_none_or(|snapshot| !snapshot.has_authoritative_retention());

        if let Some(trade) = self.trade.as_mut() {
            if trade_side == 0x01 {
                trade.self_side.items.push(object_guid);
            } else {
                trade.partner_side.items.push(object_guid);
            }
            trade.self_side.accepted = false;
            trade.partner_side.accepted = false;
            events.push(WorldEvent::TradeStateUpdated(Some(trade.clone())));
        }

        if should_mark_preview {
            self.mark_trade_preview(object_guid);
        }
    }

    pub(crate) fn accept_trade(&mut self, who_accepted: Guid, events: &mut Vec<WorldEvent>) {
        if let Some(trade) = self.trade.as_mut() {
            if who_accepted == self.player.guid {
                trade.self_side.accepted = true;
            } else {
                trade.partner_side.accepted = true;
            }
            events.push(WorldEvent::TradeStateUpdated(Some(trade.clone())));
        }
    }

    pub(crate) fn reset_trade(&mut self, events: &mut Vec<WorldEvent>) {
        let trade_item_guids = self.current_trade_item_guids();
        self.mark_trade_preview_entities_for_prune(&trade_item_guids);

        if let Some(trade) = self.trade.as_mut() {
            trade.self_side.accepted = false;
            trade.partner_side.accepted = false;
            trade.self_side.items.clear();
            trade.partner_side.items.clear();
            events.push(WorldEvent::TradeStateUpdated(Some(trade.clone())));
        }
    }

    pub(crate) fn clear_trade_acceptance(&mut self, events: &mut Vec<WorldEvent>) {
        if let Some(trade) = self.trade.as_mut() {
            trade.self_side.accepted = false;
            trade.partner_side.accepted = false;
            events.push(WorldEvent::TradeStateUpdated(Some(trade.clone())));
        }
    }

    pub(crate) fn close_trade(&mut self, events: &mut Vec<WorldEvent>) {
        let trade_item_guids = self.current_trade_item_guids();
        self.mark_trade_preview_entities_for_prune(&trade_item_guids);
        self.trade = None;
        events.push(WorldEvent::TradeStateUpdated(None));
    }

    pub(crate) fn current_trade_item_guids(&self) -> Vec<Guid> {
        let mut item_guids = Vec::new();

        if let Some(trade) = self.trade.as_ref() {
            item_guids.extend(trade.self_side.items.iter().copied());
            item_guids.extend(trade.partner_side.items.iter().copied());
        }

        item_guids.sort_unstable_by_key(|guid| guid.0);
        item_guids.dedup();
        item_guids
    }

    pub(crate) fn current_container_preview_item_guids(&self, container_guid: Guid) -> Vec<Guid> {
        let mut item_guids: Vec<_> = self
            .entities
            .iter()
            .filter(|entity| entity.container_id() == Some(container_guid))
            .filter(|entity| {
                self.entity_lifecycle_state(entity.guid)
                    .is_some_and(|state| state.container_preview)
            })
            .map(|entity| entity.guid)
            .collect();

        item_guids.sort_unstable_by_key(|guid| guid.0);
        item_guids.dedup();
        item_guids
    }

    pub(crate) fn mark_trade_preview_entities_for_prune(&mut self, item_guids: &[Guid]) {
        for &guid in item_guids {
            self.clear_trade_preview(guid);
            let _ = self.mark_entity_immediately_eligible_for_pruning_if_unretained(guid);
        }
    }

    pub(crate) fn mark_container_preview_entities_for_prune(&mut self, item_guids: &[Guid]) {
        let now = self.current_server_time();

        for &guid in item_guids {
            let Some(snapshot) = self.reconcile_entity_retention(guid) else {
                continue;
            };

            if snapshot.has_authoritative_retention() {
                self.clear_container_preview(guid);
                let _ = self.reconcile_entity_retention(guid);
                continue;
            }

            if let Some(entity) = self.entities.get_mut(guid) {
                entity.set_iid_prop(PropertyInstanceId::Container, Guid::NULL);
            }

            self.clear_container_preview(guid);
            self.set_entity_prune_deadline(guid, now);
        }
    }

    pub(crate) fn set_vendor_state(
        &mut self,
        data: &ApproachVendorEventData,
        events: &mut Vec<WorldEvent>,
    ) {
        let items = data
            .items
            .iter()
            .map(CoreVendorItem::from_protocol)
            .collect();

        let vendor_state = VendorState {
            vendor_guid: data.vendor_guid,
            items,
            buy_multiplier: data.buy_multiplier,
            sell_multiplier: data.sell_multiplier,
            merchandise_item_types: data.merchandise_item_types,
            alternate_currency_wcid: data.alternate_currency_wcid,
            alternate_currency_amount: data.alternate_currency_amount,
            alternate_currency_name: data.alternate_currency_name.clone(),
        };

        self.vendor = Some(vendor_state.clone());
        events.push(WorldEvent::VendorStateUpdated(Some(vendor_state)));
    }
}
