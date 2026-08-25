# PLAN — Phase 3 CTransition · Phase D: outdoor terrain parity + Option C (off-center building fix), default-ON

**Status:** plan of record for Phase D. Written 2026-06-28 from a 6-source research sweep
(decomp `acclient.c/.h`, `acclient.txt` PDB dump, Chorizite ACBindings offsets, ACE
`ACE.Server.Physics` reference port, holtburger-web source, the dev-Discord corpus).
**Supersedes** the "Phase D" §4 / §9 of `docs/HANDOFF-phase3-ctransition-phaseD-next-2026-06-28.md`.

**Intended executor:** ultracode / Opus-4.8 multi-agent, run locally. This doc is
self-contained — an implementing agent should not need the research conversation.

---

## 0. Decision record (read first)

- **Scope:** make OUTDOOR movement use the faithful CTransition driver (terrain polygons +
  buildings/statics + entities), instead of delegating to the approximate heightfield path.
- **Off-center building walk-through:** **FIX IT via Option C** — register each building/static
  BSP into *every land cell its AABB overlaps*, not just its home cell. **Default-ON.**
  - Option C changes collision **results** (stops the walk-through) but **does NOT change the
    swept-sphere driver algorithm** — the deviation is confined to the building/static *index*,
    which is already a holtburger-specific structure. The faithful driver stays byte-faithful.
  - Rejected: Option A (always-load full 3×3 ring) — changes the cell-flood algorithm itself,
    risks the "landblock loading virus" (gmriggs), and costs per-step perf. Option B (bug-faithful)
    — reproduces the walk-through; rejected because this repo is a *world-builder* where off-center
    placements are routine (Vanquish420 had to force-snap buildings to cell center to avoid it).
- **Flag/rollback:** ship default-ON with a `?flag=off` escape (per memory `default-on-no-eyetest-gate`).
  The Option C overlap-registration must be **independently toggleable** so the drift A/B harness can
  demonstrate before/after (flag-off = home-cell-only = exact retail bug repro = the proof the fix works).
- **Ground truth ordering:** acclient.c wins on widths/behavior; ACE is the readable Rosetta stone;
  Chorizite offsets corroborate. **ACE is REFERENCE ONLY — no server-side gameplay/DB data flows
  into the client.** We mirror ACE's *client-physics math*, nothing else.

---

## 1. The convergent architecture (all 5 code sources agree)

1. **Outdoor terrain collides as polygons, never a raw heightfield.** Each 24×24 land cell =
   **exactly 2 triangles**, split SW↔NE vs NW↔SE by a deterministic per-cell LCG hash keyed on
   `1813693831`. Build: `CLandBlockStruct::ConstructPolygons` (decomp `acclient.c:354001`,
   magic at `:354046`; ACE `LandblockStruct.cs:182`, winding `:220-244`).
2. **Routing** (`CObjCell::find_cell_list`, decomp `:346961`; ACE `ObjCell.cs:335`, branch `:342-350`):
   `(cell_id & 0xFFFF) >= 0x100` → **indoor** (current cell only — Phase C, DONE) ;
   else → **outdoor** → `CLandCell::add_all_outside_cells` floods the sphere-radius neighbor ring.
3. **`CLandCell::find_collisions`** (decomp `:354887`) runs three checks in order:
   **terrain polys** (`find_terrain_poly` `:354859` + walkability) → **building BSP**
   (`CSortCell::find_collisions` `:356107` → `CBuildingObj::find_building_collisions`) →
   **shadow objects** (`CObjCell::find_obj_collisions` `:347142`). Terrain is its OWN polygon path,
   distinct from the BSP path Phase C reuses for env cells.
4. **Walkability** = slope test: `dot(up, plane_normal) > WalkableAllowance` (~0.7, ≈45°) +
   deep-water-not-walkable (ACE `Polygon.cs:400`; Discord Crimson/Zan 2026-03-13).

### The two reuse insights that shrink Phase D dramatically
- **CPolygon swept-sphere collision is ALREADY ported.** `polygon_hits.rs`, `polygon_walkable.rs`,
  `polygon_edge.rs`, `polygon_adjust.rs` implement `polygon_hits_sphere` / `walkable_hits_sphere`
  (used by the indoor env-cell BSP via `resolver_find.rs`, `resolver_step_down.rs`). **Do NOT re-port
  it.** Terrain triangles are just `ResolvedPolygon`s (`holtburger_dat::physics`, with `make_plane`)
  fed through the same resolver.
