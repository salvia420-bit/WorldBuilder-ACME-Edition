//! spawnz (2026-10-18) — `?remoteSettle`: a GRAVITY creature the server left
//! floating falls onto the floor the scene holds.
//!
//! ACE's scatter spawn snaps a creature to the ground only when the drop is
//! within `ScatterThreshold_Z` = 10 m and its land cell has no building
//! (GeneratorProfile.cs:352-393 → PhysicsObj.cs:1393-1440); otherwise it
//! keeps the generator's Z, and ACE never moves an idle object, so the
//! CreateObject arrives in the air. The live log holds 771 such spawns
//! 10–67 m up (`investigate ScatterThreshold_Z`). Retail's client drops them:
//! `enter_world` places with PLACEMENT | SLIDE (acclient.c:323441 →
//! :323365), no contact leaves gravity on (`SetPositionInternal`
//! :322586-322614, `calc_acceleration` :317787) and `update_object` →
//! `UpdatePhysicsInternal` (:323081, :317701) integrates the fall.

use super::scene::RemoteCorrectionCtx;
use super::*;
use holtburger_common::position::WorldPosition;
use holtburger_common::{Guid, Quaternion, Triangle, Vector3};
use web_time::Instant;

const MOB: Guid = Guid(0x8000_B49C);
const LB: u32 = 0x0102_0000;
const TERRAIN_Z: f32 = 12.0;
const SLICE: f32 = 1.0 / 30.0;
const BOTH: u8 = LANDBLOCK_COLLISION_BUILDINGS | LANDBLOCK_COLLISION_STATICS;

/// Sets this thread's switch and restores the default (ON) on drop, even
/// when an assertion fails.
struct SettleSwitch;

impl SettleSwitch {
    fn set(on: bool) -> Self {
        set_remote_settle(on);
        Self
    }
}

impl Drop for SettleSwitch {
    fn drop(&mut self) {
        set_remote_settle(true);
    }
}

fn at(x: f32, y: f32, z: f32) -> WorldPosition {
    WorldPosition {
        landblock_id: Guid(LB),
        coords: Vector3::new(x, y, z),
        rotation: Quaternion::from_heading(0.0),
    }
    .normalize_outdoor_cell()
}

fn eligible(_: Guid) -> RemoteSettleEligibility {
    RemoteSettleEligibility::Eligible
}

/// The remote driver on and flat terrain at `TERRAIN_Z`, without the
/// landblock's buildings / statics marked.
fn bare_scene() -> SpatialScene {
    let mut scene = SpatialScene::new();
    scene.set_remote_interp_enabled(true);
    scene.populate_terrain_heights(LB, [TERRAIN_Z; 81]);
    scene
}

/// [`bare_scene`] with the landblock's buildings and statics in.
fn ready_scene() -> SpatialScene {
    let mut scene = bare_scene();
    scene.mark_landblock_collision_part(LB, BOTH);
    scene
}

/// A CreateObject: the world seeds a NEW body with a ctx-less reconcile at
/// the wire pose (`WorldState::add_entity`).
fn create(scene: &mut SpatialScene, pose: WorldPosition) {
    scene.reconcile_authoritative_body_with_remote(
        SpatialBodyId::Entity(MOB),
        pose,
        Vector3::zero(),
        Vector3::zero(),
        AuthoritativeBodySync::Snapshot,
        Instant::now(),
        None,
    );
}

/// An UpdatePosition with the local player standing on `pose` (near).
fn update_position(
    scene: &mut SpatialScene,
    pose: WorldPosition,
    sync: AuthoritativeBodySync,
    contact: Option<bool>,
) {
    scene.reconcile_authoritative_body_with_remote(
        SpatialBodyId::Entity(MOB),
        pose,
        Vector3::zero(),
        Vector3::zero(),
        sync,
        Instant::now(),
        Some(RemoteCorrectionCtx {
            contact,
            player_pose: Some(pose),
        }),
    );
}

fn body(scene: &SpatialScene) -> &SpatialBody {
    scene.body(SpatialBodyId::Entity(MOB)).expect("the mob's body")
}

