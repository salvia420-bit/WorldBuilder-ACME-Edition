//! `CTransition` recursive SPINE (Phase-3 B2b) — the swept-step DRIVER on top of
//! the Phase-2 resolver (`BSPTREE::find_collisions`, reached through the cell
//! vtable) and the cell-dispatch layer (`driver_cell_dispatch`). Ported
//! decomp-faithfully from `acclient.c`:
//!
//! - [`CTransition::transitional_insert`] — `acclient.c:312834` (the engine)
//! - [`CTransition::step_down`]           — `acclient.c:312629`
//! - [`CTransition::step_up`] (+`step_up_impl`) — `acclient.c:312794` (A08 body)
//! - [`CTransition::check_walkable`]      — `acclient.c:312475`
//!
//! ## Cell-world threading (B2 reconciliation, design decision #2)
//! The decomp reaches the world's cell registry through ambient globals
//! (`CObjCell::find_cell_list`, `vfptr[5]`). Rust has no ambient globals and we
//! must NOT add an `Rc<dyn CellWorld>` field to `CTransition` (it would break its
//! `derive(Debug)`/`Default`). So `world: &dyn CellWorld` is threaded as an
//! explicit PARAM through `transitional_insert`/`step_down`/`check_walkable` and
//! the dispatch methods (`check_other_cells`/`build_cell_array`).
//!
//! The ONE method that cannot take `world` as a param is [`CTransition::step_up`]:
//! its signature is pinned by the committed Phase-2 caller
//! `resolver_slide::step_sphere_up` (`transition.step_up(&gnormal)`). To let that
//! resolver→`step_up` boundary still reach the world, [`transitional_insert`]
//! installs `world` (and the recursion depth) into a thread-local
//! [`DriverCtx`] scope guard for the life of its frame; `step_up` recovers it and
//! forwards to [`step_up_impl`]. Called OUTSIDE any driver sweep (no ctx — the
//! resolver/types unit tests), `step_up` returns `0`, i.e. the old B1 stub's
//! "did not step up → fall through to `step_up_slide`" behaviour, so the
//! committed resolver tests keep passing.
//!
//! ## Recursion-depth guard (A15 R1 — highest-value safety net)
//! Every `transitional_insert` entry bumps a thread-local depth counter and
//! `debug_assert!`s it stays below [`TRANSITIONAL_INSERT_MAX_DEPTH`]. This covers
//! BOTH recursion edges (self-recursion AND `check_walkable`→`transitional_insert`,
//! since both reach `transitional_insert`, which is where the guard lives).
//! Retail depth is ~1–2; a stuck convergence latch (`collide` / `check_walkables`
//! / the Placement re-insert) would otherwise stack-overflow a real client.

use std::cell::Cell;

use super::objcell::CellWorld;
use super::sphere_slide::{self, SlideSphere};
use super::types::{
    object_info_state, CTransition, CollisionInfo, InsertType, LandDefs, SpherePath, Z_FOR_LANDING,
};
use holtburger_common::{Sphere, Vector3};

/// Debug recursion ceiling for the `transitional_insert` cluster (A15 R1).
/// Retail converges in ~1–2 frames; 16 is a generous "this is runaway" bound.
pub const TRANSITIONAL_INSERT_MAX_DEPTH: u32 = 16;

// ─── Ambient driver context (the resolver→step_up bridge + depth guard) ──────

thread_local! {
    /// The `&dyn CellWorld` the current outermost `transitional_insert` frame is
    /// running against, lifetime-erased to `'static` (see `DriverCtx::enter`).
    static CTX_WORLD: Cell<Option<&'static dyn CellWorld>> = const { Cell::new(None) };
    /// Current `transitional_insert` recursion depth (0 = no driver frame live).
    static CTX_DEPTH: Cell<u32> = const { Cell::new(0) };
}

