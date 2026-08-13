# Indoor (EnvCell) vs Outdoor (Landblock): verified architecture reference

**2026-08-13.** Written to settle a recurring design question — *"can we merge building
interiors, EnvCells and the outdoor world into one system, since we control our Rust and
three.js, while still reporting position to ACE as normal and keeping retail-player
compatibility?"* — and, more importantly, to stop four specific wrong beliefs from being
re-derived every few weeks.

**Answer: don't merge them.** Retail keeps two render contexts deliberately; this client
already mirrors that correctly. The change actually worth making is smaller and is
described in §9.

**Provenance.** §1, §8 and the ValidateMovement material were read directly against
`~/ace-server/Source`. §2–§6 come from an adversarial decomp review that independently
re-read every citation and *refuted* the thesis it was given. §7 is a full parse of
`~/ac_base_dats/client_cell_1.dat` (805,348 files enumerated, 734,976 EnvCells, 0
embedded-id mismatches, 0 trailing-byte files). Where a claim was refuted the refutation
is recorded in §10 rather than deleted — the point of this file is that nobody re-derives
them.

---

## 1. Coordinates: positions share a frame, geometry does NOT

`LandDefs::get_block_offset` (`acclient.c:123110-123156`) keys **only** on the top 16 bits
of the cell id, returns zero within a landblock, and never emits a nonzero z:

```c
if ( cell_from >> 16 == cell_to >> 16 )
  result->x/y/z = ZeroVector;              // 123124  indoor/outdoor irrelevant
else {
  LODWORD(result->z) = 0;                  // 123147  z is ALWAYS 0
  result->x = (double)(signed int)(v7 - v5) * 24.0;
  result->y = (double)(signed int)(v8 - v6) * 24.0;
}
```

ACE agrees with no indoor branch anywhere — `ACE.Entity/Position.cs:409`, `:434`, `:458`,
`:483` all use `(ΔlbX * 192 + Δx)` for any pair of positions. So do we
(`crates/holtburger-common/src/position.rs:65-73`).

**The trap.** "Zero block offset" does not mean "same mesh space":

| | frame pushed at draw time | geometry authored in |
|---|---|---|
| terrain | **identity** (`DrawBlock:458984-458995`, one push for the whole block) | landblock-local 0..192 (`CLandBlockStruct::ConstructVertices:354621-354658`, `poly_size = 192.0/side_polygon_count`) |
| EnvCell | **`&cell->pos`, per cell** (`PView::DrawCells:461509`, `:461575`) | cell-local — the `0x0D` Environment is a shared prefab |

`CEnvCell::point_in_cell:347935` does `Frame::globaltolocal(&this->pos.frame, ...)` before
the BSP test for exactly this reason. EnvCells carry a full rigid transform (rotation
quaternion + translation, including the negative z that puts dungeons underground) that
LandCells never receive. **A client that treats zero block offset as a shared mesh space
stacks every dungeon cell at the landblock origin.**

We already do this correctly: `apps/holtburger-web/src/lib.rs:21431-21432` computes
`landblock_origin_x = lb_x_byte * 192.0`, `:21605` adds it to the EnvCell frame, and
`scene3d/cells.js:1607` consumes the result without re-offsetting. The header at
`cells.js:8-11` states the contract. Do not "fix" it.

---

## 2. The render split is `cellId < 0x100`, NOT `SeenOutside`

`SmartBox::RenderNormalMode`, `acclient.c:144885-144918`:

```c
v5 = v4 < 0x100;                                    // 144889  pure outdoor test
v6 = v4 < 0x100 || v3->viewer_cell->seen_outside;   // 144890
if ( v5 ) {                                         // 144901
  LScape::update_viewpoint(...); Render::update_viewpoint(...);
  Render::set_default_view();
  Render::useSunlightSet(1);                        // 144905
  LScape::draw(v3->lscape);                         // 144906
} else {
  if ( v6 ) {                                       // 144910
    v8 = Position::get_outside_cell_id(&v3->viewer);
    LScape::update_viewpoint(v3->lscape, v8);       // 144913  <-- v6's ONLY effect
  }
  Render::update_viewpoint(&v3->viewer);
  RenderDevice::render_device->vfptr->DrawInside(v3->viewer_cell);   // 144916
}
```