- **The neighbor-ring + coord math is ALREADY ported** in `objcell.rs:520-672`: `lcoord_to_cellid`,
  `gid_to_lcoord`, `add_outside_cell`, `add_cell_block`, `check_add_cell_boundary`,
  `add_all_outside_cells_sphere` — each with decomp line refs and **verified against ACE**. They are
  *unfed* only because `SpatialScene` has no `Landscape`/`LandDefsSeam` impl.
- **The per-cell static table Phase C built is exactly what Option C needs.**
  `cell_static_physics_bsp: HashMap<cell_id, Vec<CellPhysicsBsp>>` (`scene.rs:472`) is keyed by FULL
  cell_id. Outdoor full cell_ids `(landblock<<16)|(1..64)` never collide with indoor `(…|>=0x100)`,
  so we populate the SAME table for outdoor and `find_obj_collisions` reads it **unchanged**.

---

## 2. Cross-source reference table (port-from map)

| Concept | Decomp `acclient.c` | ACE (REFERENCE) | Chorizite offset | holtburger (target / existing) |
|---|---|---|---|---|
| outdoor/indoor routing | `find_cell_list :346961` | `ObjCell.cs:342` | `0x0052C0F0` | bridge wiring (WS4) |
| ring flood | `add_all_outside_cells :355346` | `LandCell.cs:82` | `0x00534370` | ✅ `objcell.rs:627` (`add_all_outside_cells_sphere`) |
| neighbor ring | `check_add_cell_boundary :355162` | `LandCell.cs:231` | `0x00533FA0` | ✅ `objcell.rs:586` |
| add one cell | `add_outside_cell :354975` | `LandCell.cs:208` | `0x00533C00` | ✅ `objcell.rs:550` |
| rect of cells | `add_cell_block :355140` | `LandCell.cs:120` | `0x00533F10` | ✅ `objcell.rs:561` |
| gid↔lcoord | `LandDefs::gid_to_lcoord` | `LandDefs.cs:180` | `0x00497D70` | ✅ `objcell.rs:531` |
| **adjust_to_outside** | `LandDefs::adjust_to_outside :467434` | `LandDefs.cs:125` | (LandDefs) | ❌ **WS1** (trait `objcell.rs:509`) |
| **get_landcell** | `LScape::get_landcell` | `LandCell` registry | — | ❌ **WS1** (trait `objcell.rs:498`) |
| build 2 tris/cell | `ConstructPolygons :354001` (`1813693831 :354046`) | `LandblockStruct.cs:182` (`:220-244`) | `0x00532A50` | split hash ✅ `terrain_subdiv.rs:383` (`cell_swto_ne_cut`); tri-build ❌ **WS2** |
| which tri has point | `find_terrain_poly :354859` | `LandCell.cs:258` | `0x00533A30` | ❌ **WS2** |
| poly vs sphere | `CPolygon::polygon_hits_sphere` | `Polygon.cs:331` | `0x00539500` | ✅ `polygon_hits.rs` |
| walkable test | `CPolygon::walkable_hits_sphere` | `Polygon.cs:400` | `0x0053A2A0` | ✅ `polygon_walkable.rs` |
| land find_collisions | `CLandCell::find_collisions :354887` | `LandCell.cs:37` (`FindEnvCollisions`) | `0x00533AA0` | ❌ **WS2/WS4** (outdoor `SceneObjCell`) |
| building BSP | `CSortCell::find_collisions :356107` | — | `0x00534DE0` | ✅ reuse `find_obj_collisions` `faithful_bridge.rs:250` |
| LandDefs consts | — | `LandDefs.cs:102-110` | — | `BlockLength 192 / CellLength 24 / LandLength 2040 / VertexDim 9 / BlockSide 8` |

---

## 3. Current-state seam map (what exists vs. what Phase D adds)

`$HW = $REPO/external/holtburger/crates/holtburger-world/src/spatial`
`$HD = $REPO/external/holtburger/crates/holtburger-dat/src/transition`