/// Scoped driver context. Installs `world` + bumps the recursion depth for the
/// life of one `transitional_insert` frame and restores both on `Drop`.
struct DriverCtx {
    prev_world: Option<&'static dyn CellWorld>,
    prev_depth: u32,
}

impl DriverCtx {
    /// Install `world` + `depth+1` for this frame; returns the restore guard.
    fn enter(world: &dyn CellWorld) -> Self {
        // SAFETY: we lifetime-extend `world` to `'static` only to park it in a
        // thread-local. It is dereferenced (via `current_world`) ONLY while this
        // guard is alive — i.e. strictly inside the `transitional_insert` body
        // that received `world` by shared borrow — and the guard restores the
        // previous pointer on drop. No `&'static` ever escapes a frame.
        let static_world: &'static dyn CellWorld = unsafe { core::mem::transmute(world) };
        let prev_world = CTX_WORLD.with(|c| c.replace(Some(static_world)));
        let prev_depth = CTX_DEPTH.with(|c| c.get());
        CTX_DEPTH.with(|c| c.set(prev_depth + 1));
        DriverCtx { prev_world, prev_depth }
    }

    /// Current recursion depth (post-`enter`).
    fn depth() -> u32 {
        CTX_DEPTH.with(|c| c.get())
    }

    /// The ambient world, if a driver frame is live.
    fn current_world() -> Option<&'static dyn CellWorld> {
        CTX_WORLD.with(|c| c.get())
    }
}

impl Drop for DriverCtx {
    fn drop(&mut self) {
        CTX_WORLD.with(|c| c.set(self.prev_world));
        CTX_DEPTH.with(|c| c.set(self.prev_depth));
    }
}