fn z(scene: &SpatialScene) -> f32 {
    body(scene).pose.coords.z
}

/// Slices until the arc lands; returns the seconds stepped.
fn fall(scene: &mut SpatialScene) -> f32 {
    let mut t = 0.0;
    for _ in 0..600 {
        scene.step_remote_position_managers(SLICE);
        t += SLICE;
        if scene.remote_arc(MOB).is_none() {
            return t;
        }
    }
    panic!("the fall never landed");
}

/// The building floor helper of the D7 tests: a flat square at `z` in
/// world coordinates (LB 0x0102 → (50, 50) local is (242, 434) world).
fn roof(scene: &mut SpatialScene, z: f32) {
    let (x0, x1, y0, y1) = (236.0, 248.0, 428.0, 440.0);
    scene.insert_building_triangle(
        LB,
        Triangle::new(Vector3::new(x0, y0, z), Vector3::new(x1, y0, z), Vector3::new(x1, y1, z)),
    );
    scene.insert_building_triangle(
        LB,
        Triangle::new(Vector3::new(x0, y0, z), Vector3::new(x1, y1, z), Vector3::new(x0, y1, z)),
    );
}

/// The live-log case (an Extas Lugian 14.8 m up): the CreateObject is
/// pending; the settle starts a fall from rest that lands on the terrain at
/// the free-fall time, every slice a managed row, with LeaveGround /
/// HitGround edges for the rig's Falling and landing.
#[test]
fn floating_spawn_falls_from_rest_and_lands_on_the_terrain() {
    let _on = SettleSwitch::set(true);
    let mut scene = ready_scene();
    let h = 14.8;
    create(&mut scene, at(50.0, 50.0, TERRAIN_Z + h));
    assert!(scene.remote_settle_pending(MOB), "a CreateObject carries no contact bit");
    let _ = scene.take_remote_stepped_poses();

    assert_eq!(scene.start_remote_settles(eligible), 1);
    assert!(scene.remote_arc(MOB).is_some(), "falling");
    assert!(!scene.remote_settle_pending(MOB), "decided once");
    assert_eq!(scene.take_remote_airborne_changes(), vec![(MOB, true)], "LeaveGround → Falling");
    let (started, highest) = scene.take_remote_settle_stats();
    assert_eq!(started, 1, "the console summary counts it");
    assert!((highest - h).abs() < 1e-3, "highest drop {highest}");
    assert_eq!(scene.take_remote_settle_stats(), (0, 0.0), "taken");

    // `UpdatePhysicsInternal` moves nothing at rest (acclient.c:317729) and
    // then gains g·q (:317771-317776).
    scene.step_remote_position_managers(SLICE);
    assert_eq!(z(&scene), TERRAIN_Z + h, "the first slice only gains velocity");
    assert!(body(&scene).remote_velocity.z < 0.0);
    assert!(
        scene.take_remote_stepped_poses().iter().any(|(g, _)| *g == MOB),
        "the fall is exported as a managed row"
    );

    let t = fall(&mut scene) + SLICE;
    assert!((z(&scene) - TERRAIN_Z).abs() < 1e-4, "on the terrain: {}", z(&scene));
    let free_fall = (2.0 * h / 9.8).sqrt();
    assert!((t - free_fall).abs() <= 2.0 * SLICE, "fell in {t} s, free fall {free_fall} s");
    assert_eq!(scene.take_remote_airborne_changes(), vec![(MOB, false)], "HitGround");

    // Settled for good: no second fall, and it stays on the ground.
    assert_eq!(scene.start_remote_settles(eligible), 0);
    for _ in 0..10 {
        scene.step_remote_position_managers(SLICE);
    }
    assert!((z(&scene) - TERRAIN_Z).abs() < 1e-4);
}

/// ACE's ordinary scatter spawn (ground + 0.05) is already standing.
#[test]
fn grounded_spawn_stands_where_it_is() {
    let _on = SettleSwitch::set(true);
    let mut scene = ready_scene();
    create(&mut scene, at(50.0, 50.0, TERRAIN_Z + 0.05));
    assert_eq!(scene.start_remote_settles(eligible), 0);
    assert!(!scene.remote_settle_pending(MOB), "decided");
    assert!(scene.remote_arc(MOB).is_none());
    assert!(scene.take_remote_airborne_changes().is_empty());
    assert_eq!(z(&scene), TERRAIN_Z + 0.05);
}

