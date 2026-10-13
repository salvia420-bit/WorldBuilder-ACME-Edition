//! physics-collision-2 (2026-10-13) — the local player's transition body from
//! its OWN Setup (`transition::mover_body_from_setup`,
//! `WorldState::setup_mover_body`).
//!
//! Retail builds every mover's transition from its Setup:
//! `CPhysicsObj::transition` (acclient.c:320061-320102) inits the sphere path
//! with the Setup's first `min(2, n)` spheres × `m_scale`
//! (`SPHEREPATH::init_sphere`, :313647) or the `dummy_sphere`, and
//! `OBJECTINFO::init` (:314118-314129) caches `setup->step_*_height ×
//! scale.z` (:325400-325424). Before this the local player always swept as
//! the human Setup `0x02000001`, whatever its heritage or scale.
//!
//! The human Setup must stay BYTE-IDENTICAL: the synthetic pin below uses the
//! DAT's own floats, and a DAT-gated test re-derives the body from the real
//! `client_portal.dat` records (skips when the base dats are absent).

use super::obj_collision::SetupCollisionShapes;
use super::scenery::SetupCylSphere;
use super::transition::{
    ObjectInfo, PLAYER_SETUP_HEIGHT, PLAYER_SETUP_SPHERE_HIGH_Z, PLAYER_SETUP_SPHERE_LOW_Z,
    PLAYER_SETUP_SPHERE_RADIUS, SetupMoverBody, mover_body_from_setup, scaled_setup_step_heights,
};
use super::{PLAYER_STEP_DOWN_HEIGHT, PLAYER_STEP_UP_HEIGHT};
use crate::WorldState;
use crate::entity::Entity;
use holtburger_common::position::WorldPosition;
use holtburger_common::properties::{
    PropertyDataId, PropertyFloat, WorldObjectPropertyAccessorsMut as _,
};
use holtburger_common::{Guid, Sphere, Vector3};

const HUMAN_SETUP: u32 = 0x0200_0001;
const PLAYER: Guid = Guid(0x5000_0001);

fn sphere(z: f32, r: f32) -> Sphere {
    Sphere {
        center: Vector3::new(0.0, 0.0, z),
        radius: r,
    }
}

/// Setup `0x02000001` as `record_setup_shapes_pending` stages it — the
/// literal values are the DAT's floats (dumped from the base
/// `client_portal.dat` 2026-10-13: `3333f33e` 0.475, `cdccac3f` 1.35,
/// `8fc2f53e` 0.48, step `9a99193f` 0.6 / `0000c03f` 1.5, height
/// `48e1ea3f` 1.835).
fn human_shapes() -> SetupCollisionShapes {
    SetupCollisionShapes {
        cylspheres: Vec::new(),
        spheres: vec![sphere(0.475, 0.48), sphere(1.35, 0.48)],
        step_heights: Some((0.6, 1.5)),
    }
}

fn bits(body: &SetupMoverBody) -> [u32; 8] {
    [
        body.capsule[0].0.to_bits(),
        body.capsule[0].1.to_bits(),
        body.capsule[1].0.to_bits(),
        body.capsule[1].1.to_bits(),
        body.radius.to_bits(),
        body.height.to_bits(),
        body.step_up_height.to_bits(),
        body.step_down_height.to_bits(),
    ]
}

/// (a) The byte-identical guard: Setup `0x02000001` at scale 1.0 is exactly
/// the `PLAYER_SETUP_*` / `PLAYER_STEP_*` constants, and applying it to
/// `for_local_player`'s description changes nothing.
#[test]
fn human_setup_body_is_the_player_constants_bit_for_bit() {
    let body = mover_body_from_setup(Some(&human_shapes()), Some(1.835), 1.0);
    assert_eq!(bits(&body), bits(&SetupMoverBody::HUMAN));
    assert_eq!(
        body.capsule,
        [
            (PLAYER_SETUP_SPHERE_LOW_Z, PLAYER_SETUP_SPHERE_RADIUS),
            (PLAYER_SETUP_SPHERE_HIGH_Z, PLAYER_SETUP_SPHERE_RADIUS),
        ]
    );
    assert_eq!(body.radius.to_bits(), PLAYER_SETUP_SPHERE_RADIUS.to_bits());
    assert_eq!(body.height.to_bits(), PLAYER_SETUP_HEIGHT.to_bits());
    assert_eq!(body.step_up_height.to_bits(), PLAYER_STEP_UP_HEIGHT.to_bits());
    assert_eq!(body.step_down_height.to_bits(), PLAYER_STEP_DOWN_HEIGHT.to_bits());

    // No `CSetup::height` on record: the fallback still lands on 1.835.
    let no_height = mover_body_from_setup(Some(&human_shapes()), None, 1.0);
    assert_eq!(bits(&no_height), bits(&SetupMoverBody::HUMAN));

    let base = ObjectInfo::for_local_player(None, None, true, PLAYER);
    let mut applied = base;
    applied.apply_setup_body(&body);
    assert_eq!(applied, base, "the human Setup changes no ObjectInfo field");
}