| # | Seam | File:line | State |
|---|---|---|---|
| S1 | `LandDefsSeam for SpatialScene` (`adjust_to_outside`) | trait `$HD/objcell.rs:509` | ❌ only mock impl `objcell.rs:1168` |
| S2 | `Landscape for SpatialScene` (`get_landcell`) | trait `$HD/objcell.rs:498` | ❌ only mock impl `objcell.rs:1156` |
| S3 | outdoor `SceneObjCell` (terrain tris + statics + entities) | `$HW/faithful_bridge.rs:101-286` (indoor today) | ❌ outdoor variant missing |
| S4 | terrain triangle build (2 tris from `terrain_heights` + split) | new, in `$HD` or `$HW` | ❌ split hash ✅, tri-build new |
| S5 | `add_all_outside_cells` bridge body | `$HW/faithful_bridge.rs:356` | ❌ **no-op stub** → call `add_all_outside_cells_sphere` |
| S6 | outdoor delegate flip | `$HW/faithful_bridge.rs:398` | ❌ delegates to heightfield; flip to faithful (gated) |
| S7 | Option C per-cell static/building overlap index | `$HW/scene.rs:472` (`cell_static_physics_bsp`) + bake | ❌ outdoor population + overlap registration |
| S8 | wasm live-feed populate (outdoor) | `apps/holtburger-web/src/lib.rs` (Phase C: `CELL_STATIC_BSP_PENDING`) | ❌ outdoor twin |
| S9 | flag/const | `crates/holtburger-core/src/client/movement/system.rs:577` (`USE_FAITHFUL_TRANSITION`) | extend for outdoor + Option C toggle |

Data already present: `terrain_heights: HashMap<u32,[f32;81]>` (`$HW/state/types.rs:84`);
`terrain_height_at/normal_at` (`state/types.rs:691/763`); `cell_swto_ne_cut` (`terrain_subdiv.rs:383`);
`statics_physics_bsp` / `building_physics_index` (`scene.rs:550/571`, keyed by landblock — the raw
source for the Option C bake); `resolve_static_bsp_pushout` (`scene.rs:2036`, current approximate
path — to be superseded outdoors, keep as fallback when faithful flag off).

---

## 4. Work-streams (dependency-ordered; parallelizable as noted)

> Convention for every WS: **port-from** the ACE file:line (readable) and **cross-check** against the
> decomp line + Chorizite offset in §2. Match acclient.c on any behavioral disagreement. Write unit
> tests in the same crate. Use `capped-build` for ALL Rust/wasm (laptop OOM jail — see §7).

### WS1 — `Landscape` + `LandDefsSeam` for `SpatialScene`  *(foundation; do first)*
**Goal:** feed the already-ported ring machinery.
- `impl LandDefsSeam for SpatialScene` — `adjust_to_outside(cell_id, &mut loc) -> Option<u32>`:
  port ACE `LandDefs.cs:125` (`AdjustToOutside`) + `get_outside_lcoord :200`. Snap `loc` into the
  outdoor landblock that contains it; rewrite to block-local `[0,192)`; return wrapped outdoor cell id.
  Reuse the ported `gid_to_lcoord`/`lcoord_to_cellid` (`objcell.rs:531/522`) and `LandDefs::get_block_offset`
  (`$HW/.../types` per the `objcell.rs:505` note). Constants: `CELL_SIZE=24` (`objcell.rs:491`),
  `LCOORD_MAX=2040` (`:492`), block=192, vertex grid 9, block side 8.
- `impl Landscape for SpatialScene` — `get_landcell(cell_id) -> Option<ObjCellHandle>`: return an
  outdoor cell handle when the landblock (`cell_id>>16`) is resident in `terrain_heights`, else `None`
  (faithful: the ring still adds the entry on `None`, per `objcell.rs:548` / `add_outside_cell:553`).
- **Acceptance:** unit tests porting ACE/decomp cases — a point near a cell edge floods the correct
  1–3 neighbors; `adjust_to_outside` round-trips a known outdoor position to its `(x,y)` lcoord;
  out-of-range and `>=0x100` ids return `None`. `cargo test -p holtburger-world` green.
- **Deps:** none. **Parallel with:** WS2, WS7-bake (independent files).