/// A creature on a dock or a porch must not be dropped through a floor that
/// has not streamed in: the settle waits for the landblock's terrain,
/// buildings AND statics, and forgets them when the landblock is purged.
#[test]
fn settle_waits_for_the_landblock_collision() {
    let _on = SettleSwitch::set(true);
    let mut scene = bare_scene();
    create(&mut scene, at(50.0, 50.0, TERRAIN_Z + 6.0));
    assert!(!scene.landblock_collision_ready(LB));
    assert_eq!(scene.start_remote_settles(eligible), 0);
    assert!(scene.remote_settle_pending(MOB), "still waiting");

    scene.mark_landblock_collision_part(LB | 0x0011, LANDBLOCK_COLLISION_BUILDINGS);
    assert_eq!(scene.start_remote_settles(eligible), 0, "buildings alone are not enough");
    assert!(scene.remote_settle_pending(MOB));

    scene.mark_landblock_collision_part(LB, LANDBLOCK_COLLISION_STATICS);
    assert!(scene.landblock_collision_ready(LB | 0x0011), "keyed by landblock");
    assert_eq!(scene.start_remote_settles(eligible), 1);

    let _ = scene.clear_landblocks_collision(&[LB]);
    assert!(!scene.landblock_collision_ready(LB), "the purge drops the marks");
}

/// No terrain heights (the landblock has not streamed): nothing to land on.
#[test]
fn settle_waits_for_the_terrain() {
    let _on = SettleSwitch::set(true);
    let mut scene = SpatialScene::new();
    scene.set_remote_interp_enabled(true);
    scene.mark_landblock_collision_part(LB, BOTH);
    create(&mut scene, at(50.0, 50.0, TERRAIN_Z + 6.0));
    assert!(!scene.landblock_collision_ready(LB), "terrain is part of the residency");
    assert_eq!(scene.start_remote_settles(eligible), 0);
    assert!(scene.remote_settle_pending(MOB));

    scene.populate_terrain_heights(LB, [TERRAIN_Z; 81]);
    assert_eq!(
        scene.start_remote_settles(eligible),
        1,
        "spawn-before-terrain settles once it lands"
    );
    fall(&mut scene);
    assert!((z(&scene) - TERRAIN_Z).abs() < 1e-4);
}

/// The floor search includes building floors: a creature above a roof lands
/// on the roof, and one standing on it stays.
#[test]
fn lands_on_a_known_building_floor_not_the_terrain() {
    let _on = SettleSwitch::set(true);
    let deck = TERRAIN_Z + 5.0;

    let mut scene = ready_scene();
    roof(&mut scene, deck);
    create(&mut scene, at(50.0, 50.0, deck));
    assert_eq!(scene.start_remote_settles(eligible), 0, "standing on the roof");
    assert_eq!(z(&scene), deck);

    let mut scene = ready_scene();
    roof(&mut scene, deck);
    create(&mut scene, at(50.0, 50.0, deck + 12.0));
    assert_eq!(scene.start_remote_settles(eligible), 1);
    fall(&mut scene);
    assert!((z(&scene) - deck).abs() < 1e-4, "on the roof, not the terrain: {}", z(&scene));
}