`v6` gates exactly one call, a streaming/viewpoint update. It does **not** reach
`set_default_view`, `useSunlightSet(1)`, or `LScape::draw`.

**Complete inventory of every `seen_outside` read in `acclient.c`** — six sites, none in
the render path:

| line | function | effect |
|---|---|---|
| 144890 | `SmartBox::RenderNormalMode` | which cell id `LScape::update_viewpoint` receives |
| 146625 | `CellManager::Reset` | whether `LScape::release_all` runs |
| 146721 | `CellManager::ChangePosition` | world sunlight + ambient scalars + ambient sounds |
| 348050 | `CEnvCell::PreFetchCells` | also prefetch the landblock's cells |
| 350186 | `CEnvCell::grab_visible_cells` | also `LScape::grab_visible_cells` |
| 350411 | `CEnvCell::release_cells` | also `LScape::release_visible_cells` |

Uniform for **all** EnvCells regardless of `SeenOutside`:

1. Always `DrawInside` / `indoor_pview` (`RenderDeviceD3D::DrawInside:456844-456846`). No escape exists.
2. `Render::minimize_envcell_lighting()` always runs (`DrawEnvCell:456884-456892`; gated only on the global `skipMinimStep`, declared `acclient.c:57373` and **never assigned**).
3. A distinct detail-surface regime — `environment_detail_surface` (`:456894`, blend 9/6) vs `landscape_detail_surface` (`DrawBlock:459043`, blend 5/6) vs `building_detail_surface` (`DrawBuilding:456943`, blend 9/6). Chosen by cell class, never by `SeenOutside`.
4. Sunlight is explicitly **off** while cell geometry rasterizes: `PView::DrawCells:461611` does `useSunlightSet(0)` before the `DrawEnvCell` loop and restores at `:461615`.

The ambient constant is real, though. `CellManager::ChangePosition:146721-146744`: when
outdoor **or** `seen_outside`, install `LScape::sunlight` / `sunlight_color` /
`calc_object_light()`; otherwise `SetWorldAmbientLight(smartbox, 0.2, 0xFFFFFFFF)` —
flat 0.2 white.

**So `SeenOutside` is a streaming-and-world-light-scalar flag. It is not a render mode.**

---

## 3. What retail actually does: `outside_view` portal reachability

The landscape *is* drawn from inside — but the trigger is per-frame and dynamic, not a DAT
flag. `PView::DrawCells:461474-461480`:

```c
if ( this->outside_view.view_count )    // 461474
{
  Render::useSunlightSet(1);            // 461478
  Render::PortalList = (struct portal_view_type *)v2;
  LScape::draw(v2->lscape);             // 461480   (LScape::draw draws GameSky too, 307764)
```

`outside_view.view_count` is set in `PView::ClipPortals:462354-462367` only when a portal
with `other_cell_id == -1` clips to a **non-empty screen region**, and only when
`pview->draw_landscape`. `RenderDeviceD3D::Init:456786` builds `indoor_pview = PView(1)`
(draw_landscape on) and `outdoor_pview = PView(0)`.

**Sky, sun and terrain from inside are a per-frame, per-aperture portal-reachability
result.** This subsumes town buildings and dungeons-with-entrances in one mechanism with
no per-cell classification at all.

Our `currentDungeonHasOutdoorPortal()` + `?sealedCull` (`cells.js:2478-2498`) is a coarse
*static* approximation of this. Making it per-frame and per-aperture is the target.

---

## 4. Anti-z-fighting: three mechanisms, none of them clip planes

`SetClipPlane` and `D3DRS_CLIPPLANEENABLE` **never appear in `acclient.c`**.
`m_caps.MaxUserClipPlanes` is read once (`:457135`) and never acted on. What retail calls
clip planes are screen-space *cull* tests (`Render::viewconeCheck` body at `:379735`,
`Render::block_plane_check:381150`, `Render::get_clip_height:380418`) reached via
`PView::GetClip:461052` → `ACRender::polyClipFinish` → `Render::copy_view:381445`.

The rasterizer clips nothing: `DrawEnvCell:456904-456918` pushes every cell polygon with
`planeMask = -1`, and `D3DPolyRender::DrawPolyInternal:455306` does one visibility test
(`curr_surfaces[p->pos_surface]->type & 6`), sets cull mode from `p->sides_type`, and
issues `DrawPrimitiveUP` on the full unclipped polygon.

