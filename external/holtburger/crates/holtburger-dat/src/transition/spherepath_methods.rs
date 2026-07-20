//! `SPHEREPATH` mutators — the path-state writers the Phase-2
//! `BSPTREE::find_collisions` resolver (agent 05) and its branch helpers
//! (agents 01–04) call to record a swept-step's outcome and to keep the
//! cached global-space sphere(s) in sync with the candidate position.
//! Ported decomp-faithfully from `acclient.c`.
//!
//! Owns (methods on [`super::types::SpherePath`]):
//! - [`SpherePath::cache_global_sphere`]      — `SPHEREPATH::cache_global_sphere`      (acclient.c:313748)
//! - [`SpherePath::add_offset_to_check_pos`]  — `SPHEREPATH::add_offset_to_check_pos`  (acclient.c:311557)
//! - [`SpherePath::set_collide`]              — `SPHEREPATH::set_collide`              (acclient.c:359050)
//! - [`SpherePath::set_neg_poly_hit`]         — `SPHEREPATH::set_neg_poly_hit`         (acclient.c:360743)
//! - [`SpherePath::set_walkable`]             — `SPHEREPATH::set_walkable`             (acclient.c:361094)
//! - [`SpherePath::step_up_slide`]            — `SPHEREPATH::step_up_slide`            (acclient.c:313456)
//!
//! ## RECONCILE — cross-file duplicates to remove from `collisioninfo.rs`
//! Phase 1 parked **inert** stand-ins of `add_offset_to_check_pos`,
//! `add_offset_to_check_pos_with_radius`, `set_collide` and `set_walkable` in
//! [`super::collisioninfo`] *before* the types agent fleshed `SpherePath` to
//! its full 592-byte shape. Those stubs (a) write nothing for the walkable /
//! cache side-effects and (b) reference the retired `check_pos.origin` /
//! `CellPos` shapes, so they no longer match the promoted [`Position`]
//! `check_pos`. The authoritative, field-complete Phase-2 ports now live HERE.
//! The fix loop must **delete** the `impl SpherePath { … }` block in
//! `collisioninfo.rs` (its `CollisionInfo` setters stay) so these don't
//! collide as duplicate method definitions. (`add_offset_to_check_pos_with_radius`
//! — the vestigial radius overload at `acclient.c:358526`, body identical, arg
//! unread — is intentionally NOT re-ported here: nothing in the Phase-2
//! resolver path needs it; re-add it in this file if a caller resurfaces.)
//!
//! ## RECONCILE — `step_up_slide`'s `CSphere::slide_sphere` tail
//! The decomp tail is
//! `return CSphere::slide_sphere(global_sphere, this, collisions,
//! &step_up_normal, global_curr_center);`. The Phase-1 port of
//! `CSphere::slide_sphere` ([`super::sphere_slide::slide_sphere`],
//! acclient.c:358899) is the **pure-input leaf form**: it takes resolved
//! `Vector3`s, returns a [`super::sphere_slide::SlideSphere`] verdict, and
//! surfaces (rather than applies) the decomp's `set_collision_normal` /
//! `add_offset_to_check_pos` side-effects. So [`SpherePath::step_up_slide`]
//! inlines the driver replay of those side-effects. Agent 03
//! (`resolver_slide.rs`, `BSPTREE::slide_sphere`) makes the byte-identical
//! call and needs the same replay — the fix loop should hoist it into ONE
//! shared driver-shaped `CSphere::slide_sphere(sphere, path, collisions,
//! normal, curr_center) -> i32` wrapper that both call.

use super::polygon_edge::find_crossed_edge;
use super::polygon_walkable::check_small_walkable;
use super::sphere_slide::{slide_sphere, SlideSphere};
use super::trace::trace;
use super::types::{CollisionInfo, LandDefs, ObjectInfo, Position, SpherePath};
use crate::physics::ResolvedPolygon;
use holtburger_common::{Sphere, Vector3};

impl SpherePath {
    /// `SPHEREPATH::cache_global_sphere` (`acclient.c:313748`, idb `0050BAA0`).
    /// Keeps the global-space sphere cache (`global_sphere` + `global_low_point`)
    /// consistent with the candidate position. Two modes, on the `offset`
    /// pointer:
    ///
    /// - `Some(offset)` — **slide** the already-cached centers (and the low
    ///   point) by `offset`; radii are left untouched. This is the cheap update
    ///   `add_offset_to_check_pos` uses after nudging `check_pos`.
    /// - `None` (decomp `offset == 0`) — **recompute** from scratch: map each
    ///   `local_sphere[i]` (center + radius) and `local_low_point` out of object
    ///   space through `check_pos.frame` (`Frame::localtoglobal`).
    ///
    /// Decomp (`offset` present):
    /// ```text
    /// for i in 0..num_sphere:
    ///     global_sphere[i].center += *offset;   // radius untouched
    /// global_low_point += *offset;
    /// ```
    /// Decomp (`offset == 0`):
    /// ```text
    /// for i in 0..num_sphere:
    ///     global_sphere[i].radius = local_sphere[i].radius;
    ///     global_sphere[i].center = check_pos.frame.localtoglobal(local_sphere[i].center);
    /// global_low_point = check_pos.frame.localtoglobal(local_low_point);
    /// ```
    /// (The `v12/v13/v17` and `v21/v22/v23` blocks in the idb are exactly
    /// `m_fl2gv·v + m_fOrigin` per component — `Frame::localtoglobal`.)
    ///
    /// NOTE vs. the Phase-2 spec summary ("updates global_sphere/global_curr_center
    /// from localspace_pos + offset"): the decomp transforms through
    /// `check_pos.frame` (NOT `localspace_pos`) and touches `global_sphere` +
    /// `global_low_point` only (NOT `global_curr_center`). Decomp wins.
    // acclient.c:313748
    pub fn cache_global_sphere(&mut self, offset: Option<&Vector3>) {
        let n = self.num_sphere as usize; // num_sphere is 1 or 2 in practice
        match offset {
            Some(o) => {
                // Slide the cached global centers; radii are NOT re-read.
                for i in 0..n {
                    self.global_sphere[i].center.x += o.x;
                    self.global_sphere[i].center.y += o.y;
                    self.global_sphere[i].center.z += o.z;
                }
                self.global_low_point.x += o.x;
                self.global_low_point.y += o.y;
                self.global_low_point.z += o.z;
            }
            None => {
                // Recompute through check_pos.frame (object-local → global).
                let frame = self.check_pos.frame;
                for i in 0..n {
                    self.global_sphere[i].radius = self.local_sphere[i].radius;
                    self.global_sphere[i].center = frame.localtoglobal(self.local_sphere[i].center);
                }
                self.global_low_point = frame.localtoglobal(self.local_low_point);
            }
        }
    }

