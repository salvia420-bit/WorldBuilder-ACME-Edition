//! DAT-01 phase 2a/2b (2026-07-27) — procedural-scenery collision:
//! per-landblock collider batches + the `CCylSphere` narrow phase.
//!
//! # Why this exists
//!
//! Baked procedural scenery (trees, rocks, bushes — `dist/scenery/*.jsonl`,
//! produced by `holtburger-scenery-bake`) had NO collision representation at
//! all: COL-01 "walk through trees", COL-29 "rocks in paths don't block".
//! See `docs/acclient-deep-dive-mining/DAT-01-design.md` for the full
//! grounding; the short version of what retail does:
//!
//! `CLandBlock::get_land_scenes` (`acclient.c:352530`) instantiates every
//! accepted scenery item as a real STATIC `CPhysicsObj` and appends it to the
//! landblock's `static_objects` array — the SAME array hand-placed
//! `LandblockInfo` statics use (`CLandBlock::add_static_object`,
//! `acclient.c:351857`). A move then resolves through
//! `CPhysicsObj::FindObjCollisions` (`acclient.c:316159`), whose narrow-phase
//! ladder (`acclient.c:316229-316281`) is:
//!
//! 1. `HAS_PHYSICS_BSP_PS` → per-part BSP descent,
//! 2. else `GetNumCylsphere() > 0` →
//!    `CCylSphere::intersects_sphere(cyl, &m_position, m_scale, transition)`,
//! 3. else `GetNumSphere() > 0` → `CSphere::intersects_sphere`,
//! 4. else **no collision at all**.
//!
//! The ladder is **exclusive and ordered** — rung 1 short-circuits, so a
//! Setup carrying both a BSP and cylspheres never runs the cylsphere test.
//! Four such models exist. Testing cylsphere first would diverge from retail
//! on every one of them.
//!
//! World-scale census (2026-07-27, all 176 scenery DIDs, calibrated against
//! 115,415 real placements from the shipped bake —
//! `/mnt/wbterminal2/buildbox-2026-07-27/census/census-summary.md`):
//!
//! | rung | DIDs | real placements |
//! |---|---:|---:|
//! | 1 `bsp` | 23 | 0.5% |
//! | 2 `cylsphere` | 85 | 33.7% |
//! | 3 `sphere` | 19 | 6.1% |
//! | 4 `none` | 49 | **59.7%** |
//!
//! (The DAT-01 design doc's "42% no-collider" came from a 3-landblock sample
//! and is refuted: the real figure is 59.7%, 95% CI [58.05, 61.39]. The same
//! sample concluded "no scenery model carries a physics BSP", also refuted —
//! 23 DIDs do.)
//!
//! So: broad phase = the baked render-mesh AABB; narrow phase = the
//! `CSetup` **cylspheres AND spheres**, each scaled by the per-instance
//! `SetScaleStatic` value; and a hard per-Setup collidability filter at
//! ingest, classified BY THE LADDER — never by `height == 0 && radius == 0`,
//! which 19 *colliding* DIDs also satisfy.
//!
//! Both rung 2 and rung 3 **iterate the whole primitive array** in retail
//! (`v10 += 20` per `CCylSphere`, `+= 16` per `CSphere`), so a placement can
//! contribute more than one collider row: 5 DIDs carry 2–3 cylspheres, 3
//! carry 2–3 spheres.
//!
//! # What is ported here
//!
//! [`cylsphere_to_world`]  ← `CCylSphere::intersects_sphere(this, Position *p,
//!                             float scale, CTransition *)` (`acclient.c:362244`)
//! [`cylsphere_collides_with_sphere`]
//!                         ← `CCylSphere::collides_with_sphere` (`:361502`)
//! [`cylsphere_normal_of_collision`]
//!                         ← `CCylSphere::normal_of_collision` (`:361652`)
//! [`sweep_sphere_against_cylsphere`]
//!                         ← the time-of-impact solve inside
//!                           `CCylSphere::collide_with_point` (`:361705`)
//! [`sphere_to_world`]     ← `CSphere::intersects_sphere(this, Position *p,
//!                             float scale, CTransition *, int)` (`:359390`)
//! [`sphere_collides_with_sphere`]
//!                         ← `CSphere::collides_with_sphere` (`:358509`; the
//!                           decompiled FPU compare is mangled, so the
//!                           predicate is taken from ACE's verbatim port,
//!                           `Physics/Sphere.cs:215-221`)
//! [`sweep_sphere_against_sphere`]
//!                         ← the sphere-sphere time-of-impact solve
//!                           (`Sphere.FindTimeOfCollision`), root selection
//!                           matched to the cylsphere port's
//!
//! NOT ported: `slide_sphere` / `land_on_cylinder` / `step_sphere_up` /
//! `step_sphere_down`. Those are the retail `CTransition` state machine's
//! resolution arms (contact planes, step-up, landing); our integrator owns
//! resolution (stop-and-slide + a depenetration pushout, exactly like the
//! `USE_STATIC_BSP` arm). What is ported is the *geometry predicate* and the
//! *time of impact*, which is the part the arm cannot invent.

use holtburger_common::{Aabb, Quaternion, Vector3};

/// Retail's collision epsilon, verbatim. Appears in `collides_with_sphere`
/// as `this->radius - 0.00019999999 + check_pos->radius` and in the
/// degenerate-motion guards of `collide_with_point`. The literal is an f32
/// `2e-4` rounded by the decompiler; keeping the decompiled digits makes
/// the port diffable against `acclient.c`.
pub const CYLSPHERE_EPSILON: f32 = 0.000_199_999_99;

/// A `CSetup` cylsphere in the model's OWN (unscaled, unrotated) frame —
/// `holtburger_dat::file_type::setup_model::CylSphere` without the DAT
/// dependency. `origin` is retail's `low_pt`: the centre of the cylinder's
/// BOTTOM cap, not its centroid.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SetupCylSphere {
    pub origin: Vector3,
    pub radius: f32,
    pub height: f32,
}

/// A cylsphere already lifted into world space with the per-instance scale
/// applied — the `global_cylsphere` local that `CCylSphere::intersects_sphere
/// (this, p, scale, transition)` builds on its stack (`acclient.c:362258`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct WorldCylSphere {
    /// World-space bottom-cap centre.
    pub low_pt: Vector3,
    pub radius: f32,
    pub height: f32,
}

/// Port of the scaling wrapper `CCylSphere::intersects_sphere(CCylSphere
/// *this, Position *p, float scale, CTransition *transition)`
/// (`acclient.c:362244`), which is the overload rung 2 of
/// `CPhysicsObj::FindObjCollisions` actually calls with `m_scale`:
///
/// ```c
/// global_cylsphere.radius = scale * v4->radius;          // :362258
/// global_cylsphere.height = scale * v4->height;          // :362259
/// v.x = scale * v4->low_pt.x;  v.y = scale * low_pt.y;  v.z = scale * low_pt.z;
/// Position::localtoglobal(&transition->sphere_path.check_pos, &result, p, &v);
/// ```
///
/// So the scale is a UNIFORM multiplier applied to `radius`, `height` AND
/// `low_pt` **before** the placement frame transforms `low_pt` into the
/// mover's frame. Retail moves the cylinder into the mover's frame; we do
/// the algebraically equivalent thing and move it into world space, because
/// our movers and our scenery already share one global-metre frame.
///
/// # The one constraint that is not obvious
///
/// Retail's cylinder is Z-aligned *in the object's local frame*, so a tilted
/// placement gives a tilted cylinder and retail's per-frame transform of the
/// MOVER preserves that. We rotate only `low_pt` and keep the cylinder
/// world-Z-aligned, which is exact **iff the placement rotation is yaw-only**.
/// For baked scenery it always is: `holtburger-scenery-bake` emits
/// `Quaternion.CreateFromYawPitchRoll(0, 0, rot)` (qx == qy == 0), mirroring
/// retail's `get_land_scenes`, which builds the scenery frame from a Z
/// rotation alone. Feeding a pitched/rolled placement here silently
/// straightens the cylinder — acceptable (conservative-ish, and unreachable
/// from the scenery feed) but worth knowing before reusing this for the
/// `LandblockInfo` stab list, whose frames are arbitrary.
pub fn cylsphere_to_world(
    cyl: &SetupCylSphere,
    scale: f32,
    placement_origin: Vector3,
    placement_orientation: Quaternion,
) -> WorldCylSphere {
    let scaled_low = Vector3::new(
        scale * cyl.origin.x,
        scale * cyl.origin.y,
        scale * cyl.origin.z,
    );
    let rotated = placement_orientation.rotate_vector(scaled_low);
    WorldCylSphere {
        low_pt: Vector3::new(
            placement_origin.x + rotated.x,
            placement_origin.y + rotated.y,
            placement_origin.z + rotated.z,
        ),
        radius: scale * cyl.radius,
        height: scale * cyl.height,
    }
}