/// A bridge or dock the landblock next door owns: `remote_ground_at` reads
/// only the body's own landblock, so within a cell of the edge the settle
/// waits for the neighbour's collision and leaves a body such a floor holds
/// where it is.
#[test]
fn a_floor_owned_by_the_next_landblock_holds_the_body() {
    let _on = SettleSwitch::set(true);
    const EAST: u32 = 0x0202_0000;
    let deck = TERRAIN_Z + 5.0;
    let edge = at(185.0, 50.0, deck); // 7 m from the east edge: world (377, 434)
    let bridge = |scene: &mut SpatialScene| {
        let (x0, x1, y0, y1) = (370.0, 390.0, 428.0, 440.0);
        let v = |x: f32, y: f32| Vector3::new(x, y, deck);
        scene.insert_building_triangle(EAST, Triangle::new(v(x0, y0), v(x1, y0), v(x1, y1)));
        scene.insert_building_triangle(EAST, Triangle::new(v(x0, y0), v(x1, y1), v(x0, y1)));
    };

    let mut scene = ready_scene();
    bridge(&mut scene);
    create(&mut scene, edge);
    assert_eq!(scene.start_remote_settles(eligible), 0, "waits for the neighbour");
    assert!(scene.remote_settle_pending(MOB));
    scene.populate_terrain_heights(EAST, [TERRAIN_Z; 81]);
    scene.mark_landblock_collision_part(EAST, BOTH);
    assert_eq!(scene.start_remote_settles(eligible), 0, "held by the neighbour's floor");
    assert!(!scene.remote_settle_pending(MOB));
    assert_eq!(z(&scene), deck);

    // Without that floor it falls as anywhere else.
    let mut scene = ready_scene();
    scene.populate_terrain_heights(EAST, [TERRAIN_Z; 81]);
    scene.mark_landblock_collision_part(EAST, BOTH);
    create(&mut scene, edge);
    assert_eq!(scene.start_remote_settles(eligible), 1);
    fall(&mut scene);
    assert!((z(&scene) - TERRAIN_Z).abs() < 1e-4);
}

/// ACE's `IsGrounded` comes from its own OnWalkable (PositionPack.cs:72): a
/// grounded UpdatePosition means the creature stands on something, even a
/// floor the scene lacks. An airborne or bit-less frame does not.
#[test]
fn a_grounded_update_position_vetoes_the_settle() {
    let _on = SettleSwitch::set(true);
    let up = at(50.0, 50.0, TERRAIN_Z + 4.0);

    let mut scene = ready_scene();
    create(&mut scene, up);
    update_position(&mut scene, up, AuthoritativeBodySync::Snapshot, Some(true));
    assert!(!scene.remote_settle_pending(MOB));
    assert_eq!(scene.start_remote_settles(eligible), 0);
    assert_eq!(z(&scene), TERRAIN_Z + 4.0);

    for contact in [Some(false), None] {
        let mut scene = ready_scene();
        create(&mut scene, up);
        update_position(&mut scene, up, AuthoritativeBodySync::Snapshot, contact);
        assert!(scene.remote_settle_pending(MOB), "{contact:?} keeps the request");
        assert_eq!(scene.start_remote_settles(eligible), 1, "{contact:?}");
    }
}

/// A teleport-stamped hard set and a far snap place the object again: it may
/// float again unless the frame says it is grounded.
#[test]
fn a_hard_set_rearms_the_settle() {
    let _on = SettleSwitch::set(true);
    let mut scene = ready_scene();
    create(&mut scene, at(50.0, 50.0, TERRAIN_Z + 3.0));
    assert_eq!(scene.start_remote_settles(eligible), 1);
    fall(&mut scene);
    assert!(!scene.remote_settle_pending(MOB));

    let up = at(60.0, 50.0, TERRAIN_Z + 7.0);
    update_position(&mut scene, up, AuthoritativeBodySync::Reset, None);
    assert_eq!(body(&scene).pose, up, "hard set");
    assert!(scene.remote_settle_pending(MOB));
    assert_eq!(scene.start_remote_settles(eligible), 1);
    fall(&mut scene);
    assert!((z(&scene) - TERRAIN_Z).abs() < 1e-4);

    update_position(&mut scene, up, AuthoritativeBodySync::Reset, Some(true));
    assert!(!scene.remote_settle_pending(MOB), "a grounded hard set stands");

    // Far snap (the local player beyond 96 m).
    scene.reconcile_authoritative_body_with_remote(
        SpatialBodyId::Entity(MOB),
        at(70.0, 50.0, TERRAIN_Z + 9.0),
        Vector3::zero(),
        Vector3::zero(),
        AuthoritativeBodySync::Snapshot,
        Instant::now(),
        Some(RemoteCorrectionCtx { contact: None, player_pose: None }),
    );
    assert!(scene.remote_settle_pending(MOB), "a far snap re-arms");
}