impl CTransition {
    // ───────────────────────────────────────────────────────────────────────
    // CTransition::transitional_insert — acclient.c:312834
    // ───────────────────────────────────────────────────────────────────────
    /// `signed int CTransition::transitional_insert(CTransition*, int
    /// num_insertion_attempts)` — the engine. Each `while(2)` iteration runs
    /// `insert_into_cell` once, dispatches on the `1/2/3/4` result through the
    /// decomp's `switch` + `LABEL_11`/`LABEL_38` ladder, and recurses into
    /// `check_walkable`/`step_up`/`step_down`/itself. Returns the `1/2/3/4` code
    /// (or `0`).
    // acclient.c:312834
    pub fn transitional_insert(&mut self, world: &dyn CellWorld, num_insertion_attempts: i32) -> i32 {
        // Install the ambient world + bump the recursion-depth guard (A15 R1).
        let _ctx = DriverCtx::enter(world);
        debug_assert!(
            DriverCtx::depth() < TRANSITIONAL_INSERT_MAX_DEPTH,
            "CTransition::transitional_insert recursion too deep ({}); a convergence \
             latch (collide / check_walkables / Placement insert) failed to terminate",
            DriverCtx::depth()
        );

        // acclient.c:312859-312860 — no candidate cell ⇒ trivially OK.
        if self.sphere_path.check_cell.is_none() {
            return 1;
        }
        // acclient.c:312861-312865 — v5 = 0, i = 0; non-positive attempts → v5.
        let mut v5: i32 = 0;
        let mut ts: i32;
        let mut i: i32 = 0;
        if num_insertion_attempts <= 0 {
            return v5; // 0
        }

        // acclient.c:312866 — `while ( 2 )`.
        loop {
            // acclient.c:312868-312869 — resolve check_cell (Option<u32> id) to
            // its live cell handle through `world`, then insert. The decomp holds
            // a raw `CObjCell*`; we re-resolve each iteration (check_cell may move).
            let cell = self.sphere_path.check_cell.and_then(|id| world.get_visible(id));
            v5 = self.insert_into_cell(cell.as_deref(), num_insertion_attempts);
            ts = v5;

            // acclient.c:312870 — switch ( v5 ).
            match v5 {
                // case 1 (OK) — acclient.c:312872-312880.
                1 => {
                    let curr = self.sphere_path.check_cell; // re-read (decomp does)
                    let v6 = self.check_other_cells(world, curr);
                    v5 = v6;
                    ts = v6;
                    if v6 != 1 {
                        self.sphere_path.neg_poly_hit = false;
                    }
                    if v6 == 2 {
                        return 2; // LABEL_50
                    }
                    // goto LABEL_11
                }
                // case 4 (SLID): drop the contact plane — acclient.c:312881-312884.
                4 => {
                    self.collision_info.contact_plane = None;
                    self.collision_info.contact_plane_is_water = false;
                    self.sphere_path.neg_poly_hit = false; // $L99778
                                                           // goto LABEL_11
                }
                // case 3 (ADJUSTED): $L99778 — acclient.c:312885-312888.
                3 => {
                    self.sphere_path.neg_poly_hit = false;
                    // goto LABEL_11
                }
                // case 2 (COLLIDED) — acclient.c:312889-312892.
                2 => {
                    self.sphere_path.neg_poly_hit = false;
                    return v5; // 2
                }
                // default — acclient.c:312893.
                _ => {
                    // goto LABEL_11
                }
            }

            // acclient.c:312894-312896 — LABEL_11.
            if v5 == 1 {
                // ── collide block (acclient.c:312897-312941). Always returns. ──
                if self.sphere_path.collide {
                    let v15 = self.collision_info.contact_plane.is_some();
                    let mut v16 = false;
                    self.sphere_path.collide = false; // snapshot BEFORE reset

                    // short-circuit: check_walkable only if v15 (contact valid).
                    if v15 && self.check_walkable(world, Z_FOR_LANDING) != 0 {
                        // re-insert under Placement — acclient.c:312904-312912.
                        self.sphere_path.backup = self.sphere_path.insert_type;
                        self.sphere_path.insert_type = InsertType::Placement;
                        v5 = self.transitional_insert(world, num_insertion_attempts);
                        self.sphere_path.insert_type = self.sphere_path.backup;
                        if v5 != 1 {
                            v5 = 1;
                            v16 = true; // LABEL_45
                        }
                    } else {
                        v16 = true; // LABEL_45
                    }

                    self.sphere_path.walkable = None; // acclient.c:312919
                    if v16 {
                        self.sphere_path.restore_check_pos(); // acclient.c:312922
                        // *(v17+24)=0 / *(v17+52)=0 — acclient.c:312923-312925.
                        self.collision_info.contact_plane = None;
                        self.collision_info.contact_plane_is_water = false;
                        if self.collision_info.last_known_contact_plane.is_some() {
                            // acclient.c:312928-312929.
                            self.object_info.kill_velocity(); // SEAM(B3): CPhysicsObj
                            self.collision_info.last_known_contact_plane = None;
                            return 2; // LABEL_50
                        } else {
                            // acclient.c:312935.
                            let n = self.sphere_path.step_up_normal;
                            self.collision_info.set_collision_normal(n);
                            return 2;
                        }
                    }
                    return v5; // acclient.c:312940 — v16 == false ⇒ return v5 (==1)
                }

                // ── neg_poly_hit graze (acclient.c:312942-312960) → LABEL_38. ──
                if self.sphere_path.neg_poly_hit
                    && !self.sphere_path.step_down
                    && !self.sphere_path.step_up
                {
                    let v7 = self.sphere_path.neg_step_up == 0;
                    self.sphere_path.neg_poly_hit = false;
                    if v7 {
                        // CSphere::slide_sphere with the ALREADY-GLOBAL negated
                        // normal (no rotation) — acclient.c:312948-312953.
                        let sphere = self.sphere_path.global_sphere[0];
                        let neg_normal = self.sphere_path.neg_collision_normal;
                        let curr = self.sphere_path.global_curr_center;
                        v5 = csphere_slide_sphere(
                            &sphere,
                            &mut self.sphere_path,
                            &mut self.collision_info,
                            &neg_normal,
                            &curr,
                        );
                    } else {
                        // first-sphere graze: try step-up; else slide fallback —
                        // acclient.c:312955-312958. (copy the arg out first: it
                        // can't borrow a field of `self` while taking `&mut self`.)
                        let neg_normal = self.sphere_path.neg_collision_normal;
                        if self.step_up_impl(world, &neg_normal) == 0 {
                            v5 = self
                                .sphere_path
                                .step_up_slide(&self.object_info, &mut self.collision_info);
                        }
                        // step_up succeeded ⇒ v5 stays 1.
                    }
                    // acclient.c:312959 — goto LABEL_38.
                } else {
                    // acclient.c:312961-312962.
                    if self.collision_info.contact_plane.is_some() {
                        return 1;
                    }
                    // state gate — acclient.c:312963-312965.
                    let v8 = self.object_info.state;
                    if (v8 & object_info_state::CONTACT) == 0
                        || self.sphere_path.step_down
                        || self.sphere_path.check_cell.is_none()
                        || !self.object_info.step_down
                    {
                        return 1;
                    }
                    // walkable-aware step-down params — acclient.c:312966-312972.
                    let mut step_down_ht = 0.039999999_f32;
                    let mut z_val = Z_FOR_LANDING;
                    if (v8 & object_info_state::ON_WALKABLE) != 0 {
                        z_val = self.object_info.get_walkable_z();
                        step_down_ht = self.object_info.step_down_height;
                    }
                    // acclient.c:312973-312974.
                    self.sphere_path.walkable_allowance = z_val;
                    self.sphere_path.save_check_pos();
                    // single-sphere clamp — acclient.c:312975-312980.
                    if self.sphere_path.num_sphere < 2 {
                        let r = self.sphere_path.global_sphere[0].radius;
                        if r + r < step_down_ht {
                            step_down_ht = r * 0.5;
                        }
                    }
                    // acclient.c:312981-313006.
                    let v10 = self.sphere_path.global_sphere[0].radius;
                    let v11 = z_val;
                    if v10 + v10 >= step_down_ht {
                        let v13 = step_down_ht;
                        if self.step_down(world, step_down_ht, z_val) != 0 {
                            self.sphere_path.walkable = None; // LABEL_52
                            return 1;
                        }
                        let v14 = self.edge_slide(&mut ts, v13, v11); // SEAM(B3)
                        if v14 != 0 {
                            return ts; // LABEL_36
                        }
                        v5 = ts;
                        // fall through to LABEL_38
                    } else {
                        // half-height; retry twice with the SAME args.
                        let v22 = step_down_ht * 0.5;
                        let v12 = v22;
                        if self.step_down(world, v22, z_val) == 0
                            && self.step_down(world, v12, v11) == 0
                        {
                            let v14 = self.edge_slide(&mut ts, v12, v11); // SEAM(B3)
                            if v14 != 0 {
                                return ts; // LABEL_36
                            }
                            v5 = ts;
                            // fall through to LABEL_38
                        } else {
                            // a step_down landed ⇒ LABEL_52.
                            self.sphere_path.walkable = None;
                            return 1;
                        }
                    }
                }
            } // end big block (v5 == 1)

            // acclient.c:313000-313005 — LABEL_38 (common tail).
            i += 1;
            if i >= num_insertion_attempts {
                return v5;
            }
            // continue the `while ( 2 )` loop.
        }
    }