    /// `SPHEREPATH::add_offset_to_check_pos` (`acclient.c:311557`, idb
    /// `00509D10`). Translates the candidate (`check_pos`) origin by `offset`,
    /// invalidates the cached cell ring, and slides the cached global sphere(s)
    /// by the same `offset`. Every swept-sphere response (slide / collide /
    /// step) nudges the moving sphere onto its valid resting position through
    /// this one entry point.
    ///
    /// Decomp:
    /// ```text
    /// this->cell_array_valid = 0;
    /// this->check_pos.frame.m_fOrigin += *offset;
    /// SPHEREPATH::cache_global_sphere(this, offset);
    /// ```
    ///
    /// Supersedes the Phase-1-inert stub in `collisioninfo.rs` (see the module
    /// RECONCILE banner): now that `cell_array_valid` exists and the cache
    /// helper is ported, both deferred side-effects are applied for real.
    // acclient.c:311557
    pub fn add_offset_to_check_pos(&mut self, offset: &Vector3) {
        self.cell_array_valid = false;
        self.check_pos.frame.origin.x += offset.x;
        self.check_pos.frame.origin.y += offset.y;
        self.check_pos.frame.origin.z += offset.z;
        self.cache_global_sphere(Some(offset));
    }

    /// `SPHEREPATH::add_offset_to_check_pos` — the radius overload
    /// (`acclient.c:358526`, idb `00536AB0` neighbour). In the retail decomp
    /// this overload's body is **byte-for-byte identical** to the no-radius one
    /// (acclient.c:311557): the `radius` argument is accepted but never read.
    /// The slide / collide callers pass `check_pos->radius`; it is a vestigial
    /// parameter. Kept as a distinct entry point so the Phase-3 driver can
    /// replay the exact retail call shape; it simply forwards.
    // acclient.c:358526
    pub fn add_offset_to_check_pos_with_radius(&mut self, offset: &Vector3, radius: f32) {
        // `radius` is unused in the retail body — bind to `_` to make the
        // vestigial-ness explicit rather than rely on the no-warn-on-param rule.
        let _ = radius;
        self.add_offset_to_check_pos(offset);
    }

    /// `SPHEREPATH::set_collide` (`acclient.c:359050`, idb `00536F70`). Latches
    /// the path into the COLLIDED state: marks `collide`, snapshots the
    /// pre-collision cell + check position into the backup slots, stores the
    /// collision normal as the step-up normal, and re-pins the walk
    /// interpolation parameter to `1.0`.
    ///
    /// Decomp:
    /// ```text
    /// v3 = this->check_cell;
    /// this->collide      = 1;
    /// this->backup_cell  = v3;
    /// this->backup_check_pos.objcell_id = this->check_pos.objcell_id;
    /// this->backup_check_pos.frame      = this->check_pos.frame;   // Frame::operator=
    /// this->step_up_normal = *collision_normal;
    /// this->walk_interp    = 1.0;                                  // 1065353216
    /// ```
    ///
    /// Supersedes the Phase-1 stub (the backup / `step_up_normal` writes were
    /// deferred there) — all writes are now field-complete.
    // acclient.c:359050
    pub fn set_collide(&mut self, collision_normal: &Vector3) {
        let prev_cell = self.check_cell; // v3 = this->check_cell (read before write)
        self.collide = true;
        self.backup_cell = prev_cell;
        self.backup_check_pos.objcell_id = self.check_pos.objcell_id;
        self.backup_check_pos.frame = self.check_pos.frame;
        self.step_up_normal = *collision_normal;
        self.walk_interp = 1.0;
    }

    /// `SPHEREPATH::set_neg_poly_hit` (`acclient.c:360743`, idb `00538890`).
    /// Records a grazing ("negative") polygon hit: which sphere grazed
    /// (`step_up`: 1 = first/contact sphere, 0 = second sphere), the latch, and
    /// the **negated** grazing normal.
    ///
    /// Decomp:
    /// ```text
    /// this->neg_step_up = step_up;
    /// this->neg_poly_hit = 1;
    /// this->neg_collision_normal.x = -collision_normal->x;
    /// this->neg_collision_normal.y = -collision_normal->y;
    /// this->neg_collision_normal.z = -collision_normal->z;
    /// ```
    /// `neg_step_up` stays `i32` (the decomp `int`) to preserve the
    /// which-sphere distinction the dispatch map passes (`0` vs `1`).
    // acclient.c:360743
    pub fn set_neg_poly_hit(&mut self, step_up: i32, collision_normal: &Vector3) {
        self.neg_step_up = step_up;
        self.neg_poly_hit = true;
        self.neg_collision_normal =
            Vector3::new(-collision_normal.x, -collision_normal.y, -collision_normal.z);
    }

    /// `SPHEREPATH::set_walkable` (`acclient.c:361094`, idb `00539FE0`). Records
    /// the walkable surface a swept sphere came to rest on: the resting sphere,
    /// the supporting polygon, the surface "up" axis, the local position, and
    /// the object scale. The driver later promotes this to a real landing (sets
    /// the `ON_WALKABLE` object state).
    ///
    /// Decomp:
    /// ```text
    /// this->walkable_check_pos = *sphere;
    /// this->walkable           = poly;                       // CPolygon*
    /// this->walkable_up        = *zaxis;
    /// this->walkable_pos.objcell_id = local_pos->objcell_id;
    /// this->walkable_pos.frame      = local_pos->frame;      // Frame::operator=
    /// this->walkable_scale     = scale;
    /// ```
    /// The decomp's `CPolygon *walkable` is modeled as an owned
    /// `Option<ResolvedPolygon>` clone (per the Phase-2 pointer convention).
    /// Supersedes the Phase-1-inert no-op port (every field now exists).
    // acclient.c:361094
    pub fn set_walkable(
        &mut self,
        sphere: &Sphere,
        poly: &ResolvedPolygon,
        zaxis: &Vector3,
        local_pos: &Position,
        scale: f32,
    ) {
        self.walkable_check_pos = *sphere;
        self.walkable = Some(poly.clone());
        self.walkable_up = *zaxis;
        self.walkable_pos.objcell_id = local_pos.objcell_id;
        self.walkable_pos.frame = local_pos.frame;
        self.walkable_scale = scale;
    }