/// `Never` drops the request, `Wait` (hidden / frozen) keeps it.
#[test]
fn eligibility_never_drops_and_wait_keeps_the_request() {
    let _on = SettleSwitch::set(true);
    let up = at(50.0, 50.0, TERRAIN_Z + 6.0);

    let mut scene = ready_scene();
    create(&mut scene, up);
    assert_eq!(scene.start_remote_settles(|_| RemoteSettleEligibility::Never), 0);
    assert!(!scene.remote_settle_pending(MOB));
    assert_eq!(scene.start_remote_settles(eligible), 0, "dropped for good");
    assert_eq!(z(&scene), TERRAIN_Z + 6.0, "a flyer / NPC keeps its height");

    let mut scene = ready_scene();
    create(&mut scene, up);
    assert_eq!(scene.start_remote_settles(|_| RemoteSettleEligibility::Wait), 0);
    assert!(scene.remote_settle_pending(MOB), "kept while hidden");
    assert_eq!(scene.start_remote_settles(eligible), 1, "falls once it shows");
}

/// Indoors (an EnvCell) is out of scope: the floor search sees only the
/// body's own cell.
#[test]
fn indoor_bodies_are_not_settled() {
    let _on = SettleSwitch::set(true);
    let mut scene = ready_scene();
    let indoor = WorldPosition {
        landblock_id: Guid(LB | 0x0105),
        coords: Vector3::new(50.0, 50.0, TERRAIN_Z + 6.0),
        rotation: Quaternion::identity(),
    };
    create(&mut scene, indoor);
    assert_eq!(scene.start_remote_settles(eligible), 0);
    assert!(!scene.remote_settle_pending(MOB));
}

/// An interpolation node owns the body's offset while it runs (retail
/// `adjust_offset` replaces it on contact, acclient.c:389178): the settle
/// waits for it to finish, then drops the body from where it stands.
#[test]
fn an_interpolating_body_waits() {
    let _on = SettleSwitch::set(true);
    let mut scene = ready_scene();
    let up = at(50.0, 50.0, TERRAIN_Z + 6.0);
    create(&mut scene, up);
    let ahead = at(52.0, 50.0, TERRAIN_Z + 6.0);
    update_position(&mut scene, ahead, AuthoritativeBodySync::Snapshot, None);
    assert!(body(&scene).position_manager.queue_active(), "InterpolateTo queued a node");
    assert_eq!(scene.start_remote_settles(eligible), 0);
    assert!(scene.remote_settle_pending(MOB));

    let mut slices = 0;
    while body(&scene).position_manager.queue_active() {
        scene.step_remote_position_managers(SLICE);
        slices += 1;
        assert!(slices < 300, "the node never finished");
    }
    assert_eq!(scene.start_remote_settles(eligible), 1);
    fall(&mut scene);
    assert!((z(&scene) - TERRAIN_Z).abs() < 1e-4);
}

/// A body far above every floor the scene holds probably stands on
/// something the scene lacks: left alone.
#[test]
fn drops_beyond_the_cap_are_left_alone() {
    let _on = SettleSwitch::set(true);
    let mut scene = ready_scene();
    create(&mut scene, at(50.0, 50.0, TERRAIN_Z + 150.0));
    assert_eq!(scene.start_remote_settles(eligible), 0);
    assert!(!scene.remote_settle_pending(MOB));
    assert_eq!(z(&scene), TERRAIN_Z + 150.0);
}