/// `radsum` as retail computes it at every `collides_with_sphere` call site
/// (`acclient.c:362085`, `:362090`, …): `cyl.radius - EPS + sphere.radius`.
#[inline]
pub fn cylsphere_radsum(cyl: &WorldCylSphere, sphere_radius: f32) -> f32 {
    cyl.radius - CYLSPHERE_EPSILON + sphere_radius
}

/// Faithful port of `CCylSphere::collides_with_sphere` (`acclient.c:361502`):
///
/// ```c
/// return radsum * radsum >= disp->x * disp->x + disp->y * disp->y
///     && check_pos->radius - 0.00019999999 + this->height * 0.5
///        >= fabs(this->height * 0.5 - disp->z);
/// ```
///
/// with `disp = sphere.center - cyl.low_pt`.
///
/// The Z half is easy to misread. Writing `h2 = height/2` and
/// `r = sphere_radius - EPS`, `r + h2 >= |h2 - disp.z|` is exactly
/// `-r <= disp.z <= height + r` — i.e. the cylinder's Z span extended by the
/// sphere radius at BOTH ends. It is a slab test, not a true capsule test:
/// near the rim of a cap retail reports a hit the exact
/// sphere-vs-cylinder-corner distance would not. That over-report is retail
/// behaviour and is preserved deliberately.
#[inline]
pub fn cylsphere_collides_with_sphere(
    cyl: &WorldCylSphere,
    sphere_center: Vector3,
    sphere_radius: f32,
) -> bool {
    let disp = Vector3::new(
        sphere_center.x - cyl.low_pt.x,
        sphere_center.y - cyl.low_pt.y,
        sphere_center.z - cyl.low_pt.z,
    );
    let radsum = cylsphere_radsum(cyl, sphere_radius);
    let half_h = cyl.height * 0.5;
    radsum * radsum >= disp.x * disp.x + disp.y * disp.y
        && sphere_radius - CYLSPHERE_EPSILON + half_h >= (half_h - disp.z).abs()
}

/// The Z half of [`cylsphere_collides_with_sphere`], on its own:
/// `sphere.radius - EPS + h/2 >= |h/2 - disp.z|`, i.e. the sphere centre lies
/// within the cylinder's Z span extended by the sphere radius at both ends.
///
/// Split out because the swept test needs exactly this and NOT the XY half.
/// The XY half is satisfied by construction at a swept contact point — but
/// only to within a float epsilon, and retail's radsum is deliberately
/// `radius - 0.0002 + sphere_radius` while the swept solve uses
/// `radsuma = radius + sphere_radius`. Re-asserting the full predicate at the
/// contact point therefore rejects EVERY true wall hit by 2e-4 m. Retail
/// never notices because its caller evaluates `collides_with_sphere` at the
/// *start* pose, before `collide_with_point` runs; ours evaluates at the
/// contact, so it must use the Z half alone.
#[inline]
pub fn cylsphere_z_slab_overlap(
    cyl: &WorldCylSphere,
    sphere_center_z: f32,
    sphere_radius: f32,
) -> bool {
    let disp_z = sphere_center_z - cyl.low_pt.z;
    let half_h = cyl.height * 0.5;
    sphere_radius - CYLSPHERE_EPSILON + half_h >= (half_h - disp_z).abs()
}

/// Faithful port of `CCylSphere::normal_of_collision` (`acclient.c:361652`).
///
/// Returns `(definite, normal)`. `start_center` is retail's
/// `path->global_curr_center[sphere_num]` (where the sphere came FROM) and
/// `end_disp_z` is `disp->z`, the Z of the displacement at the *target*
/// (where it is going). The branch structure:
///
/// - Start already OUTSIDE the XY circle → radial normal `(dx, dy, 0)`.
///   `definite` is 1 when the start Z is inside the extended slab, or when
///   the sphere did not move vertically; otherwise 0, meaning "a cap may be
///   hit first, solve the cap before the wall".
/// - Start INSIDE the XY circle → vertical normal: `+Z` when the sphere is
///   descending (`disp.z - start_disp.z <= 0`), `-Z` when ascending. Always
///   definite.
///
/// The returned radial normal is NOT normalised here — retail normalises it
/// at the contact point by dividing by `radsuma` (`acclient.c:361864`), where
/// the radial length equals `radsuma` by construction.
pub fn cylsphere_normal_of_collision(
    cyl: &WorldCylSphere,
    start_center: Vector3,
    end_disp_z: f32,
    sphere_radius: f32,
) -> (bool, Vector3) {
    let dx = start_center.x - cyl.low_pt.x;
    let dy = start_center.y - cyl.low_pt.y;
    let dz = start_center.z - cyl.low_pt.z;
    let radsum = cylsphere_radsum(cyl, sphere_radius);
    let half_h = cyl.height * 0.5;
    if radsum * radsum < dx * dx + dy * dy {
        let normal = Vector3::new(dx, dy, 0.0);
        let definite = sphere_radius - CYLSPHERE_EPSILON + half_h >= (half_h - dz).abs()
            || (dz - end_disp_z).abs() <= CYLSPHERE_EPSILON;
        (definite, normal)
    } else if end_disp_z - dz <= 0.0 {
        (true, Vector3::new(0.0, 0.0, 1.0))
    } else {
        (true, Vector3::new(0.0, 0.0, -1.0))
    }
}

/// Earliest contact of a moving sphere against one world cylsphere.
/// `t` is the fraction of `delta` consumed; `normal` is the unit outward
/// contact normal (radial for the wall, ±Z for a cap).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CylSphereHit {
    pub t: f32,
    pub normal: Vector3,
}