    /// `SPHEREPATH::step_up_slide` (`acclient.c:313456`, idb `0050C390`). The
    /// slide fallback `BSPTREE::step_sphere_up` (agent 03) drops into when
    /// `CTransition::step_up` reports it could NOT step over the hit polygon:
    /// invalidate the contact plane, clear `step_up`, and slide the global
    /// sphere along its latched step-up normal from the current center.
    ///
    /// Decomp:
    /// ```text
    /// collisions->contact_plane_valid    = 0;
    /// collisions->contact_plane_is_water = 0;
    /// v3 = this->global_curr_center;
    /// this->step_up = 0;
    /// return CSphere::slide_sphere(this->global_sphere, this, collisions,
    ///                              &this->step_up_normal, v3);
    /// ```
    /// `object` (the decomp `OBJECTINFO*`) is accepted to match the retail call
    /// shape but is never read — see the no-op bind below.
    ///
    /// Returns the decomp's `signed int` slide code: `4` SLID, `3` CONTACT
    /// (split-the-gap), `2` COLLIDED — i.e. `TransitionState` as an int.
    ///
    /// The `CSphere::slide_sphere` tail is replayed inline against the Phase-1
    /// pure-leaf [`slide_sphere`] (see the module RECONCILE banner): resolve the
    /// leaf's inputs, then apply the decomp's `set_collision_normal` /
    /// `add_offset_to_check_pos` side-effects per the returned verdict.
    // acclient.c:313456
    pub fn step_up_slide(&mut self, object: &ObjectInfo, collisions: &mut CollisionInfo) -> i32 {
        // ── SPHEREPATH-local prelude (acclient.c:313459-313463). ──
        collisions.contact_plane = None; // contact_plane_valid = 0
        collisions.contact_plane_is_water = false;
        let curr_center = self.global_curr_center; // v3 = this->global_curr_center
        self.step_up = false;
        let _ = object; // OBJECTINFO* passed but never read in the retail body.

        // ── CSphere::slide_sphere(global_sphere, this, collisions,
        //    &step_up_normal, curr_center) — inline driver replay. ──
        let center = self.global_sphere[0].center; // CSphere `this` = global_sphere[0]
        let normal = self.step_up_normal;
        // N: contact_plane (just invalidated → None) falls through to
        //    last_known_contact_plane — the leaf's documented N-resolution.
        let contact_normal = self.resolve_slide_plane_normal(collisions);
        // block_offset = LandDefs::get_block_offset(curr_pos, check_pos): the
        // cross-cell landblock delta. Zero within one cell; Phase 3 threads the
        // real value through.
        let block_offset =
            LandDefs::get_block_offset(self.curr_pos.objcell_id, self.check_pos.objcell_id); // acclient.c:311721

        let outcome = slide_sphere(center, normal, curr_center, contact_normal, block_offset);
        trace(|| {
            format!(
                "    step_up_slide: center={center:?} normal(step_up_normal)={normal:?} \
                 curr_center={curr_center:?} N(contact/last_known)={contact_normal:?} \
                 block_offset={block_offset:?} -> {outcome:?}"
            )
        });
        match outcome {
            // Case 1 (zero collision normal): split the gap; NO
            // set_collision_normal. acclient.c:358921-358934 → 3.
            SlideSphere::Adjusted { offset } => {
                self.add_offset_to_check_pos(&offset);
                3
            }
            // Cases 3/4 (slide along the contact edge / back along the normal):
            // replay set_collision_normal(normal) first. acclient.c:358936 → 4.
            SlideSphere::Slid { offset } => {
                collisions.set_collision_normal(normal);
                self.add_offset_to_check_pos(&offset);
                4
            }
            // Cases 2/5 (blocked): set_collision_normal(normal); case 5 also
            // records normalize(-gDelta). acclient.c:358974 / 359003-359010 → 2.
            SlideSphere::Collided { recomputed_normal } => {
                collisions.set_collision_normal(normal);
                if let Some(recomputed) = recomputed_normal {
                    collisions.set_collision_normal(recomputed);
                }
                2
            }
        }
    }

    /// Resolve the contact-plane normal `N` the way the decomp's
    /// `CSphere::slide_sphere` does: prefer the valid `contact_plane`, else fall
    /// back to `last_known_contact_plane`; a degenerate (absent) plane yields a
    /// zero normal (the leaf then takes its zero-normal branch). Factored out so
    /// `step_up_slide` reads like the decomp tail; agent 03's reconciliation can
    /// share it.
    fn resolve_slide_plane_normal(&self, collisions: &CollisionInfo) -> Vector3 {
        collisions
            .contact_plane
            .or(collisions.last_known_contact_plane)
            .map(|p| p.normal)
            .unwrap_or_else(Vector3::zero)
    }

    /// `SPHEREPATH::save_check_pos` (`acclient.c:312083`). Snapshots
    /// `check_cell`/`check_pos` into the backup slots so the driver can rewind
    /// to them (the counterpart of [`SpherePath::restore_check_pos`]).
    // acclient.c:312083
    pub fn save_check_pos(&mut self) {
        self.backup_cell = self.check_cell;
        self.backup_check_pos.objcell_id = self.check_pos.objcell_id;
        self.backup_check_pos.frame = self.check_pos.frame; // Frame::operator=
    }

    /// `SPHEREPATH::restore_check_pos` (`acclient.c:312528`). Rewinds
    /// `check_pos`/`check_cell` to the backup snapshot, invalidates the cell
    /// ring, and re-caches the global sphere from scratch (`offset == 0` ⇒
    /// recompute through `check_pos.frame`).
    // acclient.c:312528
    pub fn restore_check_pos(&mut self) {
        self.check_pos.objcell_id = self.backup_check_pos.objcell_id;
        self.check_pos.frame = self.backup_check_pos.frame; // Frame::operator=
        self.check_cell = self.backup_cell;
        self.cell_array_valid = false;
        self.cache_global_sphere(None); // offset = 0 → recompute
    }