### WS2 — terrain triangle build + outdoor `find_collisions` geometry
**Goal:** turn a land cell's 4 corner heights into the 2 collision `ResolvedPolygon`s the resolver
already knows how to test.
- Add `fn cell_terrain_polys(landblock_id, cell_x, cell_y) -> [ResolvedPolygon; 2]` (place near
  `terrain_subdiv.rs` or a new `terrain_collision.rs` in `$HD`). Source corner heights from
  `terrain_heights[landblock]` (9×9, idx `vx*9+vy`); pick the diagonal via the EXISTING
  `cell_swto_ne_cut(gx,gy)` (`terrain_subdiv.rs:383`); emit two triangles with retail winding
  (port ACE `LandblockStruct.cs:220-244` — SW↔NE vs NE↔SW vertex order). Build the plane with
  `ResolvedPolygon::make_plane`.
  - **Invariant test:** the triangle plane height MUST equal `terrain_height_at(x,y)` at interior
    sample points (both consume `cell_swto_ne_cut`, so they must agree to f32 epsilon). This is the
    single most important correctness check — if they disagree, the diagonal or winding is wrong.
- `find_terrain_poly(point) -> Option<&ResolvedPolygon>`: port ACE `LandCell.cs:258` /
  decomp `:354859` — `point_in_poly2D` over the 2 tris (the predicate already exists in
  `polygon_*.rs` / `polygon_edge.rs`).
- **Acceptance:** `cargo test -p holtburger-dat --lib 'transition::'` green; new tests assert
  triangle-plane vs sampler agreement on several cells (both split directions) and `find_terrain_poly`
  selects the right triangle on each side of the diagonal.
- **Deps:** none for the build; integrates in WS3. **Parallel with:** WS1.

### WS3 — outdoor `SceneObjCell` (the per-cell collision body)
**Goal:** an outdoor cell that, on `find_collisions`, tests terrain tris → statics/buildings → entities,
mirroring the indoor `SceneObjCell` (`faithful_bridge.rs:133-286`).
- Extend `SceneObjCell` (or add an outdoor constructor) so for an outdoor `cell_id` it carries:
  the 2 terrain `ResolvedPolygon`s (WS2) and the per-cell statics from
  `cell_static_physics_bsp(cell_id)` (the same accessor the indoor path uses, `faithful_bridge.rs:311`).
- `find_collisions` (`faithful_bridge.rs:214`) for outdoor: run terrain polys through the existing
  resolver polygon path (terrain has no BSP — feed the 2 tris as a leaf/poly list the resolver
  iterates, matching how env polys are tested), apply the **walkable gate** (`walkable_hits_sphere` /
  slope > `WalkableAllowance`, deep-water-not-walkable via existing `water_depth_at` /
  `is_entirely_water_cell_at`, `transition.rs:172-176`), then `find_obj_collisions` for statics
  (UNCHANGED), then entities (`entity_colliders_near`). Order matches decomp `find_collisions:354887`.
- **Acceptance:** drift unit test (`spatial::faithful_bridge::drift`) — a mover on flat outdoor
  terrain stays grounded over a sweep; a mover into a steep slope/cliff stops; height tracks
  `terrain_height_at` within tolerance. Mirror the Phase C `faithful_static_object_stops_mover` test.
- **Deps:** WS1 (handles), WS2 (tris). **Then:** WS4 wires it live.

### WS4 — wire the bridge + dispatch (the flip)
**Goal:** route outdoor poses through the faithful path.
- Replace the **no-op** `add_all_outside_cells` (`faithful_bridge.rs:356`) with a call to
  `add_all_outside_cells_sphere(cell_array, scene, scene, p, num_sphere, spheres)` (the scene now
  implements both seams from WS1).
- Flip the outdoor branch at `faithful_bridge.rs:398`: when the outdoor faithful flag is on
  (WS9), build the cell ring + run the outdoor `SceneObjCell` (WS3) instead of delegating to
  `find_transitional_position`. Keep the heightfield delegate as the flag-off fallback and the
  unbaked-landblock guard (parallel to the no-BSP guard at `:408`).
- **Acceptance:** headless in-world A/B (§6) — outdoor walk stays grounded, 0 errors, no fall-through,
  with the flag ON; flag OFF still uses the heightfield (regression guard).
- **Deps:** WS1, WS2, WS3, WS9.

### WS7 — Option C: per-cell building/static overlap index  *(the headline fix)*
**Goal:** every building/static BSP is testable from any cell its AABB overlaps.
- **Bake step:** for each outdoor static/building currently keyed by landblock in
  `statics_physics_bsp` / `building_physics_index` (`scene.rs:550/571`): compute its world AABB,
  convert to land-cell coords (`/24`, like `add_all_outside_cells_sphere:651`), get the
  `[min_x..=max_x, min_y..=max_y]` cell rectangle (reuse `add_cell_block` logic), and insert its
  `CellPhysicsBsp` (framed to world) into `cell_static_physics_bsp[cell_id]` for **every** overlapped
  cell — not just its home cell. This is the only behavioral deviation from retail, and it is
  index-only (the resolver/`find_obj_collisions` are untouched).
