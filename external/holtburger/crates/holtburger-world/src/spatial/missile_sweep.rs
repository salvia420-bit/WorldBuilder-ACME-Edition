//! physics-collision-1 (2026-10-13) — a self-integrated ballistic missile
//! swept against the solid OBJECTS in its path: creatures, players, chests,
//! dynamic props. The object layer of `scene3d/projectile_sweep.js`
//! (wasm `sweepSphereAgainstObjects`); walls, cells and doors are the other
//! layers.
//!
//! Retail runs every active missile through a `CTransition`
//! (`CPhysicsObj::UpdateObjectInternal` → `transition()`, acclient.c:322812)
//! whose `CObjCell::find_obj_collisions` (:347142) hands every unparented
//! shadow object to `CPhysicsObj::FindObjCollisions` (:316159):
//!
//! * `OBJECTINFO::missile_ignore` (:314070-314093) ignores a MISSILE collider
//!   and — for a missile mover whose collider is not `targetID` — an ETHEREAL
//!   one, or a creature when `targetID != 0`. The client only ever writes
//!   `targetID = 0` (`CTransition::init` :311603, the ctor :312155), so on
//!   the client NO creature is exempt: the target, bystanders, other players
//!   and the local player all stop a missile. (ACE's server sets `TargetID`
//!   = `ProjectileTarget`, so ITS bolt passes non-targets; the retail client
//!   still stopped the bolt on the first body in its path.)
//! * The player-vs-player exemption (:316214-316225) needs the mover's
//!   `IS_PLAYER` object-info bit, which a missile never carries.
//! * An ETHEREAL collider — or ANY non-STATIC collider when the missile
//!   itself is ETHEREAL (ACE Rolling Death, SpellProjectile.cs:82-84, or
//!   every bolt under `spell_projectile_ethereal`) — is
//!   `obstruction_ethereal` and resolves OK_TS (:316201-316212,
//!   :316296-316302): it never stops the missile.
//! * A HAS_PHYSICS_BSP object collides by its BSP alone (:316229) — the door
//!   layer (`sweepSphereAgainstEntities`) — so it is skipped here. Every
//!   other object collides by its Setup cylspheres, else its spheres
//!   (:316235-316276), at `m_position` × `m_scale`.
//!
//! The object view (client body pose, `obj_scale`, Setup shapes, the
//! unresolved-Setup cylinder fallback) is
//! [`super::transition::obj_collider_for_entity`] — the same one the local
//! player's transition collides with.

use holtburger_common::properties::WorldObjectExt as _;
use holtburger_common::{Guid, Vector3};

use super::GenericSweptHit;
use super::obj_collision::{ObjCollider, physics_state as ps};
use super::scenery::{
    SetupSphere, cylsphere_collides_with_sphere, cylsphere_to_world, cylsphere_z_slab_overlap,
    sphere_collides_with_sphere, sphere_to_world, sweep_sphere_against_cylsphere,
    sweep_sphere_against_sphere,
};
use super::transition::obj_collider_for_entity;
use crate::WorldState;

/// Does a collider in PhysicsState `state` stop a missile in PhysicsState
/// `missile_state` on this layer? `missile_ignore` (MISSILE, ETHEREAL),
/// `obstruction_ethereal` for an ETHEREAL missile (only STATIC objects
/// still stop it), and HAS_PHYSICS_BSP objects are the door layer's.
pub fn missile_object_layer_collides(state: u32, missile_state: u32) -> bool {
    if state & (ps::MISSILE | ps::ETHEREAL) != 0 {
        return false;
    }
    if missile_state & ps::ETHEREAL != 0 && state & ps::STATIC == 0 {
        return false;
    }
    state & ps::HAS_PHYSICS_BSP == 0
}