/// `?remoteSettle=off` and `?remoteJumpArc=off` (the arc it flies) are inert.
#[test]
fn flag_off_and_jump_arc_off_are_inert() {
    let up = at(50.0, 50.0, TERRAIN_Z + 6.0);
    {
        let _off = SettleSwitch::set(false);
        let mut scene = ready_scene();
        create(&mut scene, up);
        assert_eq!(scene.start_remote_settles(eligible), 0);
        assert!(scene.remote_arc(MOB).is_none());
        for _ in 0..30 {
            scene.step_remote_position_managers(SLICE);
        }
        assert_eq!(z(&scene), TERRAIN_Z + 6.0, "the legacy float");
    }
    let _on = SettleSwitch::set(true);
    let mut scene = ready_scene();
    scene.set_remote_jump_arc_enabled(false);
    create(&mut scene, up);
    assert_eq!(scene.start_remote_settles(eligible), 0);
}

/// A jump's VectorUpdate flies its own arc; no settle on top of it.
#[test]
fn a_jump_clears_the_request() {
    let _on = SettleSwitch::set(true);
    let mut scene = ready_scene();
    create(&mut scene, at(50.0, 50.0, TERRAIN_Z + 6.0));
    scene.remote_vector_update(MOB, Vector3::new(0.0, 0.0, 3.0), true);
    assert!(scene.remote_arc(MOB).is_some());
    assert!(!scene.remote_settle_pending(MOB));
}

/// A teleport/world reset puts every body back on its wire pose
/// (`suspend_runtime_bodies`): a settled creature is pending again. A
/// rotation-only bookkeeping reconcile (`set_entity_rotation`, only off the
/// spine) is not a placement and does not re-arm.
#[test]
fn resets_rearm_but_rotation_bookkeeping_does_not() {
    let _on = SettleSwitch::set(true);
    let up = at(50.0, 50.0, TERRAIN_Z + 6.0);

    let mut scene = ready_scene();
    create(&mut scene, up);
    assert_eq!(scene.start_remote_settles(eligible), 1);
    fall(&mut scene);
    scene.suspend_runtime_bodies(Instant::now());
    assert_eq!(body(&scene).pose.coords, up.coords, "back on the wire pose");
    assert!(scene.remote_settle_pending(MOB));
    assert_eq!(scene.start_remote_settles(eligible), 1, "falls again");

    let mut scene = ready_scene();
    create(&mut scene, up);
    assert_eq!(scene.start_remote_settles(eligible), 1);
    fall(&mut scene);
    let turned = WorldPosition { rotation: Quaternion::from_heading(1.0), ..up };
    create(&mut scene, turned);
    assert!(!scene.remote_settle_pending(MOB), "rotation only: not re-armed");
}

// === World level: the eligibility answer and the per-slice wiring. ========

fn creature(pose: WorldPosition) -> crate::entity::Entity {
    use holtburger_common::properties::{ItemType, ObjectDescriptionFlag, PhysicsState, PropertyInt};
    let mut e = crate::entity::Entity::new(MOB, "Extas Lugian".to_string(), pose);
    e.physics_state = PhysicsState::GRAVITY | PhysicsState::REPORT_COLLISIONS;
    e.flags = ObjectDescriptionFlag::ATTACKABLE;
    e.properties.ints.insert(PropertyInt::ItemType, ItemType::CREATURE.bits() as i32);
    e
}