/// Swept sphere vs. scaled cylsphere — the time-of-impact solve lifted out of
/// `CCylSphere::collide_with_point` (`acclient.c:361705`), which is the arm
/// `intersects_sphere` reaches for the `state & 8` (missile-ish) case and the
/// point case of the default ladder.
///
/// Retail's two solves, both reproduced verbatim in structure:
///
/// **Cap solve** (`acclient.c:361805-361817`), used when the sphere starts
/// inside the XY circle, or as the FIRST attempt when the start is outside
/// both the circle and the Z slab:
///
/// ```c
/// if (m.z > 0) { normal.z = -1; t = -((d0.z + r) / m.z); }
/// else         { normal.z = +1; t = (r + height - d0.z) / m.z; }
/// ```
///
/// **Wall solve** (`acclient.c:361824-361840` and `:361896-361918`) — a plain
/// swept-circle quadratic in XY with `radsuma = radsum + EPS`, which by the
/// definition of `radsum` is exactly `cyl.radius + sphere.radius`:
///
/// ```c
/// a  = m.y*m.y + m.x*m.x;
/// b  = -(m.y*d0.y + m.x*d0.x);
/// disc = b*b - (d0.y*d0.y + d0.x*d0.x - radsuma*radsuma) * a;
/// t  = (b - sqrt(disc)) / a;  if (b - sqrt(disc) < 0) t = (b + sqrt(disc)) / a;
/// ```
///
/// The "if the near root is negative take the far root" rule is retail's
/// (`:361832`), and it is what lets a sphere that STARTS overlapping still
/// produce a forward exit time rather than a spurious backward hit. Retail
/// then rejects `t < 0 || t > 1` (`:361887`, `:361919`); so do we.
///
/// The wall normal is `(d0 + m*t)` with Z zeroed, divided by `radsuma`
/// (`acclient.c:361856-361864`) — unit by construction at the contact point.
pub fn sweep_sphere_against_cylsphere(
    cyl: &WorldCylSphere,
    start_center: Vector3,
    delta: Vector3,
    sphere_radius: f32,
) -> Option<CylSphereHit> {
    let d0 = Vector3::new(
        start_center.x - cyl.low_pt.x,
        start_center.y - cyl.low_pt.y,
        start_center.z - cyl.low_pt.z,
    );
    // `disp` at the TARGET, which is what normal_of_collision compares
    // against to decide "did this sphere move vertically at all".
    let end_disp_z = d0.z + delta.z;
    let (definite, normal0) =
        cylsphere_normal_of_collision(cyl, start_center, end_disp_z, sphere_radius);
    // radsuma == radsum + EPS == cyl.radius + sphere_radius (acclient.c:361787).
    let radsuma = cylsphere_radsum(cyl, sphere_radius) + CYLSPHERE_EPSILON;

    let cap_solve = |normal_z_positive_motion: bool| -> Option<(f32, Vector3)> {
        if delta.z.abs() < CYLSPHERE_EPSILON {
            return None;
        }
        if normal_z_positive_motion {
            // Moving up: the sphere can only reach the BOTTOM cap, whose
            // outward normal points down.
            Some((
                -((d0.z + sphere_radius) / delta.z),
                Vector3::new(0.0, 0.0, -1.0),
            ))
        } else {
            Some((
                (sphere_radius + cyl.height - d0.z) / delta.z,
                Vector3::new(0.0, 0.0, 1.0),
            ))
        }
    };

    let wall_solve = || -> Option<(f32, Vector3)> {
        let a = delta.y * delta.y + delta.x * delta.x;
        let b = -(delta.y * d0.y + delta.x * d0.x);
        let disc = b * b - (d0.y * d0.y + d0.x * d0.x - radsuma * radsuma) * a;
        if disc < 0.0 || a < CYLSPHERE_EPSILON {
            return None;
        }
        let root = disc.sqrt();
        let t = if b - root < 0.0 {
            (b + root) / a
        } else {
            (b - root) / a
        };
        let nx = d0.x + delta.x * t;
        let ny = d0.y + delta.y * t;
        Some((
            t,
            Vector3::new(nx / radsuma, ny / radsuma, 0.0),
        ))
    };

    let (t, normal) = if !definite {
        // Start is outside the circle AND outside the Z slab: retail solves
        // the cap first, then falls through to the wall when the cap's XY
        // landing point is outside the circle (acclient.c:361818-361822).
        match cap_solve(delta.z > 0.0) {
            Some((t_cap, n_cap)) => {
                let px = d0.x + delta.x * t_cap;
                let py = d0.y + delta.y * t_cap;
                if px * px + py * py >= radsuma * radsuma {
                    wall_solve()?
                } else {
                    (t_cap, n_cap)
                }
            }
            None => return None,
        }
    } else if normal0.z != 0.0 {
        cap_solve(delta.z > 0.0)?
    } else {
        wall_solve()?
    };

    if !(0.0..=1.0).contains(&t) || !t.is_finite() {
        return None;
    }
    // A cap solve can report an on-axis time while the sphere is nowhere
    // near the cylinder laterally; retail's caller re-checks by construction
    // (the cap branch is only entered from inside the circle). Re-assert it
    // so a caller that hands us an arbitrary pair cannot get a phantom hit.
    if normal.z != 0.0 {
        let px = d0.x + delta.x * t;
        let py = d0.y + delta.y * t;
        if px * px + py * py > radsuma * radsuma {
            return None;
        }
    }
    Some(CylSphereHit { t, normal })
}

/// Depenetration for a sphere that is ALREADY inside a cylsphere. Retail has
/// no direct analogue — its `CTransition` never lets a mover reach an
/// interior state — but our arm is a per-tick resolver like the
/// `USE_STATIC_BSP` `resolve_static_bsp_pushout`, and a tick that starts
/// penetrating (teleport, server force-position, a scenery batch landing
/// under the player's feet) has to recover.
///
/// Lateral-only: the minimum XY translation that puts the sphere centre back
/// on the `radsum` circle, plus a hair of skin. Returns `None` when the
/// sphere is clear, or when it is exactly on the axis (no well-defined
/// direction — leaving it to the next tick's swept test is better than
/// picking an arbitrary axis).
pub fn cylsphere_pushout_xy(
    cyl: &WorldCylSphere,
    sphere_center: Vector3,
    sphere_radius: f32,
    skin: f32,
) -> Option<Vector3> {
    if !cylsphere_collides_with_sphere(cyl, sphere_center, sphere_radius) {
        return None;
    }
    let dx = sphere_center.x - cyl.low_pt.x;
    let dy = sphere_center.y - cyl.low_pt.y;
    let dist_sq = dx * dx + dy * dy;
    if dist_sq <= 1e-12 {
        return None;
    }
    let dist = dist_sq.sqrt();
    let target = cylsphere_radsum(cyl, sphere_radius) + skin;
    if dist >= target {
        return None;
    }
    let push = target - dist;
    Some(Vector3::new(dx / dist * push, dy / dist * push, 0.0))
}

// =====================================================================
// Rung 3 — `CSphere`.
// =====================================================================

/// A `CSetup` sphere in the model's own (unscaled, unrotated) frame.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SetupSphere {
    pub center: Vector3,
    pub radius: f32,
}

/// Port of `CSphere::intersects_sphere(CSphere *this, Position *p, float
/// scale, CTransition *, int is_creature)` (`acclient.c:359390`) — the
/// scaling wrapper rung 3 is called through. Structurally identical to
/// [`cylsphere_to_world`]:
///
/// ```c
/// global_sphere.radius = scale * this->radius;              // :359402
/// v = (scale*center.x, scale*center.y, scale*center.z);     // :359403-:359406
/// Position::localtoglobal(&check_pos, &result, p, &v);
/// ```
///
/// Returns `(world_center, world_radius)`.
pub fn sphere_to_world(
    sph: &SetupSphere,
    scale: f32,
    placement_origin: Vector3,
    placement_orientation: Quaternion,
) -> (Vector3, f32) {
    let scaled = Vector3::new(
        scale * sph.center.x,
        scale * sph.center.y,
        scale * sph.center.z,
    );
    let rotated = placement_orientation.rotate_vector(scaled);
    (
        Vector3::new(
            placement_origin.x + rotated.x,
            placement_origin.y + rotated.y,
            placement_origin.z + rotated.z,
        ),
        scale * sph.radius,
    )
}

/// `radsum` for rung 3, per `CSphere::intersects_sphere`
/// (`acclient.c:359157`; ACE `Sphere.cs:302`):
/// `mover.radius + sphere.radius - EPSILON`. Note this is the FULL 3-D
/// radius sum — unlike rung 2, where the epsilon-shrunk radius applies only
/// to the XY circle and Z gets its own slab test.
#[inline]
pub fn sphere_radsum(sphere_radius: f32, mover_radius: f32) -> f32 {
    mover_radius + sphere_radius - CYLSPHERE_EPSILON
}