    /// `SPHEREPATH::adjust_check_pos` (`acclient.c:313962`). Re-bases `check_pos`
    /// into `cell_id`'s landblock frame. For an OUTDOOR target
    /// (`cell_id & 0xFFFF < 0x100`) it slides the cached global sphere by the
    /// cross-landblock delta `LandDefs::get_block_offset(cell_id,
    /// check_pos.objcell_id)` and shifts the `check_pos` origin by the same
    /// delta; an interior target only retags the id. Always stores `cell_id`.
    ///
    /// Decomp:
    /// ```text
    /// if ((u16)cell_id < 0x100) {
    ///     LandDefs::get_block_offset(&offset, cell_id, check_pos.objcell_id);
    ///     cache_global_sphere(&offset);
    ///     check_pos.frame.m_fOrigin += offset;
    /// }
    /// check_pos.objcell_id = cell_id;
    /// ```
    // acclient.c:313962
    pub fn adjust_check_pos(&mut self, cell_id: u32) {
        if (cell_id & 0xFFFF) < 0x100 {
            // get_block_offset(cell_from = cell_id, cell_to = check_pos.objcell_id).
            let offset = LandDefs::get_block_offset(cell_id, self.check_pos.objcell_id);
            self.cache_global_sphere(Some(&offset));
            self.check_pos.frame.origin.x += offset.x;
            self.check_pos.frame.origin.y += offset.y;
            self.check_pos.frame.origin.z += offset.z;
        }
        self.check_pos.objcell_id = cell_id;
    }

    /// `SPHEREPATH::set_check_pos` (`acclient.c:312091`). Re-seats the candidate
    /// position/cell, invalidates the cell ring, and rebuilds the global sphere
    /// cache from scratch (`offset == 0` ⇒ recompute through `check_pos.frame`).
    /// (A06 — driver `validate_transition`; A01 — `check_walkable` rewind.)
    ///
    /// Decomp:
    /// ```text
    /// this->check_pos.objcell_id = p->objcell_id;
    /// this->check_pos.frame      = p->frame;        // Frame::operator=
    /// this->check_cell           = cell;
    /// this->cell_array_valid     = 0;
    /// SPHEREPATH::cache_global_sphere(this, 0);
    /// ```
    /// `CObjCell *cell` → `Option<u32>` (cell id) per the seam convention.
    // acclient.c:312091
    pub fn set_check_pos(&mut self, p: &Position, cell: Option<u32>) {
        self.check_pos.objcell_id = p.objcell_id;
        self.check_pos.frame = p.frame; // Frame is Copy → `operator=`
        self.check_cell = cell;
        self.cell_array_valid = false;
        self.cache_global_sphere(None); // offset == 0 → recompute through frame
    }

    /// `SPHEREPATH::cache_global_curr_center` (`acclient.c:313697`). Caches the
    /// moving sphere's start center in global space by mapping `local_sphere[0]`
    /// through `curr_pos.frame`. (A06.)
    ///
    /// Decomp (per-sphere loop, guarded by `if (num_sphere)`):
    /// ```text
    /// global_curr_center[i] = curr_pos.frame.localtoglobal(local_sphere[i].center);
    /// ```
    /// TYPES-COLLAPSE: `global_curr_center` is modeled as a single `Vector3`
    /// (sphere 0 — the only index the resolver reads, matching
    /// `cache_global_sphere`/`localspace_curr_center`); a 0-sphere path leaves it
    /// untouched. If a `num_sphere == 2` caller ever needs sphere 1's cached
    /// start center, promote the field to `[Vector3; 2]` and fill both.
    // acclient.c:313697
    pub fn cache_global_curr_center(&mut self) {
        if self.num_sphere == 0 {
            return; // decomp: `if (this->num_sphere)`
        }
        let frame = self.curr_pos.frame;
        self.global_curr_center = frame.localtoglobal(self.local_sphere[0].center);
    }

    /// `SPHEREPATH::get_walkable_pos` (`acclient.c:312104`). Returns a copy of
    /// the recorded resting `walkable_pos` (cell id + frame). Trivial accessor
    /// used by `CTransition::edge_slide`'s step-down-and-retest branch.
    // acclient.c:312104
    pub fn get_walkable_pos(&self) -> Position {
        Position {
            objcell_id: self.walkable_pos.objcell_id,
            frame: self.walkable_pos.frame,
        }
    }

    /// `SPHEREPATH::set_walkable_check_pos` (`acclient.c:311551`):
    /// `walkable_check_pos = *sphere`.
    // acclient.c:311551
    pub fn set_walkable_check_pos(&mut self, sphere: &Sphere) {
        self.walkable_check_pos = *sphere;
    }

    /// `SPHEREPATH::cache_localspace_sphere` (`acclient.c:313852`). Re-bases the
    /// swept sphere(s) into a target cell's local space `p` (the BSP cell's
    /// `pos`), scaled by `1/scale`, and refreshes `localspace_pos` / `localspace_z`
    /// / `localspace_low_point`. The decomp's `Position::localtolocal(p, from,
    /// point)` (acclient.c:143795) is `p.frame.globaltolocal(from.frame.
    /// localtoglobal(point) + get_block_offset(p.id, from.id))`; `from` is
    /// `check_pos` for the candidate centers and `curr_pos` for the swept-from
    /// center. `localspace_curr_center` is the single-`Vector3` model (sphere 0).
    ///
    /// All-frame math (no real cell geometry), so this completes
    /// `edge_slide`'s deepest branch; the localspace cache it writes is the
    /// resolver's `find_collisions` input.
    // acclient.c:313852
    pub fn cache_localspace_sphere(&mut self, p: &Position, scale: f32) {
        let inv = 1.0 / scale; // scalea = 1.0 / scale
        let n = self.num_sphere as usize;
        for i in 0..n {
            self.localspace_sphere[i].radius = inv * self.local_sphere[i].radius;
            // localtolocal(p, check_pos, local_sphere[i].center)
            let local = self.local_sphere[i].center;
            let global = self.check_pos.frame.localtoglobal(local)
                + LandDefs::get_block_offset(p.objcell_id, self.check_pos.objcell_id);
            self.localspace_sphere[i].center = p.frame.globaltolocal(global) * inv;
            // localtolocal(p, curr_pos, local_sphere[i].center) → localspace_curr_center
            if i == 0 {
                let global_curr = self.curr_pos.frame.localtoglobal(local)
                    + LandDefs::get_block_offset(p.objcell_id, self.curr_pos.objcell_id);
                self.localspace_curr_center = p.frame.globaltolocal(global_curr) * inv;
            }
        }
        // localspace_pos = *p (objcell_id + frame).
        self.localspace_pos.objcell_id = p.objcell_id;
        self.localspace_pos.frame = p.frame;
        // localspace_z = global image of local +Z = fl2gv column 2.
        self.localspace_z = Vector3::new(p.frame.fl2gv[2], p.frame.fl2gv[5], p.frame.fl2gv[8]);
        // localspace_low_point = center − radius·localspace_z (of sphere 0).
        let s0 = self.localspace_sphere[0];
        self.localspace_low_point = s0.center - self.localspace_z * s0.radius;
    }