What actually does the work:

1. **Cell-level portal culling** — a cell enters `cell_draw_list` only if `ClipPortals` produced a non-empty aperture (`ConstructView:462423-462466`).
2. **Z-buffer clear + per-portal depth stamping** — `DrawCells:461474-461534`: draw landscape → `Clear(4, …, 1.0)` (flag 4 = `D3DCLEAR_ZBUFFER`, `RenderDeviceD3D::Clear:457587`) → each `other_cell_id == -1` portal gets `D3DPolyRender::DrawPortalPolyInternal(portal, 0)` (`:453882`), which sets `DEPTHTEST_ALWAYS` + depthWrite and writes real z at **alpha 0** under SRCALPHA/INVSRCALPHA — a pure depth stamp.
3. **Back-to-front painter order** — `InsCellTodoList:461917-461925` inserts by distance; `DrawCells:461567` walks farthest-first.

**(2) is what `?indoorDepthSplit` and `?portalPunch` already implement.** The shipped
non-stencil path is the retail-faithful one; retiring the stencil renderer on 2026-07-06
was correct. `CEnvCell::calc_clip_planes:348871` does build 3D planes, but they are
consumed by `CPartCell::add_part:350602` / `CShadowPart` — splitting *object* geometry
across cells, not walls.

Residual: cross-cell coincident two-sided walls (`sides_type == 1` makes per-poly cull a
no-op). Retail avoids them via (1) — its narrowed per-portal view rarely admits both
cells. `cells.js:2207-2223` **unions** `getRenderSetWithFrustum` with
`getRenderSetWithPView`, which is strictly wider than retail. Narrowing that union is the
lead worth pulling.

---

## 5. Dungeon geometry escapes its landblock box

Full-dat survey. Of 1,776 true dungeon landblocks (`LandblockInfo.numBuildings == 0`),
**1,766 (99.4%)** have cells outside xy `[0,192]`. 52.6% of all EnvCell-bearing landblocks
have `min_y < 0`; 47.4% have `min_z < 0`.

| extreme | value | landblock |
|---|---|---|
| min_y | −1590 | `0x00B0` |
| max_x | 940 | `0x02AC` |
| min_z | −324 | `0x8804` |
| max_z | 650 | `0x2384` |

`0x0001` verified byte-for-byte: 463 cells, x `[0,130]`, y `[−180,0]`, z `[−90,6]`, 1096
portals, **zero** outside-portals, `Flags = 0`.

Signature: dungeons run negative-y/negative-z; building interiors stay in `[0,192]²` at
positive z. **Do not assume a dungeon landblock fits a 192³ AABB.**

---

## 6. Classifying dungeon vs building

Use **`LandblockInfo.numBuildings == 0`**. The two intuitive alternatives are both wrong:

- **All-zero heightmap — non-diagnostic.** 1,644 of 3,409 EnvCell-bearing landblocks (48.2%) have *nonzero* heightmaps; even under the strict definition 32 counterexamples remain. And 26,227 non-EnvCell landblocks (42.6%) are all-zero — that's ocean.
- **`SeenOutside` — unreliable.** 99 landblocks with buildings have zero `SeenOutside` cells (windowless cellars).

`EnvCellFlags` (`ACE.Entity/Enum/EnvCellFlags.cs:8-10`, matching `CEnvCell::UnPack:349189`):
`SeenOutside = 0x1`, `HasStaticObjs = 0x2`, `HasRestrictionObj = 0x8`. There is no `0x4`
here — `0x4` is a **CellPortal** flag meaning "leads outside" (`CCellPortal::Pack:362368`
sets it when `other_cell_id == -1`), and it is the only cross-landblock escape that
exists: `CCellPortal::UnPack:362396-362398` writes `-1` for it and `block_mask | u16`
otherwise, while `CBldPortal::UnPack:362518/:362540` has **no sentinel at all** for either
`other_cell_id` or its stab entries. `block_mask` is the cell's own landblock
(`CEnvCell::UnPack:349209`, `v8 & 0xFFFF0000`). **Portals and PVS entries can never cross
a landblock.**