/// Port of `CSphere::collides_with_sphere(disp, radsum)`
/// (`acclient.c:358509`): `|disp|² <= radsum²`.
///
/// The decompiler lost the FPU comparison in this one (`return v5 == 0;`
/// with `v3 = disp->z` dangling), so the predicate is taken from ACE's
/// verbatim port — `Physics/Sphere.cs:215-221`,
/// `otherSphere.LengthSquared() <= radsum * radsum`, whose own comment
/// flags the touching-equals-collision question and answers it `<=`. That
/// matches rung 2's `>=`-on-the-other-side convention
/// (`radsum*radsum >= disp.x²+disp.y²`), so both rungs treat exact contact
/// as a hit.
#[inline]
pub fn sphere_collides_with_sphere(
    center: Vector3,
    radius: f32,
    sphere_center: Vector3,
    sphere_radius: f32,
) -> bool {
    let disp = Vector3::new(
        sphere_center.x - center.x,
        sphere_center.y - center.y,
        sphere_center.z - center.z,
    );
    let radsum = sphere_radsum(radius, sphere_radius);
    disp.length_squared() <= radsum * radsum
}

/// Swept sphere vs. a static scaled `CSphere` — the 3-D twin of
/// [`sweep_sphere_against_cylsphere`], and the rung-3 narrow phase.
///
/// Same quadratic and the SAME root-selection rule as the cylsphere port
/// (`acclient.c:361832`: take the near root, or the far root when the near
/// one is negative, so a start that already overlaps yields a forward exit
/// time rather than a spurious backward hit) — kept deliberately identical
/// so the two rungs cannot disagree about what "already touching" means.
///
/// The contact normal is the unit vector from the static sphere's centre to
/// the mover's centre at contact.
pub fn sweep_sphere_against_sphere(
    center: Vector3,
    radius: f32,
    start_center: Vector3,
    delta: Vector3,
    sphere_radius: f32,
) -> Option<CylSphereHit> {
    let d0 = Vector3::new(
        start_center.x - center.x,
        start_center.y - center.y,
        start_center.z - center.z,
    );
    let radsum = sphere_radsum(radius, sphere_radius);
    let a = delta.length_squared();
    if a < CYLSPHERE_EPSILON {
        return None;
    }
    let b = -(delta.x * d0.x + delta.y * d0.y + delta.z * d0.z);
    let disc = b * b - (d0.length_squared() - radsum * radsum) * a;
    if disc < 0.0 {
        return None;
    }
    let root = disc.sqrt();
    let t = if b - root < 0.0 {
        (b + root) / a
    } else {
        (b - root) / a
    };
    if !(0.0..=1.0).contains(&t) || !t.is_finite() {
        return None;
    }
    let n = Vector3::new(
        d0.x + delta.x * t,
        d0.y + delta.y * t,
        d0.z + delta.z * t,
    );
    let len = n.length();
    if len <= 1e-6 {
        return None;
    }
    Some(CylSphereHit {
        t,
        normal: Vector3::new(n.x / len, n.y / len, n.z / len),
    })
}

/// Lateral depenetration out of a static `CSphere`. Rung-3 twin of
/// [`cylsphere_pushout_xy`], and lateral for the same reason: the floor-Z
/// snap downstream is the sole vertical authority, so pushing a player up
/// out of a boulder would be immediately undone and would fight the snap.
///
/// The push distance uses the XY radius of the sphere's cross-section AT THE
/// MOVER'S HEIGHT, not the full radius — pushing by the full radius would
/// eject a player standing near the top of a low boulder far harder than the
/// geometry warrants.
pub fn sphere_pushout_xy(
    center: Vector3,
    radius: f32,
    sphere_center: Vector3,
    sphere_radius: f32,
    skin: f32,
) -> Option<Vector3> {
    if !sphere_collides_with_sphere(center, radius, sphere_center, sphere_radius) {
        return None;
    }
    let radsum = sphere_radsum(radius, sphere_radius);
    let dz = sphere_center.z - center.z;
    // Half-chord of the combined sphere at this height.
    let lateral_reach_sq = radsum * radsum - dz * dz;
    if lateral_reach_sq <= 0.0 {
        // Directly above/below beyond the lateral cross-section: no lateral
        // escape is meaningful this tick.
        return None;
    }
    let dx = sphere_center.x - center.x;
    let dy = sphere_center.y - center.y;
    let dist_sq = dx * dx + dy * dy;
    if dist_sq <= 1e-12 {
        return None;
    }
    let dist = dist_sq.sqrt();
    let target = lateral_reach_sq.sqrt() + skin;
    if dist >= target {
        return None;
    }
    let push = target - dist;
    Some(Vector3::new(dx / dist * push, dy / dist * push, 0.0))
}

/// Which retail narrow-phase rung a batch row belongs to. Rung 1 (BSP) is
/// NOT here — those placements are classified out at ingest and routed
/// elsewhere; a BSP model must never fall through to a cylsphere test
/// (retail's ladder short-circuits, and 4 scenery models carry both).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SceneryPrimKind {
    /// Rung 2 — `CSetup.cyl_spheres[i]`.
    Cylinder,
    /// Rung 3 — `CSetup.spheres[i]`.
    Sphere,
}

/// DAT-01 phase 2a — one landblock's worth of scenery colliders, stored as
/// parallel arrays (SoA) rather than a `Vec` of structs.
///
/// Rationale (design §4): at Holtburg density this is ~24 placements per
/// landblock average, ~71 peak, and the resident set is the 3×3 ring the
/// broad-phase query walks. The hot loop is an AABB reject over `aabb`, so
/// keeping that column contiguous and only touching the cylinder columns for
/// survivors is the whole point. `scale` and `did` are carried for
/// diagnostics — `did` so `__diag` can say WHICH model blocked, `scale`
/// because the cylinder columns are already scaled and the raw per-instance
/// value is otherwise unrecoverable.
///
/// The primitive columns hold the WORLD-space, ALREADY-SCALED shape. Scale
/// is applied once at ingest instead of per test: retail re-applies
/// `m_scale` on every `intersects_sphere` call only because the call is
/// generic over a live `CPhysicsObj`; for a static batch nothing downstream
/// can change, so the fold is exact.
///
/// **One row per PRIMITIVE, not per placement.** Retail's rung 2 and rung 3
/// both walk the whole `CSetup` array, and 5 scenery DIDs carry 2–3
/// cylspheres while 3 carry 2–3 spheres. A placement with three cylspheres
/// therefore contributes three rows sharing one `did`, `aabb` and `scale`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SceneryColliderBatch {
    /// Placement model id — `0x02XXXXXX` SetupModel, or `0x01XXXXXX` for the
    /// nine bare-GfxObj scenery ids (which can only reach rung 1 or 4, so
    /// they never actually appear in this batch). Diagnostics only.
    pub did: Vec<u32>,
    /// World-frame render-mesh AABB from the V3 bake — the BROAD phase.
    /// Deliberately not the collider: it overstates a pine's trunk by
    /// 4.5–12.4× (design §3.1). Repeated per primitive row.
    pub aabb: Vec<Aabb>,
    /// Which narrow-phase test this row takes.
    pub kind: Vec<SceneryPrimKind>,
    /// `Cylinder`: world-frame bottom-cap centre of the scaled cylinder
    /// (retail `low_pt`). `Sphere`: the scaled sphere's world CENTRE.
    pub prim_origin: Vec<Vector3>,
    /// Scaled radius (both kinds).
    pub prim_radius: Vec<f32>,
    /// `Cylinder`: scaled cylinder height. `Sphere`: unused, `0.0`.
    pub prim_height: Vec<f32>,
    /// Per-instance `SetScaleStatic` value. Diagnostics only.
    pub scale: Vec<f32>,
}