    /// `SPHEREPATH::check_walkables` (`acclient.c:313468`). THE recursion-
    /// termination gate for the `transitional_insert ↔ check_walkable` cycle
    /// (A15 R1/D1): returns truthy (`1`) when there is no cached walkable poly,
    /// OR when the resting sphere still sits walkably on the cached `walkable`
    /// polygon — i.e. the object has converged onto a floor so the recursion may
    /// stop. Returns `0` when it has walked off the walkable face (recurse on).
    ///
    /// Decomp:
    /// ```text
    /// v2 = this->walkable;                              // CPolygon*
    /// if (v2) {
    ///     walkable_check_pos.radius *= 0.5;             // HALVE (persisted)
    ///     result = (int)CPolygon::check_walkable(v2, &walkable_check_pos, &walkable_up);
    /// } else result = 1;
    /// ```
    /// `CPolygon::check_walkable` (acclient.c:360227) is byte-identical to
    /// `CPolygon::check_small_walkable` (360312, [`check_small_walkable`]) EXCEPT
    /// it uses the full `radius²` acceptance band instead of `radius²·0.25`.
    /// Halving the radius first makes its band `(0.5·r)² = 0.25·r²` — exactly the
    /// one `check_small_walkable` derives from the ORIGINAL radius (both 0.5 and
    /// 0.25 are exact powers of two ⇒ the f32 product is bit-identical, and the
    /// projected contact point is radius-independent). So we evaluate
    /// `check_small_walkable` on the pre-halved sphere and then persist the
    /// decomp's radius-halving side-effect on `walkable_check_pos`.
    // acclient.c:313468
    pub fn check_walkables(&mut self) -> i32 {
        match self.walkable.clone() {
            Some(poly) => {
                // CPolygon::check_walkable(walkable, &walkable_check_pos{r0}, up)
                // ≡ check_small_walkable on the original radius (see doc above).
                let hit = check_small_walkable(&poly, &self.walkable_check_pos, self.walkable_up);
                self.walkable_check_pos.radius *= 0.5; // persist (acclient.c:313481-313485)
                i32::from(hit)
            }
            None => 1,
        }
    }