- **Loading-virus bound (gmriggs):** only register into cells whose landblock is resident
  (`get_landcell`/`terrain_heights` has it). Never trigger a landblock load from the bake. A building's
  AABB overlaps at most the adjacent cells, so the rectangle is tiny; clamp to loaded landblocks.
- **Toggle:** gate the *overlap* registration behind a sub-flag (WS9). OFF = register to home cell
  only = exact retail bug repro (for the drift A/B proof). ON (default) = full overlap = fix.
- **Acceptance:** unit test — an off-center building whose BSP overruns into the neighbor cell is,
  with overlap ON, present in the neighbor cell's static list; with OFF, only in its home cell.
  Drift A/B (WS-test): player approaching the off-center building from the neighbor cell **stops**
  with overlap ON, **walks through** with OFF. This pair IS the proof the fix works.
- **Deps:** WS1 (cell coord helpers) for the AABB→cells math. **Parallel with:** WS2/WS3.

### WS8 — wasm live-feed (outdoor population)
**Goal:** feed the live client the outdoor terrain + Option C statics, mirroring Phase C.
- In `apps/holtburger-web/src/lib.rs`: add an outdoor twin of the Phase C `CELL_STATIC_BSP_PENDING` /
  `drain_pending_cell_static_bsps_into` staging. On landblock load, run the WS7 overlap bake and stage
  the per-cell static entries; terrain tris (WS2) are built on demand from `terrain_heights` so they
  need no staging beyond what `terrain_height_at` already requires.
- **Acceptance:** headless boot logs the outdoor populate (analogue of `[bsp] drained … cell STATIC
  physics BSPs`) for real DAT landblocks; outdoor collision works in-world.
- **Deps:** WS7. **Last (integration).**

### WS9 — flags / const
- Extend `system.rs:577`: keep `USE_FAITHFUL_TRANSITION` (indoor, already default-ON); add an
  **outdoor** faithful const (default-ON) + a runtime `?faithfulOutdoor=off` escape, and an
  Option-C **overlap** toggle (default-ON, `?buildingOverlap=off` for the bug-repro A/B). Register
  the url-flags in `$HOLT/docs/url-flags.md` with the JS reader line (per memory `url-flags-master`).
- **Acceptance:** bare-default boot = faithful outdoor + overlap ON; each `?flag=off` rolls back
  cleanly. Document in url-flags.md.

---

## 5. Suggested ultracode orchestration

Pipeline-friendly. Round 1 (parallel, independent files): **WS1**, **WS2**, **WS7-bake**, **WS9**.
Round 2 (depends on R1): **WS3** (needs WS1+WS2), **WS8** (needs WS7). Round 3: **WS4** (the flip,
needs WS1–3+WS9). Round 4: **validation** (§6) — unit suites + drift A/B + the off-center proof +
headless in-world. Add an adversarial verify pass on WS4/WS7 (the behavior-changing seams): a second
agent confirms (a) the driver code path is unchanged by Option C, (b) flag-off reproduces retail
exactly, (c) terrain triangle planes agree with `terrain_height_at`.

---

## 6. Test & validation strategy

- **Unit (fast, laptop):**
  - `capped-build ~/.cargo/bin/cargo test -p holtburger-dat --lib 'transition::'` (terrain tris,
    find_terrain_poly, poly invariants) — keep the existing 252 green.
  - `capped-build ~/.cargo/bin/cargo test -p holtburger-world --lib 'spatial::faithful_bridge::drift'`
    (ring flood, outdoor grounded walk, cliff stop, Option C overlap pair) — extend the existing 9.
  - `capped-build ~/.cargo/bin/cargo check -p holtburger-core`.
- **Headline proof (drift A/B):** off-center building, player approaches from neighbor cell.
  `buildingOverlap=on` → STOPS; `=off` → walks through. Both numbers in the test output.
- **Triangle-plane invariant:** terrain triangle height == `terrain_height_at` at sample points,
  both split directions. Non-negotiable.