impl SceneryColliderBatch {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_capacity(n: usize) -> Self {
        Self {
            did: Vec::with_capacity(n),
            aabb: Vec::with_capacity(n),
            kind: Vec::with_capacity(n),
            prim_origin: Vec::with_capacity(n),
            prim_radius: Vec::with_capacity(n),
            prim_height: Vec::with_capacity(n),
            scale: Vec::with_capacity(n),
        }
    }

    pub fn len(&self) -> usize {
        self.did.len()
    }

    pub fn is_empty(&self) -> bool {
        self.did.is_empty()
    }

    /// Append one rung-2 cylinder row. `cyl` must already be world-space +
    /// scaled (i.e. [`cylsphere_to_world`] output); `scale` is recorded only
    /// so diagnostics can report it.
    pub fn push_cylinder(&mut self, did: u32, aabb: Aabb, cyl: WorldCylSphere, scale: f32) {
        self.did.push(did);
        self.aabb.push(aabb);
        self.kind.push(SceneryPrimKind::Cylinder);
        self.prim_origin.push(cyl.low_pt);
        self.prim_radius.push(cyl.radius);
        self.prim_height.push(cyl.height);
        self.scale.push(scale);
    }

    /// Append one rung-3 sphere row. `center`/`radius` must already be
    /// world-space + scaled ([`sphere_to_world`] output).
    pub fn push_sphere(
        &mut self,
        did: u32,
        aabb: Aabb,
        center: Vector3,
        radius: f32,
        scale: f32,
    ) {
        self.did.push(did);
        self.aabb.push(aabb);
        self.kind.push(SceneryPrimKind::Sphere);
        self.prim_origin.push(center);
        self.prim_radius.push(radius);
        self.prim_height.push(0.0);
        self.scale.push(scale);
    }

    /// Absorb another batch (used when a landblock's ingest arrives in more
    /// than one chunk — the wasm feed stages one batch per LB, but the scene
    /// insert is append-shaped like every other collision index).
    pub fn extend_from(&mut self, other: &Self) {
        self.did.extend_from_slice(&other.did);
        self.aabb.extend_from_slice(&other.aabb);
        self.kind.extend_from_slice(&other.kind);
        self.prim_origin.extend_from_slice(&other.prim_origin);
        self.prim_radius.extend_from_slice(&other.prim_radius);
        self.prim_height.extend_from_slice(&other.prim_height);
        self.scale.extend_from_slice(&other.scale);
    }

    pub fn clear(&mut self) {
        self.did.clear();
        self.aabb.clear();
        self.kind.clear();
        self.prim_origin.clear();
        self.prim_radius.clear();
        self.prim_height.clear();
        self.scale.clear();
    }

    /// Rebuild row `i` as a world cylsphere. Only meaningful when
    /// `kind[i] == Cylinder`.
    #[inline]
    pub fn cyl_at(&self, i: usize) -> WorldCylSphere {
        WorldCylSphere {
            low_pt: self.prim_origin[i],
            radius: self.prim_radius[i],
            height: self.prim_height[i],
        }
    }

    /// Number of rows of each rung, `(cylinders, spheres)`. Diagnostics.
    pub fn rung_counts(&self) -> (usize, usize) {
        let cyl = self
            .kind
            .iter()
            .filter(|k| **k == SceneryPrimKind::Cylinder)
            .count();
        (cyl, self.kind.len() - cyl)
    }
}

/// Conservative world AABB of a sphere of `radius` swept from `start` along
/// `delta` — the broad-phase probe box.
pub(crate) fn swept_sphere_bounds(start: Vector3, delta: Vector3, radius: f32) -> Aabb {
    let end = Vector3::new(start.x + delta.x, start.y + delta.y, start.z + delta.z);
    let mut aabb = Aabb::empty();
    aabb.expand_to_include_point(start);
    aabb.expand_to_include_point(end);
    aabb.inflate(radius)
}