/// The weenies ACE floats (PhysicsState 0x408, Attackable by default) are
/// eligible; flyers without gravity, statics, missiles, held items, players,
/// NPCs and non-creatures are not; hidden / frozen wait.
#[test]
fn eligibility_takes_free_standing_attackable_gravity_creatures() {
    use crate::state::remote_movement::remote_settle_eligibility as eligibility;
    use holtburger_common::properties::{
        ItemType, ObjectDescriptionFlag, PhysicsState, PropertyInstanceId, PropertyInt,
    };
    use super::RemoteSettleEligibility::{Eligible, Never, Wait};

    fn with(f: impl Fn(&mut crate::entity::Entity)) -> RemoteSettleEligibility {
        let mut e = creature(at(50.0, 50.0, TERRAIN_Z));
        f(&mut e);
        crate::state::remote_movement::remote_settle_eligibility(Some(&e))
    }

    let base = creature(at(50.0, 50.0, TERRAIN_Z));
    assert_eq!(eligibility(Some(&base)), Eligible);
    assert_eq!(eligibility(None), Never);
    assert_eq!(with(|e| e.physics_state = PhysicsState::REPORT_COLLISIONS), Never, "no gravity");
    assert_eq!(with(|e| e.physics_state |= PhysicsState::STATIC), Never);
    assert_eq!(with(|e| e.physics_state |= PhysicsState::MISSILE), Never);
    assert_eq!(with(|e| e.physics_parent_id = Some(Guid(0x5000_0001))), Never, "held");
    assert_eq!(
        with(|e| e.properties.iids.insert(PropertyInstanceId::Container, Guid(0x5000_0001))),
        Never,
        "contained"
    );
    assert_eq!(with(|e| e.flags = ObjectDescriptionFlag::empty()), Never, "NPC (Attackable false)");
    assert_eq!(with(|e| e.flags |= ObjectDescriptionFlag::PLAYER), Never, "player");
    assert_eq!(
        with(|e| {
            e.properties.ints.insert(PropertyInt::ItemType, ItemType::CONTAINER.bits() as i32)
        }),
        Never,
        "corpse"
    );
    assert_eq!(with(|e| e.physics_state |= PhysicsState::HIDDEN), Wait);
    assert_eq!(with(|e| e.physics_state |= PhysicsState::FROZEN), Wait);
}

/// End to end through `WorldState`: a CreateObject (`add_entity`) of a
/// floating creature, then the world's physics slices — on and off the
/// per-object spine.
#[test]
fn world_slices_drop_a_floating_creature_onto_the_terrain() {
    let _on = SettleSwitch::set(true);
    for spine in [true, false] {
        let mut state = crate::state::WorldState::synthetic();
        state.set_remote_interp_enabled(true);
        state.scene.set_remote_spine_enabled(spine);
        state.scene.populate_terrain_heights(LB, [TERRAIN_Z; 81]);
        state.scene.mark_landblock_collision_part(LB, BOTH);
        state.add_entity(creature(at(50.0, 50.0, TERRAIN_Z + 14.8)));
        assert!(state.scene.remote_settle_pending(MOB));
        for _ in 0..90 {
            state.step_remote_objects(SLICE, Instant::now(), None);
        }
        let landed = state.scene.body(SpatialBodyId::Entity(MOB)).unwrap().pose;
        assert!((landed.coords.z - TERRAIN_Z).abs() < 1e-4, "spine {spine}: z {}", landed.coords.z);
        assert!(state.scene.remote_arc(MOB).is_none(), "spine {spine}");
    }
}

// === Real data (DAT-gated): spawns from the live ACE log. ==================

fn portal_dat_path() -> String {
    std::env::var("HOLTBURGER_PORTAL_DAT")
        .unwrap_or_else(|_| "/home/wbterminal/ac_base_dats/client_portal.dat".to_string())
}

fn cell_dat_path() -> String {
    std::env::var("HOLTBURGER_CELL_DAT")
        .unwrap_or_else(|_| "/home/wbterminal/ac_base_dats/client_cell_1.dat".to_string())
}

/// The JS `terrainHeightAt` / render sampler (lib.rs `terrain_height_at`):
/// the retail per-cell split on the 9×9 grid, landblock-local metres.
fn sample(heights: &[f32; 81], lb: u32, x: f32, y: f32) -> f32 {
    use holtburger_dat::terrain_subdiv::{cell_swto_ne_cut, triangle_height_in_cell};
    let cx = (x / 24.0).clamp(0.0, 8.0);
    let cy = (y / 24.0).clamp(0.0, 8.0);
    let x0 = (cx.floor() as usize).min(7);
    let y0 = (cy.floor() as usize).min(7);
    let h = |vx: usize, vy: usize| heights[vx * 9 + vy];
    let gx = ((lb >> 24) & 0xFF) * 8 + x0 as u32;
    let gy = ((lb >> 16) & 0xFF) * 8 + y0 as u32;
    triangle_height_in_cell(
        h(x0, y0),
        h(x0 + 1, y0),
        h(x0, y0 + 1),
        h(x0 + 1, y0 + 1),
        cx - x0 as f32,
        cy - y0 as f32,
        cell_swto_ne_cut(gx, gy),
    )
}