- **Live headless in-world (no 1070 needed — collision is CPU-side):** Playwright (raw
  `chrome --headless` botches the WS bridge upgrade). Stack: serve.py `:8765`, wsbridge `:8080`,
  ACE UDP `:9000/:9001`, MariaDB. Account **`<test-account>`/`<test-account>`** (NOT the owner's `<account>`).
  Harness: `harness/lib/boot.mjs#launchAndEnter({query,timeoutMs})` (env `HARNESS_ACCOUNT`/`HARNESS_PASSWORD`).
  Bot URL flags: `?nullRender=1&renderOnDemand=1&netDrainHz=30&nosw=1`. Confirm outdoor walk stays
  grounded, 0 errors, the outdoor populate log appears, and overlap-ON stops at an off-center building.

---

## 7. Build / paths (capped-build discipline — laptop is an 8 GB OOM jail)

```bash
REPO=/home/wbterminal/WorldBuilder-ACME-Edition
cd $REPO/external/holtburger
# NEVER bare cargo --workspace / bare wasm-pack locally (that's the buildbox -j18 job)
PATH="$HOME/.cargo/bin:$PATH" capped-build ~/.cargo/bin/cargo test  -p holtburger-dat   --lib 'transition::'
PATH="$HOME/.cargo/bin:$PATH" capped-build ~/.cargo/bin/cargo test  -p holtburger-world --lib 'spatial::faithful_bridge::drift'
PATH="$HOME/.cargo/bin:$PATH" capped-build ~/.cargo/bin/cargo check -p holtburger-core
PATH="$HOME/.cargo/bin:$PATH" capped-build wasm-pack build --target web --out-dir pkg --dev   # ~1m; pkg/ gitignored → rebuild after pull
```
Kill `rust-analyzer` first to reclaim RAM if a build OOMs. Heavy `cargo test --workspace` → buildbox.

Key files:
- Driver: `$REPO/external/holtburger/crates/holtburger-dat/src/transition/` (`objcell.rs` ring,
  `polygon_*.rs` collision, `terrain_subdiv.rs` split, new `terrain_collision.rs`).
- Bridge: `$REPO/external/holtburger/crates/holtburger-world/src/spatial/` (`faithful_bridge.rs`,
  `transition.rs`, `scene.rs`, `state/types.rs`).
- Flag: `$REPO/external/holtburger/crates/holtburger-core/src/client/movement/system.rs:577`.
- wasm feed: `$REPO/external/holtburger/apps/holtburger-web/src/lib.rs`.
- url-flags doc: `$REPO/external/holtburger/apps/holtburger-web/docs/url-flags.md`.

---

## 8. Risks & carried VERIFY

- **Triangle winding / diagonal mismatch** → collision floor disagrees with render/`terrain_height_at`.
  Guard: the §6 plane-invariant test. The split hash is shared (`cell_swto_ne_cut`), so winding is the
  only freedom — port ACE `LandblockStruct.cs:220-244` exactly.
- **adjust_to_outside edge cases** (landblock wrap at the 2040 world edge, structure cells) — port ACE
  `LandDefs.cs:125` precisely; test the corners.
- **Option C AABB→cells over-registration** at landblock boundaries (loading-virus). Bound to resident
  landblocks; never load from the bake (WS7).
- **Cross-landblock building** (AABB spans two landblocks) — register only into resident neighbor; the
  faithful ring will pick up the rest when that landblock loads.
- **Carried from Phase C** (not Phase D blockers): precise `point_in_cell` via membership BSP (currently
  AABB); per-static scale (statics treated unscaled); cross-portal cell collision; quaternion
  `set_rotate`/SLERP for orientation-changing sweeps (player capsule upright → identity frame fine).
- **Do NOT** edit/rebuild `~/ace-server` (memory `keep-ACE-vanilla`); it's reference only. No PhatAC/PhatSDK.

---

## 9. Definition of done

1. Outdoor movement uses the faithful driver (terrain tris + buildings/statics + entities), default-ON,
   with `?faithfulOutdoor=off` rollback to the heightfield path.
2. Option C overlap registration default-ON; off-center buildings no longer walk-through; the drift A/B
   pair proves it (on=stop, off=walk-through).
3. All unit suites green (`transition::` ≥252, `drift` ≥9 + new), `holtburger-core` checks clean.
4. Headless in-world: outdoor walk grounded, 0 errors, outdoor populate log present.
5. url-flags.md updated; wasm rebuilt so default-ON is live (the source const alone doesn't ship — it's
   compiled into the wasm).