/// (b) A scaled Setup scales sphere centres, radii, height and both step
/// heights (`init_sphere(.., m_scale)`; `GetStepUpHeight` × scale.z).
#[test]
fn scale_multiplies_spheres_height_and_step_heights() {
    let s = 1.2_f32;
    let body = mover_body_from_setup(Some(&human_shapes()), Some(1.835), s);
    assert_eq!(body.capsule, [(0.475 * s, 0.48 * s), (1.35 * s, 0.48 * s)]);
    assert_eq!(body.radius, 0.48 * s);
    assert_eq!(body.height, 1.835 * s);
    assert_eq!((body.step_up_height, body.step_down_height), (0.6 * s, 1.5 * s));
    assert_ne!(body, SetupMoverBody::HUMAN);

    // A non-finite / non-positive scale is treated as 1.0.
    for bad in [0.0_f32, -1.0, f32::NAN, f32::INFINITY] {
        let b = mover_body_from_setup(Some(&human_shapes()), Some(1.835), bad);
        assert_eq!(bits(&b), bits(&SetupMoverBody::HUMAN), "scale {bad}");
    }
}

/// (c) No resident Setup: the human constants, whatever the scale.
#[test]
fn unresolved_setup_keeps_the_human_body() {
    assert_eq!(mover_body_from_setup(None, None, 1.0), SetupMoverBody::HUMAN);
    assert_eq!(mover_body_from_setup(None, Some(3.0), 2.0), SetupMoverBody::HUMAN);
}

/// (d) `SPHEREPATH::init_sphere` takes the FIRST two spheres in Setup order —
/// not sorted by z (the remote path's approximation), and a third is dropped.
#[test]
fn first_two_spheres_in_setup_order() {
    let shapes = SetupCollisionShapes {
        cylspheres: Vec::new(),
        spheres: vec![sphere(1.6, 0.7), sphere(0.7, 0.6), sphere(3.0, 0.9)],
        step_heights: Some((0.9, 2.0)),
    };
    let body = mover_body_from_setup(Some(&shapes), Some(2.4), 1.0);
    assert_eq!(body.capsule, [(1.6, 0.7), (0.7, 0.6)], "Setup order, third dropped");
    assert_eq!(body.radius, 0.7);
    assert_eq!(body.height, 2.4);
    assert_eq!((body.step_up_height, body.step_down_height), (0.9, 2.0));
}

/// One sphere fills both slots; none ⇒ retail's `dummy_sphere` (r 0.1 at
/// z 0.1, scale 1.0) — NOT a cylsphere-derived capsule.
#[test]
fn one_sphere_doubles_and_no_sphere_is_the_dummy_sphere() {
    let one = SetupCollisionShapes {
        cylspheres: Vec::new(),
        spheres: vec![sphere(0.5, 0.5)],
        step_heights: Some((0.6, 1.5)),
    };
    let body = mover_body_from_setup(Some(&one), None, 2.0);
    assert_eq!(body.capsule, [(1.0, 1.0), (1.0, 1.0)]);

    let cyl_only = SetupCollisionShapes {
        cylspheres: vec![SetupCylSphere {
            origin: Vector3::zero(),
            radius: 1.0,
            height: 3.0,
        }],
        spheres: Vec::new(),
        step_heights: Some((0.6, 1.5)),
    };
    let body = mover_body_from_setup(Some(&cyl_only), Some(3.0), 2.0);
    assert_eq!(body.capsule, [(0.1, 0.1), (0.1, 0.1)], "dummy sphere, unscaled");
    assert_eq!(body.radius, 0.1);
    assert_eq!((body.step_up_height, body.step_down_height), (1.2, 3.0));
}

/// A corrupt sphere record or step pair keeps the human values for that half.
#[test]
fn unusable_records_fall_back_per_half() {
    let shapes = SetupCollisionShapes {
        cylspheres: Vec::new(),
        spheres: vec![sphere(0.5, 0.0), sphere(1.0, 0.5)],
        step_heights: Some((f32::NAN, 1.0)),
    };
    let body = mover_body_from_setup(Some(&shapes), Some(2.0), 1.0);
    assert_eq!(body.capsule, SetupMoverBody::HUMAN.capsule);
    assert_eq!(
        (body.step_up_height, body.step_down_height),
        (PLAYER_STEP_UP_HEIGHT, PLAYER_STEP_DOWN_HEIGHT)
    );
    assert_eq!(scaled_setup_step_heights(&shapes, 1.0), None);
    let unrecorded = SetupCollisionShapes { step_heights: None, ..human_shapes() };
    assert_eq!(scaled_setup_step_heights(&unrecorded, 2.0), None);
    assert_eq!(scaled_setup_step_heights(&human_shapes(), 2.0), Some((1.2, 3.0)));
}