    // ───────────────────────────────────────────────────────────────────────
    // CTransition::step_down — acclient.c:312629
    // ───────────────────────────────────────────────────────────────────────
    /// `int CTransition::step_down(CTransition*, float step_down_ht, float
    /// z_val)`. Sweeps the sphere down `step_down_ht`, re-inserts (attempts 5),
    /// and — if it lands on a sufficiently-flat, walkable contact plane —
    /// re-pins the position with a Placement insert (attempts 1). Returns `1`
    /// iff the landing is accepted.
    // acclient.c:312629
    pub fn step_down(&mut self, world: &dyn CellWorld, step_down_ht: f32, z_val: f32) -> i32 {
        // acclient.c:312644-312647.
        self.sphere_path.neg_poly_hit = false;
        self.sphere_path.step_down = true;
        self.sphere_path.step_down_amt = step_down_ht;
        self.sphere_path.walk_interp = 1.0;

        // acclient.c:312648-312661 — when NOT mid step-up, drop check_pos by
        // step_down_ht (the inlined add_offset_to_check_pos of (0,0,-h)).
        if !self.sphere_path.step_up {
            self.sphere_path
                .add_offset_to_check_pos(&Vector3::new(0.0, 0.0, -step_down_ht));
        }

        // acclient.c:312662-312663.
        let v8 = self.transitional_insert(world, 5);
        self.sphere_path.step_down = false;

        // acclient.c:312664-312669 — accept iff: insert OK, valid contact plane,
        // its normal steep-enough (N.z >= z_val), and either NOT edge-slide mode,
        // OR stepping up, OR the deeper check_walkable passes. The trailing `||`
        // keeps check_walkable's side effects gated to the last clause.
        let accept = v8 == 1
            && self
                .collision_info
                .contact_plane
                .map_or(false, |p| p.normal.z >= z_val)
            && ((self.object_info.state & object_info_state::EDGE_SLIDE) == 0
                || self.sphere_path.step_up
                || self.check_walkable(world, z_val) != 0);

        if accept {
            // acclient.c:312671-312675 — Placement re-pin (attempts 1).
            self.sphere_path.backup = self.sphere_path.insert_type;
            self.sphere_path.insert_type = InsertType::Placement;
            let v10 = self.transitional_insert(world, 1);
            self.sphere_path.insert_type = self.sphere_path.backup;
            (v10 == 1) as i32
        } else {
            0 // acclient.c:312679.
        }
    }