Building interiors are `LandblockInfo.Buildings[]` + EnvCells in the *same* surface
landblock: Holtburg `0xA9B4` has `numCells = 123`, `numBuildings = 12`, and EnvCell
`0xA9B40100`'s `position.origin` is byte-identical to `BuildInfo[0].frame.origin`.

---

## 7. The render bake is UPSTREAM of the wire

This is the finding that most constrains any redesign, and it is easy to get backwards.

`fetch_env_cells_in_landblock` (`apps/holtburger-web/src/lib.rs:21418`) is a **render
bake** — it triangulates cell meshes — and it is simultaneously the **sole producer** of
`cell_aabbs`, `cell_membership`, `cell_seen_outside` and the portal graph
(`lib.rs:21730-21745` → `drain_pending_cell_graph_into`, `:17659-17668`). Then:

```
lib.rs:21730         render bake pushes cell AABB + SeenOutside into CELL_GRAPH_PENDING
   ↓
scene.rs:2917        entered_envcell_for_outdoor_pose scans cell_aabbs + cell_membership
   ↓
system.rs:5272       USE_LOCAL_ENVCELL_ENTRY (compile-time true, system.rs:1391)
                     writes pose.landblock_id = Guid(entered)
   ↓
system.rs:8676       landblock_id change FORCES an immediate AutonomousPosition send
   ↓
GameActionAutonomousPosition.cs:19 → Player_Tick.cs:463-469 → PhysicsObj.cs:3900-3903
                     server stores the client's cell id verbatim
   ↓
ObjectMaint.cs:337-388 via PhysicsObj.cs:2740
                     server derives your visible-object set and monster aggro from it
```

**ACE never validates that the reported cellId contains the reported x,y,z.** The only
geometric gates are `GetBlockDist > 1` (`PhysicsObj.cs:4324`), the speed check
(`Player_Tick.cs:452`), a z-hack check (`:459`) and a `0x18A` special case.

The client is **not** echoing the server. `system.rs:5245-5256` says so explicitly:
*"retail/ACE write the new ObjCellID CLIENT-LOCALLY on every transition … the server never
participates in the entry decision."*

**Consequence: changing when interiors get baked changes when `landblock_id` flips on the
wire, which changes what ACE creates and destroys for you.** Interior residency/timing is
not a private rendering concern. Draw *policy* is.

---

## 8. Server constraints (compatibility budget)

`Player_Tick.cs:537-563 ValidateMovement`. Only evaluated when `!Teleporting` **and** the
landblock high word changes — same-landblock indoor→indoor is never checked at all, so
single-LB interiors (Academy, 568 cells) are wholly unconstrained.

| from | to | result |
|---|---|---|
| indoor (≥0x100) | indoor (≥0x100) | **REJECT** unless the pair is exactly `{0xD6990112, 0xD599012C}` |
| outdoor | indoor | pass |
| indoor | outdoor | pass |
| both landblocks `IsDungeon` | — | **REJECT** |

The `if (!buggedCells.Contains(a) || !buggedCells.Contains(b)) return false;` is **correct,
not a bug** — `!A || !B ≡ !(A && B)`, i.e. "reject unless both endpoints are whitelisted."
(The whitelist may nonetheless be dead code if both landblocks are `IsDungeon`, since the
second check then rejects anyway. Unverified.)

Failure mode is nasty: `Player_Tick.cs:419-424` logs `log.Error` and returns **with no
`SendUpdatePosition` / ForcePosition correction** — the client silently desyncs.

`IsDungeon` itself (`Physics/Common/Landblock.cs:575-607`): all heights 0, ≥1 EnvCell,
**no buildings** — consistent with §6.

The C2S surface really is thin: 16 C2S message files, 156 GameActions, and only
`Movement_AutonomousPosition`, `Movement_MoveToState`, `Movement_Jump*` and
`Advocate_Teleport` carry position/cell. Appraisal does **no** LOS or PVS check
(`Player.cs:265`, `SearchLocations.Everywhere`). Nothing render-derived crosses the wire
*except* via the cell id in §7.

---

## 9. Recommendations