/// Three of the 771 floating spawns in the live ACE log (2026-10-17,
/// `SetScatterPositionInternal() - tried to spawn outdoor object @ … ground Z
/// … investigate ScatterThreshold_Z`). ACE sent each at the generator's Z;
/// its logged ground is `GetZ + 0.05`. With the real cell DAT and the
/// Region's `LandHeightTable`, (1) our sampler agrees with ACE's ground — the
/// creature really is in the air, our terrain is not low — and (2) the
/// settle lands a CreateObject at the logged Z on that ground. (3) Above
/// 400 m the table is not `byte * 2` (index 201+): the `* 2` fallback would
/// put the Magma Golem's ground 25.9 m too low.
#[test]
fn ace_logged_floating_spawns_settle_onto_the_retail_terrain() {
    use holtburger_dat::DatDatabase;
    use holtburger_dat::file_type::Region;
    use holtburger_dat::landblock::CellLandblock;
    let _on = SettleSwitch::set(true);
    let (Ok(portal), Ok(cell)) =
        (DatDatabase::new(portal_dat_path()), DatDatabase::new(cell_dat_path()))
    else {
        eprintln!("SKIP ace_logged_floating_spawns_settle_onto_the_retail_terrain: no DATs");
        return;
    };
    let region_bytes = portal.get_file(0x1300_0000).expect("Region");
    let region = Region::unpack(&mut std::io::Cursor::new(region_bytes)).expect("Region unpack");
    let table = region.land_defs.land_height_table;
    assert_eq!(table.len(), 256);
    assert_eq!(table[200], 400.0, "byte * 2 up to index 200");
    assert_eq!(table[201], 404.0, "not byte * 2 from index 201");

    // (name, wire cell, x, y, z sent, ACE's logged ground = GetZ + 0.05)
    let cases = [
        ("Extas Lugian", 0xA120_0036u32, 154.75696f32, 124.60624f32, 354.05f32, 339.22357f32),
        ("Magma Golem", 0xA31F_000E, 39.944733, 130.29646, 464.05002, 451.82806),
        ("Altered Drudge", 0xA11D_000C, 33.233772, 82.62203, 404.05, 391.01047),
    ];
    for (name, cell_id, x, y, z_sent, ace_ground) in cases {
        let lb = cell_id & 0xFFFF_0000;
        let land_bytes = cell.get_file(lb | 0xFFFF).expect("LandBlock");
        let land = CellLandblock::unpack(&land_bytes).expect("unpack");
        let mut heights = [0f32; 81];
        let mut heights_x2 = [0f32; 81];
        for vx in 0..9 {
            for vy in 0..9 {
                heights[vx * 9 + vy] = land.get_height_with_table(vx, vy, Some(table.as_slice()));
                heights_x2[vx * 9 + vy] = land.get_height(vx, vy);
            }
        }
        let ground = ace_ground - 0.05;
        let ours = sample(&heights, lb, x, y);
        assert!((ours - ground).abs() < 1e-3, "{name}: ours {ours} vs ACE {ground}");
        assert!(z_sent - ground > 10.0, "{name}: sent {} m up", z_sent - ground);
        if name == "Magma Golem" {
            let x2 = sample(&heights_x2, lb, x, y);
            assert!(ground - x2 > 20.0, "{name}: byte*2 ground {x2} vs {ground}");
        }

        let mut scene = SpatialScene::new();
        scene.set_remote_interp_enabled(true);
        scene.populate_terrain_heights(lb, heights);
        scene.mark_landblock_collision_part(lb, BOTH);
        create(
            &mut scene,
            WorldPosition {
                landblock_id: Guid(cell_id),
                coords: Vector3::new(x, y, z_sent),
                rotation: Quaternion::identity(),
            },
        );
        assert_eq!(scene.start_remote_settles(eligible), 1, "{name}");
        fall(&mut scene);
        // The scene samples world coords (f32 at ~31 km: ~2 mm steps).
        assert!((z(&scene) - ground).abs() < 1e-2, "{name}: landed at {} vs {ground}", z(&scene));
    }
}