    // ───────────────────────────────────────────────────────────────────────
    // CTransition::step_up — acclient.c:312794 (A08 body)
    // ───────────────────────────────────────────────────────────────────────
    /// `int CTransition::step_up(CTransition*, Vector3* collision_normal)`.
    /// Resolver-facing shim (signature pinned by `resolver_slide::step_sphere_up`).
    /// Recovers the ambient `world` from the [`DriverCtx`] thread-local installed
    /// by the enclosing `transitional_insert` and forwards to [`step_up_impl`];
    /// with NO ambient driver context it returns `0` (the B1 "did not step up →
    /// slide fallback" behaviour, preserving the committed resolver/types tests).
    // acclient.c:312794
    pub fn step_up(&mut self, collision_normal: &Vector3) -> i32 {
        match DriverCtx::current_world() {
            Some(world) => self.step_up_impl(world, collision_normal),
            None => 0,
        }
    }

    /// The faithful `CTransition::step_up` body (A08). Latches step-up state,
    /// snapshots the check position, delegates to `step_down` (using
    /// `step_up_height` as the drop and the walkable-Z as the threshold).
    /// Returns `1` on success; on failure rewinds the check position and `0`.
    // acclient.c:312794
    pub fn step_up_impl(&mut self, world: &dyn CellWorld, collision_normal: &Vector3) -> i32 {
        // acclient.c:312803-312806 — drop any contact plane, latch the step.
        self.collision_info.contact_plane = None;
        self.collision_info.contact_plane_is_water = false;
        self.sphere_path.step_up = true;
        self.sphere_path.step_up_normal = *collision_normal;

        // acclient.c:312807-312813 — defaults, relaxed when ON_WALKABLE.
        let mut step_down_ht = 0.039999999_f32;
        let mut walkable_z = Z_FOR_LANDING;
        if (self.object_info.state & object_info_state::ON_WALKABLE) != 0 {
            walkable_z = self.object_info.get_walkable_z();
            step_down_ht = self.object_info.step_up_height; // NOTE: step_UP height
        }
        self.sphere_path.walkable_allowance = walkable_z; // acclient.c:312814

        // acclient.c:312815-312817 — snapshot check_cell / check_pos to backup.
        self.sphere_path.backup_cell = self.sphere_path.check_cell;
        self.sphere_path.backup_check_pos = self.sphere_path.check_pos; // objcell_id + frame

        // acclient.c:312818-312820 — the actual settle.
        let v3 = self.step_down(world, step_down_ht, walkable_z);
        self.sphere_path.step_up = false;
        self.sphere_path.walkable = None;

        // acclient.c:312821-312829.
        if v3 != 0 {
            1
        } else {
            self.sphere_path.restore_check_pos();
            0
        }
    }