1. **Do not merge the render paths.** Retail runs two contexts on purpose (§2) and we already mirror it.
2. **Do not touch the interior producer or its timing** without treating it as a wire-visible change (§7). This includes folding the EnvCell bake into `_guardedStreamBake` — that guard caps at 6 in-flight (`stream_bake_guard.js:33`), interior bakes are the most expensive per-LB bake we have ("Academy is 568 cells in ONE landblock", `cells.js:831-833`), and the shape of that change is exactly the BUG-2 starvation regression at `cells.js:977-1017`.
3. **Do make the draw policy dynamic.** Replace the static indoor/sealed classification with retail's per-frame `outside_view` portal-reachability test (§3). Local to rendering, cannot perturb the wire, and strictly closer to retail than what we ship.
4. **Narrow the PVS union** (`cells.js:2207-2223`) toward retail's per-portal aperture (§4) before considering any new depth trick for coincident walls.
5. **If a `SeenOutside` three-state is ever built anyway**, it must be `Unknown | Sealed | SeenOutside`. `scene.rs:2064` returns `unwrap_or(false)` — an unbaked or LRU-evicted cell reads as *sealed dungeon*, the most-indoor answer, which is backwards for any building-merge design. The surface is ~21 JS sites across 12 files plus ~63 Rust `is_indoors()` sites, most in the movement/physics path, not lighting.

---

## 10. Refuted — do not re-derive

| claim | verdict | why |
|---|---|---|
| Render policy splits on `SeenOutside` | **REFUTED** | `v6` gates only `LScape::update_viewpoint`; `v5` (`< 0x100`) gates sun/sky/terrain (§2) |
| Building interiors render as outdoor | **REFUTED** | all EnvCells always take `DrawInside`/`indoor_pview` + `minimize_envcell_lighting` + env detail set (§2) |
| Indoor and outdoor share one mesh space because the block offset is zero | **MISLEADING** | positions yes, geometry no — EnvCells get a per-cell rigid transform (§1) |
| Per-portal clip planes prevent coincident-wall z-fighting | **REFUTED** | no `SetClipPlane` in the binary; it is portal culling + Z-clear + depth stamping + painter order (§4) |
| Dungeon landblocks always have all-zero heightmaps | **REFUTED** | 48.2% of EnvCell-bearing LBs have nonzero heights; 42.6% of non-EnvCell LBs are all-zero (ocean) (§6) |
| A unified client would need to start running `point_in_cell` | **REFUTED** | it already does, unconditionally (`scene.rs:2917`), and it is client-authoritative (§7) |
| Portal visibility should become a per-instance pool mask | **REFUTED** | already ships (`pool_registry.js:863 setCellsVisible`), and cannot replace `tickPortalStencil`'s layer moves (`cells.js:2646-2650`) — a pool is one object; its instances cannot be on two layers |
| `ValidateMovement`'s `\|\|` is an `&&` typo | **REFUTED** | `!A \|\| !B ≡ !(A && B)` — correct pair-whitelist (§8) |
| The three `*Urgent` flags are a default-ON footgun | **REFUTED** | `!== "off"` is deliberate; `url-flags.md:480-482` records the 2026-08-04 user-verified default-ON flip. The stale *comments* were the bug and are fixed in this commit |

---

## 11. Citation hygiene

- **`CEnvCell::UnPack` (`acclient.c:349134`) is decompiled against a shifted `this`.** IDA's field names there are systematically wrong: `clip_planes` = portals, `restriction_obj` = numPortals, `num_lights` = numStabs, `num_stabs` = numStaticObjects, `seen_outside` = staticObjectFrames. **Anyone quoting `acclient.c:349354` as `seen_outside` is quoting a decompiler artifact.** Same caveat for `CLandBlockInfo::UnPack:351049`. Use ACE / DatReaderWriter for field order; use the decomp for behavior.
- `PView::ConstructView` has **two** overloads — `(PView*, CEnvCell*, u16)` at `462423` and `(PView*, CBldPortal*, CPolygon*, int, int)` at `462507`. `462505` is dead space.
- `external/ACE/Source/ACE.DatLoader/` **does not exist** — that checkout is partial (`ACE.Entity` + `ACE.Server` only). The DAT loader lives at `~/ace-server/Source/ACE.DatLoader/` and `external/melt/Source/ACE.DatLoader/`. The file is `LandblockInfo.cs`, not `LandBlockInfo.cs`.
- Loose end: `Render::world_lights.m_bSunlightValid = 0` is set in the same branch that installs sunlight (`:146729`); nothing here depends on it, but its consumer was not traced.