    /// `SPHEREPATH::precipice_slide` (`acclient.c:313980`). When the resting
    /// sphere has walked OFF the edge of its `walkable` polygon (a precipice),
    /// find the crossed edge, clear the walkable latch, and slide the global
    /// sphere back along that edge's (re-oriented) normal. Returns the slide
    /// code (`4` SLID, `3` CONTACT, `2` COLLIDED); `2` when no edge is found
    /// (nowhere to slide).
    ///
    /// Decomp:
    /// ```text
    /// if (CPolygon::find_crossed_edge(walkable, &walkable_check_pos, &walkable_up, &normal)) {
    ///     walkable = 0; step_up = 0;
    ///     normal = walkable_pos.frame.localtoglobalvec(normal);          // rotate to global
    ///     get_block_offset(&result, curr_pos.objcell_id, check_pos.objcell_id);
    ///     disp = result + (global_sphere[0].center − global_curr_center);
    ///     if (normal · disp > 0) normal = -normal;                       // face downhill
    ///     return CSphere::slide_sphere(global_sphere, this, collisions, &normal, global_curr_center);
    /// } else { walkable = 0; return 2; }
    /// ```
    /// The decompiler's per-component rotation aliases a stack slot (the third
    /// component reads the already-rotated `normal.y` rather than the original);
    /// the intended op is the orthonormal `Frame::localtoglobalvec`, used here.
    /// The `CSphere::slide_sphere` tail is replayed inline against the leaf
    /// [`slide_sphere`] exactly as [`SpherePath::step_up_slide`] does.
    // acclient.c:313980
    pub fn precipice_slide(&mut self, collisions: &mut CollisionInfo) -> i32 {
        // CPolygon::find_crossed_edge(walkable, &walkable_check_pos, &walkable_up, &normal)
        let crossed = self
            .walkable
            .clone()
            .and_then(|poly| find_crossed_edge(&poly, &self.walkable_check_pos, self.walkable_up));

        let edge_normal = match crossed {
            Some(nrm) => nrm,
            None => {
                self.walkable = None; // walkable = 0
                return 2;
            }
        };

        self.walkable = None; // walkable = 0
        self.step_up = false; // step_up = 0
        let curr_center = self.global_curr_center; // v5
        let center = self.global_sphere[0].center; // CSphere `this` = global_sphere[0]

        // Rotate the crossed-edge normal from walkable_pos local space into
        // global space (decomp `localtoglobalvec` via `walkable_pos.frame`).
        let mut normal = self.walkable_pos.frame.localtoglobalvec(edge_normal);

        // block_offset = get_block_offset(curr_pos, check_pos). acclient.c:314020
        let block_offset =
            LandDefs::get_block_offset(self.curr_pos.objcell_id, self.check_pos.objcell_id);

        // disp = block_offset + (center − global_curr_center); face downhill.
        let disp = Vector3::new(
            block_offset.x + (center.x - curr_center.x),
            block_offset.y + (center.y - curr_center.y),
            block_offset.z + (center.z - curr_center.z),
        );
        if normal.dot(&disp) > 0.0 {
            normal = Vector3::new(-normal.x, -normal.y, -normal.z);
        }

        // CSphere::slide_sphere(global_sphere, this, collisions, &normal, curr_center)
        // — inline driver replay against the pure leaf (see step_up_slide).
        let contact_normal = self.resolve_slide_plane_normal(collisions);
        match slide_sphere(center, normal, curr_center, contact_normal, block_offset) {
            SlideSphere::Adjusted { offset } => {
                self.add_offset_to_check_pos(&offset);
                3
            }
            SlideSphere::Slid { offset } => {
                collisions.set_collision_normal(normal);
                self.add_offset_to_check_pos(&offset);
                4
            }
            SlideSphere::Collided { recomputed_normal } => {
                collisions.set_collision_normal(normal);
                if let Some(recomputed) = recomputed_normal {
                    collisions.set_collision_normal(recomputed);
                }
                2
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use holtburger_common::Plane;

    fn v(x: f32, y: f32, z: f32) -> Vector3 {
        Vector3::new(x, y, z)
    }

    const TOL: f32 = 1e-4;

    fn approx(a: Vector3, b: Vector3) -> bool {
        (a.x - b.x).abs() < TOL && (a.y - b.y).abs() < TOL && (a.z - b.z).abs() < TOL
    }

    fn sample_poly() -> ResolvedPolygon {
        ResolvedPolygon {
            num_points: 3,
            vertices: vec![v(0.0, 0.0, 0.0), v(1.0, 0.0, 0.0), v(0.0, 1.0, 0.0)],
            plane: Plane {
                normal: v(0.0, 0.0, 1.0),
                d: 0.0,
            },
        }
    }

    // ── SPHEREPATH::cache_global_sphere (acclient.c:313748) ─────────────────

    #[test]
    fn cache_global_sphere_recompute_then_slide_identity_frame() {
        // Identity rotation, origin translated to (10,0,0): localtoglobal is a
        // pure shift by the origin.
        let mut sp = SpherePath::default();
        sp.num_sphere = 1;
        sp.local_sphere[0] = Sphere {
            center: v(1.0, 2.0, 3.0),
            radius: 0.5,
        };
        sp.local_low_point = v(1.0, 2.0, 0.0);
        sp.check_pos.frame.origin = v(10.0, 0.0, 0.0); // identity basis by default

        // None → recompute: center/low-point shift by origin, radius copied.
        sp.cache_global_sphere(None);
        assert!(approx(sp.global_sphere[0].center, v(11.0, 2.0, 3.0)));
        assert!((sp.global_sphere[0].radius - 0.5).abs() < TOL);
        assert!(approx(sp.global_low_point, v(11.0, 2.0, 0.0)));

        // Some(offset) → slide centers + low-point; radius untouched.
        // low_point (11,2,0) + offset (1,-2,3) = (12,0,3); center (11,2,3) → (12,0,6).
        sp.cache_global_sphere(Some(&v(1.0, -2.0, 3.0)));
        assert!(approx(sp.global_sphere[0].center, v(12.0, 0.0, 6.0)));
        assert!((sp.global_sphere[0].radius - 0.5).abs() < TOL);
        assert!(approx(sp.global_low_point, v(12.0, 0.0, 3.0)));
    }

    #[test]
    fn cache_global_sphere_recompute_rotated_frame() {
        // +90°-about-Z basis (col0=+Y, col1=-X, col2=+Z) stored column-major,
        // origin (10,0,0). localtoglobal((1,2,3)) = (-2,1,3)+(10,0,0)=(8,1,3).
        let mut sp = SpherePath::default();
        sp.num_sphere = 1;
        sp.local_sphere[0] = Sphere {
            center: v(1.0, 2.0, 3.0),
            radius: 0.7,
        };
        sp.local_low_point = v(1.0, 2.0, 3.0);
        sp.check_pos.frame.fl2gv = [0.0, 1.0, 0.0, -1.0, 0.0, 0.0, 0.0, 0.0, 1.0];
        sp.check_pos.frame.origin = v(10.0, 0.0, 0.0);

        sp.cache_global_sphere(None);
        assert!(approx(sp.global_sphere[0].center, v(8.0, 1.0, 3.0)));
        assert!((sp.global_sphere[0].radius - 0.7).abs() < TOL);
        assert!(approx(sp.global_low_point, v(8.0, 1.0, 3.0)));
    }

    // ── SPHEREPATH::add_offset_to_check_pos (acclient.c:311557) ─────────────

    #[test]
    fn add_offset_translates_origin_invalidates_and_slides_cache() {
        let mut sp = SpherePath::default();
        sp.num_sphere = 1;
        sp.check_pos.frame.origin = v(1.0, 2.0, 3.0);
        sp.global_sphere[0].center = v(1.0, 2.0, 3.0);
        sp.global_low_point = v(1.0, 2.0, 3.0);
        sp.cell_array_valid = true;

        sp.add_offset_to_check_pos(&v(0.5, -1.0, 2.0));

        // check_pos origin translated; cell ring invalidated.
        assert!(approx(sp.check_pos.frame.origin, v(1.5, 1.0, 5.0)));
        assert!(!sp.cell_array_valid);
        // cache slid by the SAME offset (not recomputed).
        assert!(approx(sp.global_sphere[0].center, v(1.5, 1.0, 5.0)));
        assert!(approx(sp.global_low_point, v(1.5, 1.0, 5.0)));
    }

    // ── SPHEREPATH::add_offset_to_check_pos radius overload (acclient.c:358526)

    #[test]
    fn add_offset_with_radius_is_identical_radius_ignored() {
        // The retail radius overload shares the no-radius body verbatim; the
        // radius is never read. Two distinct radii must give the same result.
        let mut a = SpherePath::default();
        a.num_sphere = 1;
        a.check_pos.frame.origin = v(-2.5, 3.25, 0.75);
        let mut b = a.clone();

        a.add_offset_to_check_pos_with_radius(&v(2.5, -3.25, -0.75), 1.7);
        b.add_offset_to_check_pos_with_radius(&v(2.5, -3.25, -0.75), 99.0);

        assert!(approx(a.check_pos.frame.origin, Vector3::zero()));
        assert_eq!(a.check_pos.frame.origin, b.check_pos.frame.origin);

        // …and identical to the no-radius entry point.
        let mut c = SpherePath::default();
        c.num_sphere = 1;
        c.check_pos.frame.origin = v(-2.5, 3.25, 0.75);
        c.add_offset_to_check_pos(&v(2.5, -3.25, -0.75));
        assert_eq!(a.check_pos.frame.origin, c.check_pos.frame.origin);
    }

    // ── SPHEREPATH::set_collide (acclient.c:359050) ─────────────────────────

    #[test]
    fn set_collide_snapshots_backup_and_latches() {
        let mut sp = SpherePath::default();
        sp.check_cell = Some(7);
        sp.check_pos.objcell_id = 0xAB;
        sp.check_pos.frame.origin = v(1.0, 2.0, 3.0);
        sp.walk_interp = 0.25;
        assert!(!sp.collide);

        sp.set_collide(&v(1.0, 0.0, 0.0));

        assert!(sp.collide);
        assert_eq!(sp.backup_cell, Some(7));
        assert_eq!(sp.backup_check_pos.objcell_id, 0xAB);
        assert!(approx(sp.backup_check_pos.frame.origin, v(1.0, 2.0, 3.0)));
        assert!(approx(sp.step_up_normal, v(1.0, 0.0, 0.0)));
        assert!((sp.walk_interp - 1.0).abs() < TOL);
    }

    // ── SPHEREPATH::set_neg_poly_hit (acclient.c:360743) ────────────────────

    #[test]
    fn set_neg_poly_hit_negates_normal_and_records_which_sphere() {
        let mut sp = SpherePath::default();

        // First-sphere graze (step_up = 1): normal negated.
        sp.set_neg_poly_hit(1, &v(0.6, 0.0, 0.8));
        assert_eq!(sp.neg_step_up, 1);
        assert!(sp.neg_poly_hit);
        assert!(approx(sp.neg_collision_normal, v(-0.6, 0.0, -0.8)));

        // Second-sphere graze (step_up = 0): overwrites; still negated.
        sp.set_neg_poly_hit(0, &v(0.0, 1.0, 0.0));
        assert_eq!(sp.neg_step_up, 0);
        assert!(approx(sp.neg_collision_normal, v(0.0, -1.0, 0.0)));
    }

    // ── SPHEREPATH::set_walkable (acclient.c:361094) ────────────────────────

    #[test]
    fn set_walkable_records_every_field() {
        let mut sp = SpherePath::default();
        let poly = sample_poly();
        let mut local_pos = Position::default();
        local_pos.objcell_id = 0x100;
        local_pos.frame.origin = v(7.0, 8.0, 9.0);

        sp.set_walkable(
            &Sphere {
                center: v(7.0, 8.0, 9.0),
                radius: 1.1,
            },
            &poly,
            &v(0.0, 0.0, 1.0),
            &local_pos,
            2.0,
        );

        assert!(approx(sp.walkable_check_pos.center, v(7.0, 8.0, 9.0)));
        assert!((sp.walkable_check_pos.radius - 1.1).abs() < TOL);
        let recorded = sp.walkable.as_ref().expect("walkable poly recorded");
        assert_eq!(recorded.num_points, 3);
        assert!(approx(recorded.plane.normal, v(0.0, 0.0, 1.0)));
        assert!(approx(sp.walkable_up, v(0.0, 0.0, 1.0)));
        assert_eq!(sp.walkable_pos.objcell_id, 0x100);
        assert!(approx(sp.walkable_pos.frame.origin, v(7.0, 8.0, 9.0)));
        assert!((sp.walkable_scale - 2.0).abs() < TOL);
    }

    // ── SPHEREPATH::step_up_slide (acclient.c:313456) ───────────────────────

    #[test]
    fn step_up_slide_slides_along_contact_edge() {
        // center=(0,0,0), normal=+X (a wall), N=+Z (floor) via last_known.
        // gDelta = center - curr = (0,0,0)-(-2,-3,0) = (2,3,0).
        // dir = normal × N = (0,-1,0); along = -3; P = (0,3,0);
        // offset = P - gDelta = (-2,0,0) → SLID (4).
        let mut sp = SpherePath::default();
        sp.num_sphere = 1;
        sp.global_sphere[0] = Sphere {
            center: v(0.0, 0.0, 0.0),
            radius: 1.0,
        };
        sp.global_curr_center = v(-2.0, -3.0, 0.0);
        sp.step_up_normal = v(1.0, 0.0, 0.0);
        sp.step_up = true; // must be cleared
        let obj = ObjectInfo::default();
        let mut ci = CollisionInfo::default();
        ci.last_known_contact_plane = Some(Plane {
            normal: v(0.0, 0.0, 1.0),
            d: 0.0,
        });

        let r = sp.step_up_slide(&obj, &mut ci);

        assert_eq!(r, 4);
        assert!(ci.contact_plane.is_none()); // invalidated by the prelude
        assert!(!ci.contact_plane_is_water);
        assert!(!sp.step_up);
        // Slid replays set_collision_normal(step_up_normal) — already unit.
        assert!(approx(ci.collision_normal.expect("normal set"), v(1.0, 0.0, 0.0)));
        // offset (-2,0,0) applied to both check_pos and the global cache.
        assert!(approx(sp.check_pos.frame.origin, v(-2.0, 0.0, 0.0)));
        assert!(approx(sp.global_sphere[0].center, v(-2.0, 0.0, 0.0)));
    }

    #[test]
    fn step_up_slide_zero_normal_splits_the_gap() {
        // Zero step-up normal → case 1 (CONTACT): offset = (curr-center)*0.5,
        // return 3, and NO set_collision_normal is replayed.
        let mut sp = SpherePath::default();
        sp.num_sphere = 1;
        sp.global_sphere[0] = Sphere {
            center: v(0.0, 0.0, 0.0),
            radius: 1.0,
        };
        sp.global_curr_center = v(4.0, 0.0, 0.0);
        sp.step_up_normal = v(0.0, 0.0, 0.0);
        sp.step_up = true;
        let obj = ObjectInfo::default();
        let mut ci = CollisionInfo::default();
        ci.last_known_contact_plane = Some(Plane {
            normal: v(0.0, 0.0, 1.0),
            d: 0.0,
        });

        let r = sp.step_up_slide(&obj, &mut ci);

        assert_eq!(r, 3);
        // offset = (curr - center)*0.5 = (2,0,0).
        assert!(approx(sp.check_pos.frame.origin, v(2.0, 0.0, 0.0)));
        assert!(approx(sp.global_sphere[0].center, v(2.0, 0.0, 0.0)));
        // CONTACT case does not record a collision normal.
        assert!(ci.collision_normal.is_none());
        assert!(ci.contact_plane.is_none());
        assert!(!sp.step_up);
    }

    // ── SPHEREPATH::save_check_pos / restore_check_pos (312083 / 312528) ─────

    #[test]
    fn save_then_restore_check_pos_round_trips() {
        let mut sp = SpherePath::default();
        sp.num_sphere = 1;
        sp.check_cell = Some(42);
        sp.check_pos.objcell_id = 0x100;
        sp.check_pos.frame.origin = v(1.0, 2.0, 3.0);

        sp.save_check_pos();
        assert_eq!(sp.backup_cell, Some(42));
        assert_eq!(sp.backup_check_pos.objcell_id, 0x100);
        assert!(approx(sp.backup_check_pos.frame.origin, v(1.0, 2.0, 3.0)));

        // Move elsewhere, then restore to the snapshot.
        sp.check_cell = Some(99);
        sp.check_pos.objcell_id = 0x200;
        sp.check_pos.frame.origin = v(9.0, 9.0, 9.0);
        sp.cell_array_valid = true;

        sp.restore_check_pos();
        assert_eq!(sp.check_cell, Some(42));
        assert_eq!(sp.check_pos.objcell_id, 0x100);
        assert!(approx(sp.check_pos.frame.origin, v(1.0, 2.0, 3.0)));
        assert!(!sp.cell_array_valid);
        // cache recomputed (None): local_sphere[0] center 0 → global = origin.
        assert!(approx(sp.global_sphere[0].center, v(1.0, 2.0, 3.0)));
    }

    // ── SPHEREPATH::adjust_check_pos (acclient.c:313962) ────────────────────

    #[test]
    fn adjust_check_pos_outdoor_rebases_origin_and_cache() {
        let mut sp = SpherePath::default();
        sp.num_sphere = 1;
        sp.check_pos.objcell_id = 0x0102_0001;
        sp.check_pos.frame.origin = v(10.0, 20.0, 0.0);
        sp.global_sphere[0].center = v(10.0, 20.0, 0.0);
        sp.global_low_point = v(10.0, 20.0, 0.0);

        // outdoor target in landblock (3,2): offset = get_block_offset(
        //   from = 0x0302_0001, to = 0x0102_0001) = ((1-3)*192,0,0) = (-384,0,0).
        sp.adjust_check_pos(0x0302_0001);

        assert_eq!(sp.check_pos.objcell_id, 0x0302_0001);
        assert!(approx(sp.check_pos.frame.origin, v(-374.0, 20.0, 0.0)));
        assert!(approx(sp.global_sphere[0].center, v(-374.0, 20.0, 0.0)));
        assert!(approx(sp.global_low_point, v(-374.0, 20.0, 0.0)));
    }

    #[test]
    fn adjust_check_pos_interior_only_retags_id() {
        let mut sp = SpherePath::default();
        sp.num_sphere = 1;
        sp.check_pos.objcell_id = 0x0102_0001;
        sp.check_pos.frame.origin = v(5.0, 5.0, 5.0);
        sp.global_sphere[0].center = v(5.0, 5.0, 5.0);

        // interior target (low u16 == 0x100 >= 0x100): no block-offset rebase.
        sp.adjust_check_pos(0x0001_0100);

        assert_eq!(sp.check_pos.objcell_id, 0x0001_0100);
        assert!(approx(sp.check_pos.frame.origin, v(5.0, 5.0, 5.0)));
        assert!(approx(sp.global_sphere[0].center, v(5.0, 5.0, 5.0)));
    }

    // ── SPHEREPATH::check_walkables (acclient.c:313468) ─────────────────────

    #[test]
    fn check_walkables_no_poly_returns_one() {
        let mut sp = SpherePath::default();
        assert!(sp.walkable.is_none());
        assert_eq!(sp.check_walkables(), 1);
    }

    #[test]
    fn check_walkables_resting_on_poly_returns_one_and_halves_radius() {
        let mut sp = SpherePath::default();
        sp.walkable = Some(sample_poly()); // triangle in z=0, normal +Z
        sp.walkable_check_pos = Sphere { center: v(0.2, 0.2, 1.0), radius: 1.0 };
        sp.walkable_up = v(0.0, 0.0, 1.0);
        assert_eq!(sp.check_walkables(), 1);
        // decomp halves walkable_check_pos.radius (persisted side-effect).
        assert!((sp.walkable_check_pos.radius - 0.5).abs() < TOL);
    }

    #[test]
    fn check_walkables_off_face_returns_zero() {
        let mut sp = SpherePath::default();
        sp.walkable = Some(sample_poly());
        sp.walkable_check_pos = Sphere { center: v(5.0, 5.0, 1.0), radius: 0.1 };
        sp.walkable_up = v(0.0, 0.0, 1.0);
        assert_eq!(sp.check_walkables(), 0);
    }

    // ── SPHEREPATH::precipice_slide (acclient.c:313980) ─────────────────────

    #[test]
    fn precipice_slide_no_walkable_returns_collided() {
        let mut sp = SpherePath::default();
        sp.num_sphere = 1;
        let mut ci = CollisionInfo::default();
        assert_eq!(sp.precipice_slide(&mut ci), 2);
        assert!(sp.walkable.is_none());
    }

    #[test]
    fn precipice_slide_inside_face_finds_no_edge_returns_collided() {
        let mut sp = SpherePath::default();
        sp.num_sphere = 1;
        sp.walkable = Some(sample_poly());
        sp.walkable_check_pos = Sphere { center: v(0.2, 0.2, 0.0), radius: 0.1 };
        sp.walkable_up = v(0.0, 0.0, 1.0);
        let mut ci = CollisionInfo::default();
        assert_eq!(sp.precipice_slide(&mut ci), 2);
        assert!(sp.walkable.is_none()); // latch cleared either way
    }

    #[test]
    fn precipice_slide_off_edge_slides_and_clears_walkable() {
        let mut sp = SpherePath::default();
        sp.num_sphere = 1;
        sp.walkable = Some(sample_poly());
        // projected center well below the y=0 edge → off the face.
        sp.walkable_check_pos = Sphere { center: v(0.3, -0.5, 0.0), radius: 0.1 };
        sp.walkable_up = v(0.0, 0.0, 1.0);
        sp.global_sphere[0].center = v(0.3, -0.5, 0.0);
        let mut ci = CollisionInfo::default();
        let r = sp.precipice_slide(&mut ci);
        assert!(r == 2 || r == 3 || r == 4, "got {r}");
        assert!(sp.walkable.is_none());
    }
}