    // ───────────────────────────────────────────────────────────────────────
    // CTransition::check_walkable — acclient.c:312475
    // ───────────────────────────────────────────────────────────────────────
    /// `int CTransition::check_walkable(CTransition*, float z_chk)`. Probes
    /// whether, after dropping by a (clamped) `step_down_height`, the sphere can
    /// still rest on its walkable surface. Returns `1` when the probe fails to
    /// re-insert cleanly (NOT a stable walkable), else `0`; trivially `1` when
    /// not on a walkable or the cached walkable still validates (the
    /// `check_walkables` convergence gate, A15 D1/R1/D4).
    // acclient.c:312475
    pub fn check_walkable(&mut self, world: &dyn CellWorld, z_chk: f32) -> i32 {
        // acclient.c:312490-312494 — the convergence gate. `||` keeps the
        // `check_walkables` SEAM un-called in the not-on-walkable case.
        // (Foundation `check_walkables` returns the decomp `int`; `!= 0` == still
        // walkable.)
        if (self.object_info.state & object_info_state::ON_WALKABLE) == 0
            || self.sphere_path.check_walkables() != 0
        {
            return 1;
        }

        // acclient.c:312497-312501 — snapshot to restore afterward (Position is
        // Copy ⇒ objcell_id + frame, the decomp's assign + Frame::operator=).
        let backup_check_pos = self.sphere_path.check_pos;
        let v5 = self.sphere_path.check_cell;

        // acclient.c:312502-312505.
        let mut v6 = self.object_info.step_down_height;
        let v7 = self.sphere_path.num_sphere < 2;
        self.sphere_path.walkable_allowance = z_chk;
        self.sphere_path.check_walkable = true;

        // acclient.c:312506-312511 — single-sphere clamp.
        if v7 {
            let r = self.sphere_path.global_sphere[0].radius;
            if v6 > r + r {
                v6 = r * 0.5;
            }
        }
        // acclient.c:312512-312513 — general clamp.
        let r0 = self.sphere_path.global_sphere[0].radius;
        if v6 > r0 + r0 {
            v6 *= 0.5;
        }

        // acclient.c:312514-312518 — drop by v6 and re-insert (attempts 1).
        let offset = Vector3::new(0.0, 0.0, -v6);
        self.sphere_path.add_offset_to_check_pos(&offset);
        let v9 = self.transitional_insert(world, 1);

        // acclient.c:312519-312521 — un-latch, restore, report.
        self.sphere_path.check_walkable = false;
        self.sphere_path.set_check_pos(&backup_check_pos, v5);
        (v9 != 1) as i32
    }