/// Earliest contact `(t, unit normal)` of the moving sphere with one
/// object's primitives — its cylspheres when the Setup has any, else its
/// spheres (`FindObjCollisions` :316235-316276).
///
/// A sphere that STARTS inside a primitive is a contact at `t = 0` only when
/// it is moving inward (the outward normal is returned so the JS
/// embedded-start rule can judge the launch window); moving out or along,
/// it passes. Without this the swept solves — which take the far root for an
/// overlapping start (acclient.c:361832) — would report the EXIT as a hit.
fn sweep_collider(
    c: &ObjCollider,
    start: Vector3,
    delta: Vector3,
    radius: f32,
) -> Option<(f32, Vector3)> {
    let mut best: Option<(f32, Vector3)> = None;
    let mut take = |t: f32, n: Vector3| {
        if best.is_none_or(|(bt, _)| t < bt) {
            best = Some((t, n));
        }
    };
    if !c.shapes.cylspheres.is_empty() {
        for cyl in &c.shapes.cylspheres {
            let w = cylsphere_to_world(cyl, c.scale, c.origin, c.orientation);
            if cylsphere_collides_with_sphere(&w, start, radius) {
                let out = Vector3::new(start.x - w.low_pt.x, start.y - w.low_pt.y, 0.0);
                let len = out.length();
                if len > 1e-6 && out.dot(&delta) < 0.0 {
                    take(0.0, out * (1.0 / len));
                }
                continue;
            }
            let Some(hit) = sweep_sphere_against_cylsphere(&w, start, delta, radius) else {
                continue;
            };
            // Wall hits get the Z-slab veto at the contact (scene.rs
            // `sweep_sphere_against_scenery`); the cap solve already
            // re-asserts the XY circle.
            if hit.normal.z == 0.0
                && !cylsphere_z_slab_overlap(&w, start.z + delta.z * hit.t, radius)
            {
                continue;
            }
            take(hit.t, hit.normal);
        }
    } else {
        for s in &c.shapes.spheres {
            let local = SetupSphere {
                center: s.center,
                radius: s.radius,
            };
            let (center, r) = sphere_to_world(&local, c.scale, c.origin, c.orientation);
            if sphere_collides_with_sphere(center, r, start, radius) {
                let out = start - center;
                let len = out.length();
                if len > 1e-6 && out.dot(&delta) < 0.0 {
                    take(0.0, out * (1.0 / len));
                }
                continue;
            }
            if let Some(hit) = sweep_sphere_against_sphere(center, r, start, delta, radius) {
                take(hit.t, hit.normal);
            }
        }
    }
    best
}

