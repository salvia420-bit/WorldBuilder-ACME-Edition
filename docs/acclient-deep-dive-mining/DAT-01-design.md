# DAT-01 — a collision representation for procedural scenery

Tier 1 / P1.1 of `WORK-PLAN.md`. Live symptoms: **COL-01** (walk through
trees, sev 1), **COL-29** (rocks in paths don't block, sev 2). COL-17
(climb cliffs) is listed alongside these in the plan but is a *terrain*
slope problem (PHY-06/PHY-21) and is **not** addressed here — see
§7 Premise corrections.

Phase 1 (decomp grounding, survey, this design, and the bake-side
emission) landed 2026-07-27. Phases 2+ are scoped at the bottom.

---

## 1. What retail actually does

Anchors are in `/home/wbterminal/ac-headers/acclient.c` unless noted.
Every one below was opened and read, not inferred.

### 1.1 Instantiation — every accepted scenery item is a real `CPhysicsObj`

`CLandBlock::get_land_scenes` (`acclient.c:352530`) walks all 81 terrain
vertices, resolves `(terrain_type, scene_type)` → `Scene` (`0x12`) via
`CRegionDesc::GetScene`, and for each `ObjectDesc` in the scene that
survives the filter chain does exactly this (`acclient.c:352708-352718`
— **citation confirmed correct**):

```c
v21 = CPhysicsObj::makeObject(obj_id, 0, 0);      // 352708
CPhysicsObj::set_initial_frame(v21, &obj_frame);
if ( CPhysicsObj::obj_within_block(v22) ) {
    CPhysicsObj::add_obj_to_cell(v22, &cell->vfptr, &obj_frame);
    v23 = ObjectDesc::ScaleObj((ObjectDesc *)v18, v9, v10, kq);
    CPhysicsObj::SetScaleStatic(v22, v23);
    CLandBlock::add_static_object(v28, v22);      // 352717
}
```

`makeObject(did, iid=0, bDynamic=0)` (`acclient.c:320829`) is
`new CPhysicsObj` → `InitObjectBegin` → `InitPartArrayObject(did, 1)` →
`InitObjectEnd`. `InitObjectBegin` with `bDynamic=0` sets
`state |= 1` = `STATIC_PS` (`acclient.c:317273`; enum
`acclient.txt` typeid `0x4c09`).

`CLandBlock::add_static_object` (`acclient.c:351857`) appends to the
**same** `DArray<CPhysicsObj*> static_objects` that hand-placed
`LandblockInfo` statics go into. Scenery and buildings-adjacent statics
are one list, differing only by index: `CLandBlock::adjust_scene_obj_height`
(`acclient.c:352194`) re-heights only entries at index `>= lbi->num_objects`,
i.e. the scenery tail.

### 1.2 The filter chain (what retail refuses to instantiate)

In `get_land_scenes` order:

| Filter | Site | Note |
|---|---|---|
| `noise < ObjectDesc.freq` | `*(float *)(v18 + 68)` | the frequency roll |
| **`ObjectDesc.weenie_obj == 0`** | `!*(_DWORD *)(v18 + 108)` | **client never instantiates weenie-managed scenery** — the server spawns those as real objects |
| in-LB bounds | `obj_vector.x/y ∈ [0, flt_844AEC)` | |
| `!CLandBlock::on_road` | `acclient.c:352238` | |
| `!CSortCell::has_building(cell)` | | scenery is suppressed inside building footprints |
| `CLandCell::find_terrain_poly` succeeds | | |
| **`ObjectDesc::CheckSlope(desc, walkable->plane.N.z)`** | `acclient.c:351355` | `min_slope`/`max_slope` are **cosines** |
| `CPhysicsObj::obj_within_block` | | post-frame check |

`ObjectDesc` is 112 bytes (`acclient.h:57271`), field offsets confirmed
against the `v35 += 112` / `v18 + 68` / `+100` / `+108` accesses.

Global kill switch: `use_scene_files` (`acclient.c:45295`, default 1),
tested at `acclient.c:352887` inside `CLandBlock::init_static_objs`.

### 1.3 Residency — per-landblock, refcounted, and the same list as statics

- **Create**: `CLandBlock::init_static_objs` (`acclient.c:352787`) →
  `get_land_scenes` at `:352888`. Called once per landblock slot from
  `LScape`'s ring init (`acclient.c:306629`).
- **Re-entry**: if `num_static_objects` is already non-zero the function
  takes the *other* branch — `adjust_scene_obj_height` +
  `calc_cross_cells_static` per object. It does **not** rebuild.
- **Destroy**: `CLandBlock::destroy_static_objects` (`acclient.c:351931`)
  does `leave_world` + `__vecDelDtor` per object. Reached from
  `CLandBlock::Destroy` (`acclient.c:351966`, i.e. the refcounted
  `DBObj` release) and from `CLandBlock::notify_change_size`
  (`acclient.c:352430`).
- The owning grid is `LScape::update_block` (`acclient.c:307786`): a
  fixed `mid_width × mid_width` array of `CLandBlock*` that **shifts**
  as the load point moves, `DBObj::Get`-ing arrivals and
  `CLandBlock::release_all`-ing departures. This is the "refcounted
  DBOCache + fixed slot grid" residency model.

### 1.4 Collision — the broad/narrow split, and the arm that actually fires

Broad phase is the **cell**, not a spatial tree. `add_obj_to_cell` +
`calc_cross_cells_static` register the object in every landcell it
overlaps as a `CShadowObj`. A move resolves through
`CLandCell::find_collisions` (`acclient.c:354887`) → terrain polys →
`CSortCell::find_collisions` → `CObjCell::find_obj_collisions`
(`acclient.c:347142`), which walks `shadow_object_list` and calls
`CPhysicsObj::FindObjCollisions` on each.

`CPhysicsObj::FindObjCollisions` (`acclient.c:316159`) then picks a
narrow phase by a **four-rung ladder** (`acclient.c:316229-316281`):

1. `state & HAS_PHYSICS_BSP_PS (0x10000)` → `CPartArray::FindObjCollisions`
   → per part → `CGfxObj::find_obj_collisions` (`acclient.c:356515`),
   which rejects against `physics_sphere` then descends `physics_bsp`.
2. else `CPartArray::GetNumCylsphere() > 0` →
   `CCylSphere::intersects_sphere(cyl, &m_position, m_scale, transition)`
   — **note `m_scale`**, which for scenery is the per-instance
   `SetScaleStatic` value from §1.1.
3. else `GetNumSphere() > 0` → `CSphere::intersects_sphere`.
4. else → **nothing. The object does not collide at all.**

**Which rung do trees take? Rung 2.** Measured over every scenery model
in the three test landblocks (§5): *not one* of their `GfxObj` parts
carries a `physicsBSP` or any `physicsPolygons`. They collide by
`CSetup` cylsphere — a ~1.1–1.6 m radius cylinder at the trunk — or not
at all.

---

## 2. Our side today

### 2.1 Bake

`crates/holtburger-scenery-bake` is a port of ACE `Scenery.Load`. Per
accepted placement it emits `obj_id, x, y, z, quaternion, scale`, three
`source_*` attribution words, a `default_script_id` (V1) and a
`stable_id` (V2), one JSON object per line, to
`dist/scenery/0xXXXX.scenery.jsonl` (40,197 files live). Sidecars:
`<lb>.scenery.jsonl.sha256` (line 1 sha256, line 2 `placements-hash` =
FNV-1a/64 over the twelve wire fields) and one run-level
`scenery/bake-source.sha256`.

`src/aabb.rs::transform_mesh_to_aabb` already built a world-frame XY box
per **candidate** placement — ACE's `Collision` rejection needs it — and
the box was discarded the instant the decision was made. That is the
machinery this task un-discards.

Format versioning is **append-only fields**, nothing else. There is no
schema key: `manifest.json` (`version: 2`) covers only the DAT-shard
channel and never mentions the scenery layer; `serve.py --check` tests
`scenery/` for presence and non-emptiness only.

### 2.2 Client render path

`fetch_landblock_scenery` / `LandblockScenerySoa`
(`apps/holtburger-web/src/lib.rs:4128`) parse the JSONL into
positions/quaternions/scales for the renderer. **No physics field.**
`ScenicPlacementJsonRaw` (`lib.rs:2658`) has no
`#[serde(deny_unknown_fields)]`, so added wire fields are silently
ignored by shipped clients — which is what makes an append-only bake
change safe to land before any consumer exists.

### 2.3 Client collision path (the thing scenery must join)

Already built, already live, and shaped exactly right:

- `populate_statics_aabbs_for_landblock_impl`
  (`apps/holtburger-web/src/lib.rs:15941`) walks `LandblockInfo.objects`,
  builds a world AABB per part, and stages
  `(landblock_high, StaticAabbEntry { did, aabb, has_bsp })` onto
  `STATIC_AABB_PENDING`; if the part carries a physics BSP it *also*
  stages a `CellPhysicsBsp` onto `STATIC_BSP_PENDING` and sets
  `has_bsp`.
- Both piles drain each `TickMovement`
  (`lib.rs:15410` / `:15426`) into `SpatialScene::statics_aabb_index` /
  `statics_physics_bsp` (`crates/holtburger-world/src/spatial/scene.rs:2655`,
  `:2731`).
- The integrator (`crates/holtburger-core/src/client/movement/system.rs:4783-4886`)
  sweeps the coarse AABBs for `!has_bsp` entries and runs
  `resolve_static_bsp_pushout` for the rest — i.e. **it already
  implements retail's rung-1/rung-2 split**, just with an AABB where
  retail has a cylsphere.
- Unload purges via `enqueueClearLandblockCollision`
  (`lib.rs:15370`) → `LANDBLOCK_CLEAR_PENDING` → batched
  `clear_landblocks_collision` (`lib.rs:49039`), fired from
  `scene3d/index.js:4744` on LRU eviction.
- Load hook: `index.html:3869-3891`, right beside the existing
  `populateStaticsAabbsForLandblock` call at `:3883`.
- `CellPhysicsBsp` already carries a `scale: f32` whose doc comment
  literally reads *"the bake populates it from the static/scenery
  placement scale when non-unit (outdoor scenery)"*.

The gap is not architecture. It is that **nothing feeds scenery into
these piles**, and that the piece scenery actually needs — a cylsphere
narrow phase — does not exist.

---

## 3. Representation — decision

> **Broad phase = the baked AABB. Narrow phase = the `CSetup` cylsphere,
> scaled per instance. No third option, and no AABB-only fallback.**

### 3.1 Why not AABB-only

The bake's AABB bounds the **render mesh**, which for a tree is the
foliage canopy. Measured on the three test LBs:

| Setup | AABB half-extent | `CSetup` cylsphere radius | ratio |
|---|---|---|---|
| `0x02000258` (large pine) | 13.52 m | 1.09 m | **12.4×** |
| `0x020002D3` (pine) | 6.82 m | 1.53 m | 4.5× |
| `0x020002DB` (44 m pine) | 6.94 m | 1.53 m | 4.5× |
| `0x02000246` (bush) | 3.82 m | 0.85 m | 4.5× |

Shipping the AABB as the collider makes a single pine an impassable
27 m-wide wall. Forests would become solid. This is not a tuning
problem — it is the wrong shape.

### 3.2 Why not BSP

There is no BSP to use. All six `GfxObj` parts behind the three most
common scenery setups report `physicsBSP: None, physicsPolygons: 0`
(measured via `chorizite-parse-dat-record`, §5). Retail's rung 1 never
fires for these models. Reusing `insert_static_physics_bsp` for scenery
would register nothing.

### 3.3 Why not "every instance is a CPhysicsObj", literally

Retail does that, but retail also has ~1 landblock of scenery resident
per slot in a small fixed grid and a C++ heap. Ours is a wasm client
holding a 13×13 ring. The retail *semantics* port cleanly; the retail
*object model* does not. Per-LB batch arrays give identical behaviour at
a fraction of the allocation churn — and that is exactly the shape
`statics_aabb_index` already uses.

### 3.4 The non-collidable class is large and must be honoured

8 of the 16 distinct scenery setups in the sample have **no cylsphere,
no sphere, `height = 0`, `radius = 0`** — grass, flowers, mushrooms,
ground clutter. By placement count that is **33 of 79 (42%)**. Retail's
rung 4 gives them no collision at all. A feed that skips this filter
would make grass block the player, which is worse than the bug we are
fixing.

The filter is per-`CSetup`, not per-instance, so it costs one lookup per
distinct model per landblock.

---

## 4. Residency

Mirror the existing statics arm exactly; do not invent a second
lifecycle.

| Retail | Ours |
|---|---|
| `CLandBlock::init_static_objs` → `get_land_scenes` | new `populateSceneryCollidersForLandblock(lb)` called from `index.html:3869-3891` beside `populateStaticsAabbsForLandblock` |
| `add_static_object` appends to the LB's array | stage onto a per-LB pending pile; drain in `TickMovement` |
| `CObjCell` shadow lists (per 24 m landcell) | `statics_aabb_index` keyed by landblock-high, queried as a 3×3 ring by `statics_aabbs_near_pose` |
| `CLandBlock::destroy_static_objects` on `Destroy` | `clear_landblocks_collision` — **must be extended with the new family**, or re-entry double-registers (the failure mode already documented at `lib.rs:49033`) |
| re-entry re-heights, does not rebuild | JS dedup set, same as `buildingAabbsPopulatedLbs` (`index.html:3676`) |

Storage shape: **per-LB SoA batch arrays, not per-instance structs.**
Concretely, one `SceneryColliderBatch` per landblock holding parallel
`Vec`s of `(aabb, cyl_origin, cyl_radius, cyl_height, scale)` plus a
`did` column for diagnostics. At Holtburg density (~24 placements/LB
average across the sample, ~71 peak) a 13×13 ring is low thousands of
entries — comfortably an array scan behind the existing 3×3 ring filter.
If a dense forest LB proves otherwise, the next step is a per-landcell
bucket (retail's own broad phase), not a tree.

---

## 5. Wire / bake format

**V3, append-only, additive.** Six floats after `stable_id`:

```
,"aabb_min_x":…,"aabb_min_y":…,"aabb_min_z":…,"aabb_max_x":…,"aabb_max_y":…,"aabb_max_z":…
```

XY in the same LB-local frame as `x`/`y`; Z in the same absolute world
frame as `z`. Emitted by default; `--no-bounds` reproduces the pre-V3
shape byte-for-byte. Recorded in the run sidecar as
`placement-bounds\taabb3d-v3` (or `none`).

Deliberately **not** on the wire:

- **The cylsphere.** It is a property of the `CSetup`, not the
  placement, and the client already resolves Setups for rendering.
  Putting it per-instance would multiply one 5-float record by every
  instance that shares the model. Phase 2 reads it from the Setup and
  memoises per DID.
- **A `has_collision` flag.** Same reason — derivable from the Setup.

Compatibility: pre-V3 readers ignore the keys (no
`deny_unknown_fields`); `placements_fingerprint` is unchanged, so all
40,197 shipped `placements-hash` sidecars stay valid; the per-file
sha256 sidecar is regenerated with the JSONL, as always.

Cost: **+46%** JSONL bytes on a dense LB (21,884 → 31,862 B for 71
placements). If that proves too much at full-Dereth scale, the escape is
a parallel `0xXXXX.scenery.aabb.bin` fixed-stride binary sidecar — same
data, ~24 B/placement instead of ~140 B of JSON text. Not done now
because it would be the layer's first non-JSONL artifact and Phase 2
does not need it.

---

## 6. Landing plan

| Phase | Scope | Size | State |
|---|---|---|---|
| **1** | Decomp grounding; `Aabb3D` + `transform_mesh_to_aabb3`; carry `bounds` on `ScenicPlacement`; V3 JSONL fields + `--no-bounds`; `placement-bounds` sidecar line; parity + wire tests | M | **done 2026-07-27** |
| **2a** | `SceneryColliderBatch` + `insert_scenery_colliders` / `clear_scenery_colliders_for_landblock` in `holtburger-world`, with the per-LB clear wired into `clear_landblocks_collision` | M | **done 2026-07-27** — SoA is one row per PRIMITIVE (retail walks the whole array; 5 DIDs carry 2-3 cylspheres) |
| **2b** | Cylsphere narrow phase: port `CCylSphere::intersects_sphere` (`acclient.c`, rung 2) as a swept capsule-vs-scaled-cylinder test in `holtburger-world::spatial` | M | **done 2026-07-27** in `spatial/scenery.rs` — **plus rung 3 `CSphere`**, which §3.2/§5 never scoped and which is 6.1% of real placements |
| **2c** | wasm `populateSceneryCollidersForLandblock`: read V3 `aabb_*`, resolve each distinct Setup's cylsphere (memoised per DID), **drop setups with no cylsphere and no sphere**, stage the batch | M | **done 2026-07-27** — classifies by the FULL exclusive ladder (`scenery_model_rung`), not by cylsphere-presence; rung 1 classified + **deferred** |
| **2d** | Integrator arm in `movement/system.rs` behind `USE_SCENERY_COLLISION` (default OFF until measured), after the static-BSP push-out | S | **done 2026-07-27 — but NOT where this row says.** "After the static-BSP push-out" is DEAD CODE (`:4783-4886`, unreachable under `USE_UNIFIED_TRANSITION`). Sited after `find_transitional_position_dispatch`; reachability proven by `sceneryArmEvals` |
| **2e** | JS hook at `index.html:3883` + eviction dedup at `:3676`; `__diag.collision` counters (P5.1 surface already exists) | S | **done 2026-07-27** — 4 counters: `sceneryColliderLbs`, `sceneryColliders`, `sceneryNarrowHits`, `sceneryArmEvals` |
| **3** | Full re-bake of `dist/scenery/` with V3 (40,197 LBs), on the buildbox, into a staging dir; swap only after Phase 2 validates | M (mostly wall-clock) | **BAKED + STAGED 2026-07-27** at `/mnt/wbterminal2/buildbox-2026-07-27/rebake/staging/` (195,076 files, additive, zero drift). Phase 2 has now validated against it; the `dist/` swap is what remains |
| **4** | Live validation: lateral-offset approach at a known tree (never head-on — the COL-03 lesson), plus a "can still walk through grass" negative test | S | |

Phase 2 can be developed and unit-tested entirely against the three-LB
scratch bake; the full re-bake (Phase 3) is only needed for live play.

---

## 7. Premise corrections

Recording these because the plan and handoff carry the older reading.

1. **"Retail makes each tree a real `CPhysicsObj` with a physics BSP"** —
   half right. It is a real `CPhysicsObj` (confirmed,
   `acclient.c:352708`), but scenery models carry **no physics BSP**, so
   retail collides them with the `CSetup` **cylsphere** (rung 2 of
   `FindObjCollisions`, `acclient.c:316232-316272`). The existing
   `insert_static_physics_bsp` machinery is therefore *not* the vehicle
   for the scenery arm; a cylsphere narrow phase has to be written.

2. **"`aabb.rs`'s AABBs are a natural starting point"** — true as a
   broad phase, wrong as a collider. The render-mesh AABB overstates the
   trunk by 4.5–12.4×. Shipping it as the collision shape would be a
   visibly worse bug than COL-01.

3. **~42% of scenery placements must never collide.** Ground clutter
   setups report `height = 0`, `radius = 0`, no cylsphere, no sphere.
   Retail gives them no collision. Any feed that omits this filter ships
   solid grass.

4. **COL-17 ("walk/jump up steep cliffs") does not belong to DAT-01.**
   It is terrain-slope handling (PHY-06/PHY-21, Tier 3). Nothing in the
   scenery path touches walkable-slope rejection for the *player*;
   `ObjectDesc::CheckSlope` only decides where scenery is *placed*.

5. **`ObjectDesc.weenie_obj != 0` scenery is server-spawned, not
   client-generated** (`acclient.c` `!*(_DWORD *)(v18 + 108)`). Our bake
   already replicates this (`lib.rs`, `obj.weenie_obj != 0` → skip), so
   there is no gap — but it means the baked list is *not* the full set
   of things standing on the terrain, and the collision feed must not be
   expected to cover weenie-backed scenery. Those arrive as entities and
   take the COL-03 entity arm.

---

## 8. Phase 2 corrections to this document (2026-07-27)

Phase 2 was implemented against a world-scale collidability census
(`/mnt/wbterminal2/buildbox-2026-07-27/census/census-summary.md`, 176 DIDs,
calibrated on 115,415 real baked placements). It refutes two claims above and
adds four constraints §§1-7 do not mention. The *decisions* in §3 all stand;
several of the *numbers* and one *code location* do not.

1. **§3.2 "There is no BSP to use" is false at world scale.** 23 of 176 DIDs
   are rung 1 (0.5% of real placements). Retail's ladder short-circuits, and
   **four models carry a BSP alongside cylspheres/spheres** (`0x020004BF`,
   `0x0200068B`, `0x020003CB`, `0x0200086E`) — so the classifier must test
   BSP FIRST or diverge on all four. Rung 1 is classified and **deferred**;
   see the TODO on `populate_scenery_colliders_for_landblock_impl`.
2. **§3.4 / correction 3: the no-collider share is 59.7%, not 42%** (95% CI
   [58.05, 61.39]). The 3-landblock sample under-represented clutter.
3. **§3.4's predicate is unsafe.** `height == 0 && radius == 0` is satisfied
   by all 49 rung-4 DIDs *and by 19 colliding ones*. Classify by the ladder:
   `has_physics_bsp ? 1 : num_cylsphere ? 2 : num_sphere ? 3 : 4`.
4. **Rung 3 (`CSetup.spheres`) is missing from §5's scope** — 19 DIDs, 6.1%
   of placements. §2c as written ("drop setups with no cylsphere and no
   sphere") would have staged sphere-only setups with no test to run on them.
   `CSphere::intersects_sphere` (`acclient.c:359390`) is now ported too.
5. **§4's row shape assumes one primitive per placement.** Cylsphere counts
   per DID are {1:82, 2:3, 3:2}; sphere counts {1:18, 2:2, 3:1}. The batch
   emits one row per primitive.
6. **Cylsphere origins are not at the model origin** — 23 of 87 have non-zero
   XY, 26 negative Z. They must be **scaled and rotated**, not translated.
   Scale reaches 8.0×.
7. **§6's phase-2d location is dead code.** "After the static-BSP push-out"
   (`system.rs:4783-4886`) is unreachable: the slice returns at `:4221` under
   `USE_UNIFIED_TRANSITION`. The live path is
   `find_transitional_position_dispatch`. An unconditional reachability
   counter (`sceneryArmEvals`) now guards this permanently.
8. **A swept contact point fails retail's own overlap predicate.**
   `radsum` is `r − 2e-4 + sphere_r` but the swept solve uses
   `radsuma = r + sphere_r`, so re-checking `collides_with_sphere` at the
   contact rejects *every* true wall hit. Retail evaluates the predicate at
   the START pose instead. The port applies the Z half only
   (`cylsphere_z_slab_overlap`).