    /// SEAM(B3): `CTransition::edge_slide` (`acclient.c:312685`, agent A05).
    /// Drives `cliff_slide`/`precipice_slide`/step-down-then-precipice when a
    /// swept step ends unsupported past a finite surface boundary. NOT ported in
    /// B2 (depends on `cliff_slide`/`adjust_offset`, A05/B3). Returns `0` ("made
    /// no progress") so `transitional_insert` takes the `v5 = ts` → LABEL_38
    /// fall-through rather than the LABEL_36 early-return — the safe default
    /// (the outer loop still bounds it). B3 MUST port the real body and thread
    /// `world` (it reaches `transitional_insert`/`step_down`).
    // acclient.c:312685
    fn edge_slide(&mut self, ts: &mut i32, step_down_ht: f32, z_val: f32) -> i32 {
        let _ = (ts, step_down_ht, z_val);
        0
    }
}

/// Driver-shaped `CSphere::slide_sphere(this, path, collisions, normal,
/// curr_center)` (`acclient.c:358899`) — the heavy slide leaf that BOTH mutates
/// `path`/`collisions` and returns the `2`/`3`/`4` code.
/// `transitional_insert`'s neg-graze branch calls it DIRECTLY with an
/// ALREADY-GLOBAL, already-negated normal (`neg_collision_normal`), so — unlike
/// `BSPTREE::slide_sphere` — there is NO local→global rotation here.
///
/// Reuses the Phase-1 pure leaf [`sphere_slide::slide_sphere`] and replays the
/// side effects exactly as the inline copies in `resolver_slide.rs` /
/// `spherepath_methods.rs` (`step_up_slide`) do (the RECONCILE banners there ask
/// the fix loop to hoist ONE shared wrapper; this is the third identical replay
/// until then).
// acclient.c:358899 (driver form)
fn csphere_slide_sphere(
    sphere: &Sphere,         // path->global_sphere[0] (CSphere* `this`)
    path: &mut SpherePath,
    collisions: &mut CollisionInfo,
    normal: &Vector3,        // GLOBAL, already negated (no rotation)
    curr_center: &Vector3,   // path->global_curr_center
) -> i32 {
    let center = sphere.center;
    // N: contact_plane when valid, else last_known_contact_plane, else zero.
    let contact_plane_normal = collisions
        .contact_plane
        .or(collisions.last_known_contact_plane)
        .map(|p| p.normal)
        .unwrap_or_else(Vector3::zero);
    // block_offset = LandDefs::get_block_offset(curr_pos, check_pos); 0 within
    // one landblock (acclient.c:311721 form, threaded like step_up_slide).
    let block_offset =
        LandDefs::get_block_offset(path.curr_pos.objcell_id, path.check_pos.objcell_id);

    match sphere_slide::slide_sphere(
        center,
        *normal,
        *curr_center,
        contact_plane_normal,
        block_offset,
    ) {
        // Case 1: zero normal ⇒ split the gap; NO set_collision_normal. → 3.
        SlideSphere::Adjusted { offset } => {
            path.add_offset_to_check_pos(&offset);
            3
        }
        // Cases 3/4: set_collision_normal FIRST, then offset. → 4.
        SlideSphere::Slid { offset } => {
            collisions.set_collision_normal(*normal);
            path.add_offset_to_check_pos(&offset);
            4
        }
        // Cases 2/5: set_collision_normal; case 5 also records normalize(-gDelta). → 2.
        SlideSphere::Collided { recomputed_normal } => {
            collisions.set_collision_normal(*normal);
            if let Some(recomputed) = recomputed_normal {
                collisions.set_collision_normal(recomputed);
            }
            2
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use holtburger_common::Vector3;

    fn v(x: f32, y: f32, z: f32) -> Vector3 {
        Vector3::new(x, y, z)
    }

    // A minimal no-cell world (get_visible always None) for the seam-free
    // early-return paths that never resolve a cell.
    struct EmptyWorld;
    impl CellWorld for EmptyWorld {
        fn get_visible(&self, _cell_id: u32) -> Option<std::rc::Rc<dyn super::super::objcell::CObjCell>> {
            None
        }
        fn add_all_outside_cells(
            &self,
            _p: &super::super::types::Position,
            _n: u32,
            _s: &[Sphere],
            _ca: &mut dyn super::super::objcell::CellArrayApi,
        ) {
        }
        fn block_offset(&self, _b: u32, _o: u32) -> Vector3 {
            Vector3::zero()
        }
    }

    // ── transitional_insert: seam-free early returns (acclient.c:312859-312865) ──

    #[test]
    fn transitional_insert_ok_when_no_check_cell() {
        let mut t = CTransition::default();
        assert!(t.sphere_path.check_cell.is_none());
        assert_eq!(t.transitional_insert(&EmptyWorld, 3), 1);
        assert!(!t.sphere_path.collide);
        assert_eq!(t.sphere_path.insert_type, InsertType::Transition);
    }

    #[test]
    fn transitional_insert_zero_for_nonpositive_attempts() {
        let mut t = CTransition::default();
        t.sphere_path.check_cell = Some(1);
        assert_eq!(t.transitional_insert(&EmptyWorld, 0), 0);

        let mut t2 = CTransition::default();
        t2.sphere_path.check_cell = Some(7);
        assert_eq!(t2.transitional_insert(&EmptyWorld, -3), 0);
    }

    // ── check_walkable: trivial gate (acclient.c:312490-312494) ──

    #[test]
    fn check_walkable_trivial_when_not_on_walkable() {
        let mut t = CTransition::default();
        t.object_info.state = object_info_state::CONTACT; // ON_WALKABLE (0x2) NOT set
        t.sphere_path.walkable_allowance = 0.5;
        t.sphere_path.check_pos.frame.origin = v(1.0, 2.0, 3.0);

        assert_eq!(t.check_walkable(&EmptyWorld, Z_FOR_LANDING), 1);

        assert!(!t.sphere_path.check_walkable);
        assert_eq!(t.sphere_path.walkable_allowance, 0.5);
        assert_eq!(t.sphere_path.check_pos.frame.origin, v(1.0, 2.0, 3.0));
    }

    #[test]
    fn check_walkable_trivial_for_default_state() {
        let mut t = CTransition::default();
        assert_eq!(t.check_walkable(&EmptyWorld, 0.0871557), 1);
        assert!(!t.sphere_path.check_walkable);
    }

    // ── step_up: no ambient driver context ⇒ returns 0 (B1 fall-through) ──

    #[test]
    fn step_up_without_driver_context_returns_zero() {
        // Mirrors the resolver/types call shape: step_up invoked OUTSIDE a
        // transitional_insert frame ⇒ no thread-local world ⇒ 0 (slide fallback).
        let mut t = CTransition::default();
        assert_eq!(t.step_up(&v(0.0, 0.0, 1.0)), 0);
        assert!(DriverCtx::current_world().is_none());
    }

    // ── csphere_slide_sphere: zero normal splits the gap (case 1 → 3) ──

    #[test]
    fn csphere_slide_zero_normal_splits_gap() {
        let mut path = SpherePath::default();
        path.num_sphere = 1;
        path.global_sphere[0] = Sphere { center: v(0.0, 0.0, 0.0), radius: 1.0 };
        let curr = v(4.0, 0.0, 0.0);
        let mut ci = CollisionInfo::default();
        ci.last_known_contact_plane = Some(holtburger_common::Plane {
            normal: v(0.0, 0.0, 1.0),
            d: 0.0,
        });
        let sphere = path.global_sphere[0];
        let r = csphere_slide_sphere(&sphere, &mut path, &mut ci, &v(0.0, 0.0, 0.0), &curr);
        assert_eq!(r, 3);
        // offset = (curr - center) * 0.5 = (2,0,0); no collision normal recorded.
        assert!((path.check_pos.frame.origin - v(2.0, 0.0, 0.0)).length() < 1e-4);
        assert!(ci.collision_normal.is_none());
    }
}