/// `WorldState::setup_mover_body` resolves the entity's Setup DID, its
/// `DefaultScale` and the Setup's `CSetup::height`; `None` until resident.
#[test]
fn world_resolves_the_entity_setup_body() {
    const OLTHOI: u32 = 0x0200_1A21;
    let mut world = WorldState::synthetic();
    world.seed_local_player_entity(PLAYER, "Player", WorldPosition::default());
    assert_eq!(world.setup_mover_body(PLAYER), None, "no Setup DID");
    assert_eq!(world.setup_mover_body(Guid(0x8000_9999)), None, "unknown guid");

    {
        let e = world.entities.get_mut(PLAYER).unwrap();
        e.set_did_prop(PropertyDataId::Setup, Guid(OLTHOI));
        e.set_float_prop(PropertyFloat::DefaultScale, 1.5);
    }
    assert_eq!(world.setup_mover_body(PLAYER), None, "Setup not parsed yet");

    // Setup 0x02001A21's DAT values (client_portal.dat, 2026-10-13).
    world.scene.register_setup_collision_shapes(
        OLTHOI,
        SetupCollisionShapes {
            cylspheres: Vec::new(),
            spheres: vec![sphere(0.65, 0.65), sphere(1.68, 0.65)],
            step_heights: Some((0.942, 0.942)),
        },
    );
    world.register_setup_part_dims(OLTHOI, 0.919_238_8, 2.33);
    let body = world.setup_mover_body(PLAYER).expect("resident Setup");
    assert_eq!(body.capsule, [(0.65 * 1.5, 0.65 * 1.5), (1.68 * 1.5, 0.65 * 1.5)]);
    assert_eq!(body.height, 2.33 * 1.5);
    assert_eq!((body.step_up_height, body.step_down_height), (0.942 * 1.5, 0.942 * 1.5));

    // The human Setup through the same resolver: the constants.
    let mut human = Entity::new(Guid(0x5000_0002), "Human".to_string(), WorldPosition::default());
    human.set_did_prop(PropertyDataId::Setup, Guid(HUMAN_SETUP));
    world.entities.insert(human);
    world.scene.register_setup_collision_shapes(HUMAN_SETUP, human_shapes());
    world.register_setup_part_dims(HUMAN_SETUP, 0.678_822_5, 1.835);
    let body = world.setup_mover_body(Guid(0x5000_0002)).unwrap();
    assert_eq!(bits(&body), bits(&SetupMoverBody::HUMAN));
}

fn portal_dat_path() -> String {
    std::env::var("HOLTBURGER_PORTAL_DAT")
        .unwrap_or_else(|_| "/home/wbterminal/ac_base_dats/client_portal.dat".to_string())
}

/// Real data: the body derived from the base `client_portal.dat` records,
/// staged exactly as `record_setup_shapes_pending` stages them. Human male
/// `0x02000001` and human female `0x0200004E` are the constants bit for bit;
/// Olthoi `0x02001A21` is not (WebAC's cited step_down 0.942 confirmed).
/// DAT-gated: skips when the base dats are absent.
#[test]
fn real_dat_player_setups() {
    use holtburger_dat::DatDatabase;
    use holtburger_dat::file_type::SetupModel;
    let Ok(portal) = DatDatabase::new(portal_dat_path()) else {
        eprintln!("SKIP real_dat_player_setups: base dats unavailable");
        return;
    };
    let body_of = |id: u32| -> SetupMoverBody {
        let bytes = portal.get_file(id).expect("Setup record");
        let setup = SetupModel::unpack(&mut std::io::Cursor::new(&bytes)).expect("Setup parse");
        let shapes = SetupCollisionShapes {
            cylspheres: setup
                .cyl_spheres
                .iter()
                .map(|c| SetupCylSphere {
                    origin: c.origin,
                    radius: c.radius,
                    height: c.height,
                })
                .collect(),
            spheres: setup.spheres.clone(),
            step_heights: Some((setup.step_up, setup.step_down)),
        };
        mover_body_from_setup(Some(&shapes), Some(setup.height), 1.0)
    };
    for id in [HUMAN_SETUP, 0x0200_004E] {
        assert_eq!(bits(&body_of(id)), bits(&SetupMoverBody::HUMAN), "Setup {id:#010x}");
    }
    let olthoi = body_of(0x0200_1A21);
    assert_ne!(olthoi, SetupMoverBody::HUMAN);
    assert_eq!(olthoi.step_down_height, 0.942);
    assert_eq!(olthoi.capsule, [(0.65, 0.65), (1.68, 0.65)]);
}