impl WorldState {
    /// physics-collision-1: sweep a missile's sphere of `radius` from
    /// `start` to `end` (world metres) against every solid object near the
    /// segment (see the module doc for the retail rules), returning the
    /// earliest contact. `missile_guid` is the missile itself (never a
    /// collider); `missile_state` its PhysicsState; `exempt_local_player`
    /// leaves the local player's body out — the caller's own-launch rule
    /// (ACE spawns a bolt in front of the SERVER-side caster pose, which a
    /// running/fast-casting predicted player can be ahead of).
    ///
    /// Skipped as never in the world: parented objects (`find_obj_collisions`
    /// skips them) and contained ones (no landblock, or a container).
    pub fn sweep_missile_against_objects(
        &self,
        start: Vector3,
        end: Vector3,
        radius: f32,
        missile_guid: Guid,
        missile_state: u32,
        exempt_local_player: bool,
    ) -> Option<GenericSweptHit> {
        let delta = end - start;
        let len = delta.length();
        if !(len > 1e-6) || !(radius > 0.0) {
            return None;
        }
        let player = self.player.guid;
        // Any primitive the swept sphere can touch has its origin within
        // |segment| + radius (+ its own extent, which the collider adds) of
        // `start` in XY.
        let reach = len + radius;
        let mut best: Option<(f32, Vector3)> = None;
        for e in self.entities.iter() {
            if e.guid == missile_guid
                || (exempt_local_player && e.guid == player)
                || e.physics_parent_id.is_some()
                || e.position.landblock_id == Guid::NULL
                || e.container_id().is_some()
                || !missile_object_layer_collides(e.physics_state.bits(), missile_state)
            {
                continue;
            }
            let Some(c) = obj_collider_for_entity(self, e, start, reach) else {
                continue;
            };
            if let Some((t, n)) = sweep_collider(&c, start, delta, radius)
                && best.is_none_or(|(bt, _)| t < bt)
            {
                best = Some((t, n));
            }
        }
        let (t, normal) = best?;
        Some(GenericSweptHit {
            t,
            point: start + delta * t,
            normal,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::entity::Entity;
    use crate::spatial::obj_collision::SetupCollisionShapes;
    use crate::spatial::scenery::SetupCylSphere;
    use holtburger_common::position::WorldPosition;
    use holtburger_common::properties::PhysicsState;
    use holtburger_common::{Quaternion, Sphere};

    const CREATURE_SETUP: u32 = 0x0200_0964;
    const CHEST_SETUP: u32 = 0x0200_0A11;
    const HUMAN_SETUP: u32 = 0x0200_0001;
    const UNPARSED_SETUP: u32 = 0x0200_0ABC;
    const PLAYER: Guid = Guid(0x5000_0001);
    const MISSILE: Guid = Guid(0x8000_0999);
    const R: f32 = 0.1;

    fn pose_at(x: f32, y: f32, z: f32) -> WorldPosition {
        WorldPosition {
            landblock_id: Guid(0x1234_0000),
            coords: Vector3::new(x, y, z),
            rotation: Quaternion::identity(),
        }
    }

    fn world_at(x: f32, y: f32, z: f32) -> Vector3 {
        pose_at(x, y, z).global_coords()
    }

    /// A world with a radius-0.5 / height-2 creature cylinder at (50, 50, 0)
    /// and a two-sphere human Setup registered.
    fn world_with_creature(state: PhysicsState) -> WorldState {
        let mut world = WorldState::synthetic();
        world.scene.register_setup_collision_shapes(
            CREATURE_SETUP,
            SetupCollisionShapes {
                cylspheres: vec![SetupCylSphere {
                    origin: Vector3::zero(),
                    radius: 0.5,
                    height: 2.0,
                }],
                spheres: Vec::new(),
                ..Default::default()
            },
        );
        world.scene.register_setup_collision_shapes(
            HUMAN_SETUP,
            SetupCollisionShapes {
                cylspheres: Vec::new(),
                spheres: vec![
                    Sphere {
                        center: Vector3::new(0.0, 0.0, 0.475),
                        radius: 0.48,
                    },
                    Sphere {
                        center: Vector3::new(0.0, 0.0, 1.35),
                        radius: 0.48,
                    },
                ],
                ..Default::default()
            },
        );
        let mut c = Entity::new(Guid(0x8000_0042), "Drudge".to_string(), pose_at(50.0, 50.0, 0.0));
        c.gfx_id = Some(CREATURE_SETUP);
        c.physics_state = state;
        world.entities.insert(c);
        world
    }

    /// A bolt at chest height flying +x from 45 to 55 m through the
    /// creature at x = 50.
    fn sweep(world: &WorldState, missile_state: u32, exempt: bool) -> Option<GenericSweptHit> {
        world.sweep_missile_against_objects(
            world_at(45.0, 50.0, 1.0),
            world_at(55.0, 50.0, 1.0),
            R,
            MISSILE,
            missile_state,
            exempt,
        )
    }

    /// Contact where the sphere's surface meets the cylinder wall:
    /// x = 50 - (0.5 + 0.1) over a 10 m segment from 45 → t = 0.44.
    #[test]
    fn a_creature_cylsphere_on_the_path_stops_the_missile_at_its_wall() {
        let world = world_with_creature(PhysicsState::NONE);
        let hit = sweep(&world, 0, false).expect("the creature stops the bolt");
        assert!((hit.t - 0.44).abs() < 1e-3, "t = {}", hit.t);
        assert!(hit.normal.x < -0.99, "normal faces the bolt: {:?}", hit.normal);
        let p = world_at(50.0 - 0.6, 50.0, 1.0);
        assert!((hit.point.x - p.x).abs() < 1e-2, "contact x {} vs {}", hit.point.x, p.x);
    }

    #[test]
    fn ethereal_missile_and_parented_colliders_are_skipped() {
        for state in [PhysicsState::ETHEREAL, PhysicsState::MISSILE] {
            let world = world_with_creature(state);
            assert!(sweep(&world, 0, false).is_none(), "{state:?} collider passes");
        }
        let mut world = world_with_creature(PhysicsState::NONE);
        let creature = world.entities.get_mut(Guid(0x8000_0042)).unwrap();
        creature.physics_parent_id = Some(Guid(0x8000_0007));
        assert!(sweep(&world, 0, false).is_none(), "a parented object is not in a cell");
    }

    /// retail obstruction_ethereal: an ETHEREAL missile passes every
    /// non-STATIC object, a STATIC one still stops it.
    #[test]
    fn an_ethereal_missile_passes_non_static_objects_only() {
        let world = world_with_creature(PhysicsState::NONE);
        assert!(sweep(&world, ps::ETHEREAL, false).is_none());
        let world = world_with_creature(PhysicsState::STATIC);
        assert!(sweep(&world, ps::ETHEREAL, false).is_some(), "STATIC still obstructs");
        assert!(missile_object_layer_collides(ps::STATIC, ps::ETHEREAL | ps::MISSILE));
        assert!(!missile_object_layer_collides(0, ps::ETHEREAL | ps::MISSILE));
        assert!(!missile_object_layer_collides(ps::HAS_PHYSICS_BSP, 0), "the door layer's");
        assert!(missile_object_layer_collides(ps::IGNORE_COLLISIONS, 0), "IGNORE alone blocks");
    }

    #[test]
    fn the_missile_itself_never_collides() {
        let world = world_with_creature(PhysicsState::NONE);
        let hit = world.sweep_missile_against_objects(
            world_at(45.0, 50.0, 1.0),
            world_at(55.0, 50.0, 1.0),
            R,
            Guid(0x8000_0042),
            0,
            false,
        );
        assert!(hit.is_none(), "own guid skipped");
    }

    /// A non-creature object with spheres (a chest) stops the bolt too —
    /// the rule is every solid object, not just creatures.
    #[test]
    fn a_sphere_object_stops_the_missile() {
        let mut world = WorldState::synthetic();
        world.scene.register_setup_collision_shapes(
            CHEST_SETUP,
            SetupCollisionShapes {
                cylspheres: Vec::new(),
                spheres: vec![Sphere {
                    center: Vector3::new(0.0, 0.0, 1.0),
                    radius: 0.4,
                }],
                ..Default::default()
            },
        );
        let mut chest = Entity::new(Guid(0x7A9B_4001), "Chest".into(), pose_at(50.0, 50.0, 0.0));
        chest.gfx_id = Some(CHEST_SETUP);
        world.entities.insert(chest);
        let hit = sweep(&world, 0, false).expect("the chest stops the bolt");
        // Sphere radsum 0.4 + 0.1 - EPS: x ≈ 49.5 → t ≈ 0.45.
        assert!((hit.t - 0.45).abs() < 1e-3, "t = {}", hit.t);
        assert!(hit.normal.x < -0.99);
    }

    /// The local player (its own two-sphere Setup) stops a monster's bolt,
    /// unless the caller exempts it (our own launch).
    #[test]
    fn the_local_player_stops_a_far_spawned_bolt_unless_exempt() {
        let mut world = world_with_creature(PhysicsState::ETHEREAL);
        world.seed_local_player_entity(PLAYER, "Me", pose_at(50.0, 50.0, 0.0));
        world.player_entity_mut().unwrap().gfx_id = Some(HUMAN_SETUP);
        let hit = sweep(&world, 0, false).expect("the player's body stops it");
        // Upper sphere centre z 1.35, bolt at z 1.0: dz 0.35, radsum
        // 0.58 - EPS → dx ≈ 0.4622 → x ≈ 49.538 → t ≈ 0.4538 (the lower
        // sphere, dz 0.525, is reached later at t ≈ 0.4754).
        assert!((hit.t - 0.4538).abs() < 1e-3, "t = {}", hit.t);
        assert!(sweep(&world, 0, true).is_none(), "exempt: our own launch");
    }

    /// A Setup that has not been parsed yet collides as the humanoid
    /// cylinder of its cached radius (obj_collider_for_entity's fallback).
    #[test]
    fn an_unresolved_setup_uses_the_setup_radii_cylinder() {
        let mut world = WorldState::synthetic();
        world.setup_radii.insert(UNPARSED_SETUP, 0.7);
        let mut c = Entity::new(Guid(0x8000_0043), "Golem".to_string(), pose_at(50.0, 50.0, 0.0));
        c.gfx_id = Some(UNPARSED_SETUP);
        world.entities.insert(c);
        // Radius 0.7, height PLAYER_SETUP_HEIGHT (1.835 > the bolt's z 1.0):
        // x = 50 - (0.7 + 0.1) → t = 0.42.
        let hit = sweep(&world, 0, false).expect("fallback cylinder");
        assert!((hit.t - 0.42).abs() < 1e-3, "t = {}", hit.t);
    }

    /// The Z-slab veto: a bolt passing above the creature's head does not
    /// hit its wall.
    #[test]
    fn a_missile_passing_over_the_top_does_not_hit() {
        let world = world_with_creature(PhysicsState::NONE);
        let hit = world.sweep_missile_against_objects(
            world_at(45.0, 50.0, 2.5),
            world_at(55.0, 50.0, 2.5),
            R,
            MISSILE,
            0,
            false,
        );
        assert!(hit.is_none(), "{hit:?}");
    }

    /// An arrow dropping onto the creature's head hits the top cap.
    #[test]
    fn a_descending_missile_hits_the_top_cap() {
        let world = world_with_creature(PhysicsState::NONE);
        let hit = world
            .sweep_missile_against_objects(
                world_at(50.0, 50.0, 4.0),
                world_at(50.0, 50.0, 0.0),
                R,
                MISSILE,
                0,
                false,
            )
            .expect("cap hit");
        // Top 2.0 + radius 0.1 → z 2.1, from 4 over 4 m → t = 0.475.
        assert!((hit.t - 0.475).abs() < 1e-3, "t = {}", hit.t);
        assert!(hit.normal.z > 0.99, "{:?}", hit.normal);
    }

    /// Starting inside a body: moving out passes, moving in is a t = 0
    /// contact with the outward normal (the JS launch-window rule decides).
    #[test]
    fn an_embedded_start_stops_only_when_moving_inward() {
        let world = world_with_creature(PhysicsState::NONE);
        let out = world.sweep_missile_against_objects(
            world_at(50.3, 50.0, 1.0),
            world_at(52.0, 50.0, 1.0),
            R,
            MISSILE,
            0,
            false,
        );
        assert!(out.is_none(), "leaving the body is never a hit: {out:?}");
        let inward = world
            .sweep_missile_against_objects(
                world_at(50.3, 50.0, 1.0),
                world_at(49.0, 50.0, 1.0),
                R,
                MISSILE,
                0,
                false,
            )
            .expect("embedded + inward");
        assert_eq!(inward.t, 0.0);
        assert!(inward.normal.x > 0.99, "outward normal {:?}", inward.normal);
    }

    /// Contained / out-of-world objects never collide.
    #[test]
    fn an_object_with_no_landblock_is_skipped() {
        let mut world = world_with_creature(PhysicsState::NONE);
        world.entities.get_mut(Guid(0x8000_0042)).unwrap().position.landblock_id = Guid::NULL;
        assert!(sweep(&world, 0, false).is_none());
    }
}