#[inline]
pub(crate) fn aabbs_overlap(a: &Aabb, b: &Aabb) -> bool {
    a.min.x <= b.max.x
        && a.max.x >= b.min.x
        && a.min.y <= b.max.y
        && a.max.y >= b.min.y
        && a.min.z <= b.max.z
        && a.max.z >= b.min.z
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cyl(x: f32, y: f32, z: f32, r: f32, h: f32) -> WorldCylSphere {
        WorldCylSphere {
            low_pt: Vector3::new(x, y, z),
            radius: r,
            height: h,
        }
    }

    // ---- cylsphere_to_world: the m_scale application -------------------

    #[test]
    fn scale_multiplies_radius_height_and_low_pt() {
        // acclient.c:362258-362262 — all three are scaled, and low_pt is
        // scaled BEFORE the frame transform.
        let local = SetupCylSphere {
            origin: Vector3::new(1.0, 2.0, 3.0),
            radius: 1.5,
            height: 10.0,
        };
        let w = cylsphere_to_world(&local, 2.0, Vector3::new(100.0, 200.0, 5.0), Quaternion::identity());
        assert_eq!(w.radius, 3.0);
        assert_eq!(w.height, 20.0);
        assert_eq!(w.low_pt, Vector3::new(102.0, 204.0, 11.0));
    }

    #[test]
    fn yaw_rotation_carries_the_scaled_low_pt() {
        // 90° yaw about +Z maps local +X to +Y.
        let local = SetupCylSphere {
            origin: Vector3::new(2.0, 0.0, 0.0),
            radius: 1.0,
            height: 4.0,
        };
        // +90° about Z, built directly (Quaternion::from_heading takes AC's
        // `450 - deg` compass convention, not a raw axis angle).
        let half = std::f32::consts::FRAC_PI_4;
        let q = Quaternion {
            w: half.cos(),
            x: 0.0,
            y: 0.0,
            z: half.sin(),
        };
        let w = cylsphere_to_world(&local, 1.0, Vector3::zero(), q);
        // Hand-computed: local +X*2 maps to +Y*2.
        assert!(w.low_pt.x.abs() < 1e-5, "x {}", w.low_pt.x);
        assert!((w.low_pt.y - 2.0).abs() < 1e-5, "y {}", w.low_pt.y);
        assert!(w.low_pt.z.abs() < 1e-6);
    }

    #[test]
    fn zero_scale_collapses_the_cylinder() {
        let local = SetupCylSphere {
            origin: Vector3::new(1.0, 1.0, 1.0),
            radius: 2.0,
            height: 6.0,
        };
        let w = cylsphere_to_world(&local, 0.0, Vector3::new(7.0, 8.0, 9.0), Quaternion::identity());
        assert_eq!(w.radius, 0.0);
        assert_eq!(w.height, 0.0);
        assert_eq!(w.low_pt, Vector3::new(7.0, 8.0, 9.0));
    }

    // ---- collides_with_sphere: hand-computed cases ---------------------

    #[test]
    fn xy_inside_and_z_inside_collides() {
        // cyl r=1 h=4 at origin; sphere r=0.5 centred 1.2 out, z=2 (mid-height).
        // radsum = 1 - 2e-4 + 0.5 = 1.4998 ; 1.2 < 1.4998 -> hit.
        let c = cyl(0.0, 0.0, 0.0, 1.0, 4.0);
        assert!(cylsphere_collides_with_sphere(&c, Vector3::new(1.2, 0.0, 2.0), 0.5));
    }

    #[test]
    fn xy_outside_radsum_misses() {
        // 1.6 > radsum 1.4998.
        let c = cyl(0.0, 0.0, 0.0, 1.0, 4.0);
        assert!(!cylsphere_collides_with_sphere(&c, Vector3::new(1.6, 0.0, 2.0), 0.5));
    }

    #[test]
    fn radsum_boundary_is_inclusive() {
        // Exactly at radsum: retail's test is `>=`, so this is a HIT.
        let c = cyl(0.0, 0.0, 0.0, 1.0, 4.0);
        let radsum = cylsphere_radsum(&c, 0.5);
        assert!(cylsphere_collides_with_sphere(
            &c,
            Vector3::new(radsum, 0.0, 2.0),
            0.5
        ));
        assert!(!cylsphere_collides_with_sphere(
            &c,
            Vector3::new(radsum * 1.0001, 0.0, 2.0),
            0.5
        ));
    }

    #[test]
    fn z_slab_extends_by_the_sphere_radius_at_both_ends() {
        // h=4, sphere r=0.5 -> disp.z admissible in [-0.4998, 4.4998].
        let c = cyl(0.0, 0.0, 0.0, 1.0, 4.0);
        assert!(cylsphere_collides_with_sphere(&c, Vector3::new(0.0, 0.0, -0.49), 0.5));
        assert!(!cylsphere_collides_with_sphere(&c, Vector3::new(0.0, 0.0, -0.51), 0.5));
        assert!(cylsphere_collides_with_sphere(&c, Vector3::new(0.0, 0.0, 4.49), 0.5));
        assert!(!cylsphere_collides_with_sphere(&c, Vector3::new(0.0, 0.0, 4.51), 0.5));
    }

    #[test]
    fn zero_height_cylinder_is_a_disc_of_sphere_radius() {
        // The 42% ground-clutter class has height == radius == 0. Even so the
        // predicate must not blow up: with radius 0 the radsum is the sphere's
        // own radius, so a centre exactly on the axis "collides". That is why
        // the ingest filter is mandatory (design §3.4) — the math will not
        // save us.
        let c = cyl(0.0, 0.0, 0.0, 0.0, 0.0);
        assert!(cylsphere_collides_with_sphere(&c, Vector3::new(0.0, 0.0, 0.0), 0.5));
        assert!(!cylsphere_collides_with_sphere(&c, Vector3::new(0.6, 0.0, 0.0), 0.5));
    }

    // ---- normal_of_collision -------------------------------------------

    #[test]
    fn outside_xy_gives_a_radial_normal() {
        let c = cyl(0.0, 0.0, 0.0, 1.0, 4.0);
        let (definite, n) = cylsphere_normal_of_collision(&c, Vector3::new(3.0, 0.0, 2.0), 2.0, 0.5);
        assert!(definite, "start Z inside the slab -> definite");
        assert_eq!(n.z, 0.0);
        assert!(n.x > 0.0 && n.y == 0.0);
    }

    #[test]
    fn inside_xy_descending_gives_up_normal() {
        let c = cyl(0.0, 0.0, 0.0, 1.0, 4.0);
        // start z = 6 (disp.z 6), target disp.z = 5 -> descending.
        let (definite, n) = cylsphere_normal_of_collision(&c, Vector3::new(0.2, 0.0, 6.0), 5.0, 0.5);
        assert!(definite);
        assert_eq!(n, Vector3::new(0.0, 0.0, 1.0));
    }

    #[test]
    fn inside_xy_ascending_gives_down_normal() {
        let c = cyl(0.0, 0.0, 0.0, 1.0, 4.0);
        let (definite, n) = cylsphere_normal_of_collision(&c, Vector3::new(0.2, 0.0, -3.0), -2.0, 0.5);
        assert!(definite);
        assert_eq!(n, Vector3::new(0.0, 0.0, -1.0));
    }

    #[test]
    fn outside_xy_and_outside_slab_with_vertical_motion_is_indefinite() {
        let c = cyl(0.0, 0.0, 0.0, 1.0, 4.0);
        // start well above the top cap AND outside the circle, descending.
        let (definite, n) = cylsphere_normal_of_collision(&c, Vector3::new(3.0, 0.0, 10.0), 6.0, 0.5);
        assert!(!definite);
        assert_eq!(n.z, 0.0);
    }

    // ---- swept: hand-computed times ------------------------------------

    #[test]
    fn head_on_wall_sweep_time_is_hand_checkable() {
        // cyl r=1 at origin, sphere r=0.5 starting at x=5 moving -X by 10.
        // radsuma = 1 + 0.5 = 1.5 exactly; contact at x = 1.5 -> travelled
        // 3.5 of 10 -> t = 0.35.
        let c = cyl(0.0, 0.0, 0.0, 1.0, 4.0);
        let hit = sweep_sphere_against_cylsphere(
            &c,
            Vector3::new(5.0, 0.0, 2.0),
            Vector3::new(-10.0, 0.0, 0.0),
            0.5,
        )
        .expect("must hit");
        assert!((hit.t - 0.35).abs() < 1e-4, "t {}", hit.t);
        // Normal points back along +X (out of the cylinder toward the mover).
        assert!((hit.normal.x - 1.0).abs() < 1e-4, "nx {}", hit.normal.x);
        assert!(hit.normal.y.abs() < 1e-4);
        assert_eq!(hit.normal.z, 0.0);
    }

    #[test]
    fn lateral_offset_approach_hits_later_than_head_on() {
        // The COL-03 lesson: approach off-axis. y = 1.0, radsuma = 1.5, so
        // contact when x = sqrt(1.5^2 - 1^2) = 1.118034; from x=5 moving -X
        // by 10 -> t = (5 - 1.118034)/10 = 0.3881966.
        let c = cyl(0.0, 0.0, 0.0, 1.0, 4.0);
        let hit = sweep_sphere_against_cylsphere(
            &c,
            Vector3::new(5.0, 1.0, 2.0),
            Vector3::new(-10.0, 0.0, 0.0),
            0.5,
        )
        .expect("must hit");
        assert!((hit.t - 0.388_196_6).abs() < 1e-4, "t {}", hit.t);
        let len = (hit.normal.x * hit.normal.x + hit.normal.y * hit.normal.y).sqrt();
        assert!((len - 1.0).abs() < 1e-4, "normal not unit: {len}");
    }

    #[test]
    fn tangent_miss_returns_none() {
        // y = 1.6 > radsuma 1.5 -> the swept circle never reaches.
        let c = cyl(0.0, 0.0, 0.0, 1.0, 4.0);
        assert!(
            sweep_sphere_against_cylsphere(
                &c,
                Vector3::new(5.0, 1.6, 2.0),
                Vector3::new(-10.0, 0.0, 0.0),
                0.5,
            )
            .is_none()
        );
    }

    #[test]
    fn short_move_that_stops_before_contact_returns_none() {
        // From x=5 moving -X by only 1: reaches x=4, contact needs x=1.5.
        // t would be 3.5 > 1 -> rejected (acclient.c:361887).
        let c = cyl(0.0, 0.0, 0.0, 1.0, 4.0);
        assert!(
            sweep_sphere_against_cylsphere(
                &c,
                Vector3::new(5.0, 0.0, 2.0),
                Vector3::new(-1.0, 0.0, 0.0),
                0.5,
            )
            .is_none()
        );
    }

    #[test]
    fn moving_away_returns_none() {
        let c = cyl(0.0, 0.0, 0.0, 1.0, 4.0);
        assert!(
            sweep_sphere_against_cylsphere(
                &c,
                Vector3::new(5.0, 0.0, 2.0),
                Vector3::new(10.0, 0.0, 0.0),
                0.5,
            )
            .is_none()
        );
    }

    #[test]
    fn a_move_that_passes_over_the_top_does_not_wall_hit() {
        // Sphere at z = 20 above a 4 m cylinder, moving laterally through
        // the axis. The XY quadratic alone would report a hit; the Z slab
        // must veto it. Start is outside the circle and outside the slab
        // with NO vertical motion -> normal_of_collision reports definite
        // (dz - end_disp_z == 0) with a radial normal, so the wall solve
        // runs and returns a time — this is retail behaviour: the Z veto
        // lives in the CALLER (collides_with_sphere gates the entry into
        // collide_with_point). Our batch sweep applies the same gate via
        // the AABB broad phase + the explicit slab check below.
        let c = cyl(0.0, 0.0, 0.0, 1.0, 4.0);
        let hit = sweep_sphere_against_cylsphere(
            &c,
            Vector3::new(5.0, 0.0, 20.0),
            Vector3::new(-10.0, 0.0, 0.0),
            0.5,
        );
        assert!(hit.is_some(), "documents the caller-side Z gate contract");
        let at = 5.0 - 10.0 * hit.unwrap().t;
        assert!(
            !cylsphere_collides_with_sphere(&c, Vector3::new(at, 0.0, 20.0), 0.5),
            "the slab predicate is what rejects the over-the-top pass"
        );
    }

    #[test]
    fn descending_onto_the_top_cap_hits_the_cap() {
        // On-axis, falling from z=10 by -10. Top cap at z=4; contact when the
        // sphere's bottom touches -> centre z = 4 + 0.5 = 4.5, travelled 5.5
        // of 10 -> t = 0.55, normal +Z.
        let c = cyl(0.0, 0.0, 0.0, 1.0, 4.0);
        let hit = sweep_sphere_against_cylsphere(
            &c,
            Vector3::new(0.0, 0.0, 10.0),
            Vector3::new(0.0, 0.0, -10.0),
            0.5,
        )
        .expect("must land");
        assert!((hit.t - 0.55).abs() < 1e-4, "t {}", hit.t);
        assert_eq!(hit.normal, Vector3::new(0.0, 0.0, 1.0));
    }

    #[test]
    fn rising_into_the_bottom_cap_hits_the_cap() {
        // On-axis, rising from z=-10 by +10. Bottom cap at z=0; contact at
        // centre z = -0.5 -> travelled 9.5 of 10 -> t = 0.95, normal -Z.
        let c = cyl(0.0, 0.0, 0.0, 1.0, 4.0);
        let hit = sweep_sphere_against_cylsphere(
            &c,
            Vector3::new(0.0, 0.0, -10.0),
            Vector3::new(0.0, 0.0, 10.0),
            0.5,
        )
        .expect("must hit the underside");
        assert!((hit.t - 0.95).abs() < 1e-4, "t {}", hit.t);
        assert_eq!(hit.normal, Vector3::new(0.0, 0.0, -1.0));
    }

    #[test]
    fn scaled_instance_blocks_proportionally() {
        // The whole point of the m_scale port: a 0.5-scaled pine has half the
        // trunk radius, so the same approach contacts LATER.
        let local = SetupCylSphere {
            origin: Vector3::zero(),
            radius: 1.0,
            height: 10.0,
        };
        let full = cylsphere_to_world(&local, 1.0, Vector3::zero(), Quaternion::identity());
        let half = cylsphere_to_world(&local, 0.5, Vector3::zero(), Quaternion::identity());
        let start = Vector3::new(5.0, 0.0, 2.0);
        let delta = Vector3::new(-10.0, 0.0, 0.0);
        let t_full = sweep_sphere_against_cylsphere(&full, start, delta, 0.5).unwrap().t;
        let t_half = sweep_sphere_against_cylsphere(&half, start, delta, 0.5).unwrap().t;
        // full: contact x = 1.5 -> t 0.35 ; half: contact x = 1.0 -> t 0.40
        assert!((t_full - 0.35).abs() < 1e-4, "{t_full}");
        assert!((t_half - 0.40).abs() < 1e-4, "{t_half}");
    }

    // ---- pushout --------------------------------------------------------

    #[test]
    fn pushout_moves_the_centre_out_to_radsum_plus_skin() {
        let c = cyl(0.0, 0.0, 0.0, 1.0, 4.0);
        let centre = Vector3::new(0.4, 0.0, 2.0);
        let push = cylsphere_pushout_xy(&c, centre, 0.5, 1e-3).expect("penetrating");
        let out = Vector3::new(centre.x + push.x, centre.y + push.y, centre.z);
        let d = (out.x * out.x + out.y * out.y).sqrt();
        let want = cylsphere_radsum(&c, 0.5) + 1e-3;
        assert!((d - want).abs() < 1e-5, "d {d} want {want}");
        assert_eq!(push.z, 0.0, "lateral only — Z stays the floor snap's job");
    }

    #[test]
    fn pushout_is_none_when_clear() {
        let c = cyl(0.0, 0.0, 0.0, 1.0, 4.0);
        assert!(cylsphere_pushout_xy(&c, Vector3::new(9.0, 0.0, 2.0), 0.5, 1e-3).is_none());
    }

    #[test]
    fn pushout_is_none_exactly_on_the_axis() {
        let c = cyl(0.0, 0.0, 0.0, 1.0, 4.0);
        assert!(cylsphere_pushout_xy(&c, Vector3::new(0.0, 0.0, 2.0), 0.5, 1e-3).is_none());
    }

    // ---- batch ----------------------------------------------------------

    #[test]
    fn batch_columns_stay_parallel() {
        let mut b = SceneryColliderBatch::with_capacity(3);
        b.push_cylinder(
            0x0200_02D3,
            Aabb::new(Vector3::zero(), Vector3::new(1.0, 1.0, 1.0)),
            cyl(1.0, 2.0, 3.0, 1.5, 20.0),
            0.6,
        );
        b.push_cylinder(
            0x0200_0258,
            Aabb::new(Vector3::zero(), Vector3::new(2.0, 2.0, 2.0)),
            cyl(4.0, 5.0, 6.0, 1.1, 30.0),
            1.2,
        );
        b.push_sphere(
            0x0200_1064,
            Aabb::new(Vector3::zero(), Vector3::new(3.0, 3.0, 3.0)),
            Vector3::new(7.0, 8.0, 9.0),
            0.961,
            1.0,
        );
        assert_eq!(b.len(), 3);
        assert_eq!(b.did[1], 0x0200_0258);
        assert_eq!(b.cyl_at(0).radius, 1.5);
        assert_eq!(b.cyl_at(1).low_pt, Vector3::new(4.0, 5.0, 6.0));
        assert_eq!(b.scale[1], 1.2);
        assert_eq!(b.kind[2], SceneryPrimKind::Sphere);
        assert_eq!(b.prim_height[2], 0.0, "sphere rows carry no height");
        assert_eq!(b.rung_counts(), (2, 1));
        let mut c = SceneryColliderBatch::new();
        c.extend_from(&b);
        assert_eq!(c.len(), 3);
        assert_eq!(c.rung_counts(), (2, 1));
        c.clear();
        assert!(c.is_empty());
    }

    /// A placement whose Setup carries 3 cylspheres becomes 3 rows sharing
    /// one did / aabb / scale. Retail walks the whole array
    /// (`v10 += 20` per `CCylSphere`); 5 scenery DIDs need this.
    #[test]
    fn multi_primitive_placement_emits_one_row_per_primitive() {
        let aabb = Aabb::new(Vector3::new(-5.0, -5.0, 0.0), Vector3::new(5.0, 5.0, 10.0));
        let mut b = SceneryColliderBatch::new();
        for (i, r) in [0.4f32, 0.6, 0.8].into_iter().enumerate() {
            b.push_cylinder(
                0x0200_04BF,
                aabb,
                cyl(i as f32, 0.0, 0.0, r, 4.0),
                1.0,
            );
        }
        assert_eq!(b.len(), 3);
        assert!(b.did.iter().all(|d| *d == 0x0200_04BF));
        assert!(b.aabb.iter().all(|a| *a == aabb));
        assert_eq!(b.rung_counts(), (3, 0));
    }

    // ---- rung 3, CSphere ------------------------------------------------

    #[test]
    fn sphere_scale_multiplies_centre_and_radius() {
        // acclient.c:359402-359406 — same shape as the cylsphere wrapper.
        let s = SetupSphere {
            center: Vector3::new(0.0, 0.0, 0.961),
            radius: 0.961,
        };
        let (c, r) = sphere_to_world(&s, 2.0, Vector3::new(10.0, 20.0, 30.0), Quaternion::identity());
        assert!((r - 1.922).abs() < 1e-5);
        assert_eq!(c, Vector3::new(10.0, 20.0, 31.922));
    }

    #[test]
    fn sphere_predicate_is_a_plain_radsum_test() {
        // radsum = 1.0 + 0.5 - 2e-4 = 1.4998.
        let c = Vector3::zero();
        assert!(sphere_collides_with_sphere(c, 1.0, Vector3::new(1.4, 0.0, 0.0), 0.5));
        assert!(!sphere_collides_with_sphere(c, 1.0, Vector3::new(1.6, 0.0, 0.0), 0.5));
        // Unlike rung 2, Z is NOT a separate slab: distance is 3-D.
        assert!(!sphere_collides_with_sphere(c, 1.0, Vector3::new(0.0, 0.0, 1.6), 0.5));
        assert!(sphere_collides_with_sphere(c, 1.0, Vector3::new(0.0, 0.0, 1.4), 0.5));
    }

    #[test]
    fn sphere_sweep_time_is_hand_checkable() {
        // Static sphere r=1 at origin, mover r=0.5 from x=5 moving -X by 10.
        // radsum = 1.4998; contact at x = 1.4998 -> t = (5 - 1.4998)/10.
        let hit = sweep_sphere_against_sphere(
            Vector3::zero(),
            1.0,
            Vector3::new(5.0, 0.0, 0.0),
            Vector3::new(-10.0, 0.0, 0.0),
            0.5,
        )
        .expect("must hit");
        assert!((hit.t - 0.350_02).abs() < 1e-4, "t {}", hit.t);
        assert!((hit.normal.x - 1.0).abs() < 1e-4);
    }

    #[test]
    fn sphere_sweep_passing_over_the_top_misses() {
        // The 3-D solve needs no Z veto: at z = 3 the swept path never
        // reaches within radsum of a 1 m boulder.
        assert!(
            sweep_sphere_against_sphere(
                Vector3::zero(),
                1.0,
                Vector3::new(5.0, 0.0, 3.0),
                Vector3::new(-10.0, 0.0, 0.0),
                0.5,
            )
            .is_none()
        );
    }

    #[test]
    fn sphere_pushout_uses_the_cross_section_at_the_movers_height() {
        // radsum 1.4998; mover 1.0 BELOW the boulder centre -> the lateral
        // half-chord is sqrt(1.4998^2 - 1) = 1.1173, not the full radsum.
        // Pushing by the full radius would eject far harder than the
        // geometry warrants.
        let push = sphere_pushout_xy(
            Vector3::new(0.0, 0.0, 1.0),
            1.0,
            Vector3::new(0.3, 0.0, 0.0),
            0.5,
            1e-3,
        )
        .expect("penetrating");
        let out_d = 0.3 + push.x;
        let want = (1.4998f32 * 1.4998 - 1.0).sqrt() + 1e-3;
        assert!((out_d - want).abs() < 1e-3, "out {out_d} want {want}");
        assert_eq!(push.z, 0.0);
    }

    #[test]
    fn sphere_pushout_is_none_when_clear() {
        assert!(
            sphere_pushout_xy(Vector3::zero(), 1.0, Vector3::new(9.0, 0.0, 0.0), 0.5, 1e-3)
                .is_none()
        );
    }

    // ---- census ground-truth parameters ---------------------------------

    /// Per-DID cylsphere params straight out of the world-scale census
    /// (`/mnt/wbterminal2/buildbox-2026-07-27/census/census-summary.md` §4).
    /// These are the models the live client actually meets, so the port is
    /// pinned against their real numbers rather than round test values.
    #[test]
    fn census_ground_truth_models_behave_sanely() {
        struct M {
            did: u32,
            origin: Vector3,
            r: f32,
            h: f32,
        }
        let models = [
            // 0x020002D3: origin sunk 3.8 m BELOW the placement point.
            M { did: 0x0200_02D3, origin: Vector3::new(0.0, 0.0, -3.8), r: 1.530, h: 34.606 },
            // 0x02000258: non-zero X origin AND negative Z.
            M { did: 0x0200_0258, origin: Vector3::new(0.05, 0.0, -1.902), r: 1.090, h: 23.020 },
            M { did: 0x0200_0246, origin: Vector3::zero(), r: 0.850, h: 3.334 },
        ];
        for m in models {
            let local = SetupCylSphere { origin: m.origin, radius: m.r, height: m.h };
            // Placement at a plausible world spot, 8x scale (the census's
            // observed maximum from ObjectDesc.MaxScale).
            let place = Vector3::new(1000.0, 2000.0, 50.0);
            let w = cylsphere_to_world(&local, 8.0, place, Quaternion::identity());
            assert!((w.radius - m.r * 8.0).abs() < 1e-3, "{:08X} radius", m.did);
            assert!((w.height - m.h * 8.0).abs() < 1e-2, "{:08X} height", m.did);
            // The sunk origin must land BELOW the placement point, scaled.
            assert!(
                (w.low_pt.z - (place.z + m.origin.z * 8.0)).abs() < 1e-2,
                "{:08X} low_pt.z {} — origin must be SCALED, not just translated",
                m.did,
                w.low_pt.z
            );
            assert!(
                (w.low_pt.x - (place.x + m.origin.x * 8.0)).abs() < 1e-3,
                "{:08X} low_pt.x — non-zero XY origins must carry through",
                m.did
            );
            // A walk straight at the trunk at mid-height must stop.
            let mid_z = w.low_pt.z + w.height * 0.5;
            let start = Vector3::new(place.x - 40.0, place.y, mid_z);
            let hit = sweep_sphere_against_cylsphere(
                &w,
                start,
                Vector3::new(80.0, 0.0, 0.0),
                0.5,
            );
            assert!(hit.is_some(), "{:08X} must block a head-on walk", m.did);
        }
    }

    /// The census's minimum real cylsphere height is 0.050 — well above the
    /// `> 0.0` guard the ingest filter uses, so no real collider is dropped
    /// by it. Pinned so a future "tidy up the epsilon" cannot silently
    /// delete the shortest colliders in the world.
    #[test]
    fn smallest_real_cylsphere_height_still_collides() {
        let c = cyl(0.0, 0.0, 0.0, 0.4, 0.050);
        assert!(cylsphere_collides_with_sphere(&c, Vector3::new(0.0, 0.0, 0.0), 0.5));
        assert!(
            sweep_sphere_against_cylsphere(
                &c,
                Vector3::new(5.0, 0.0, 0.0),
                Vector3::new(-10.0, 0.0, 0.0),
                0.5,
            )
            .is_some()
        );
    }

    #[test]
    fn swept_bounds_cover_both_ends() {
        let a = swept_sphere_bounds(Vector3::new(0.0, 0.0, 0.0), Vector3::new(3.0, 0.0, 0.0), 0.5);
        assert!(a.min.x <= -0.5 && a.max.x >= 3.5);
        assert!(aabbs_overlap(
            &a,
            &Aabb::new(Vector3::new(3.0, -1.0, -1.0), Vector3::new(4.0, 1.0, 1.0))
        ));
        assert!(!aabbs_overlap(
            &a,
            &Aabb::new(Vector3::new(9.0, -1.0, -1.0), Vector3::new(10.0, 1.0, 1.0))
        ));
    }
}
