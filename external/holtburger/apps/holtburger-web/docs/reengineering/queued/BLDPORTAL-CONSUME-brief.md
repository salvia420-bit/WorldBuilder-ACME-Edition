# QUEUED TASK — BLDPORTAL-CONSUME (design dossier; batch-D `postBakeCodeWork`)

_Prepared 2026-08-11 by fanout-D agent a5. RESEARCH ONLY — no code changed._
_Every `acclient.c` / `acclient.h` claim below carries a symbol anchor you can `rg -a` for._
_Every holtburger `file:line` was opened in the session that wrote this file._

Charge (queue JSON, verbatim): *"C1 root fix: `BuildInfo.portals` (retail `CBldPortal` —
THE outdoor↔interior link + stab lists) parsed then discarded; outdoor visibility of
interiors is an AABB heuristic. DIRECTLY relevant to the Yaraq blacksmith
terrain-over-subterranean-interior bug (owner-reported 2026-08-10): retail punches terrain
depth via building portal polys (`PView::DrawCells`), which we cannot do without this
data."* Risk: **high (staged)**. Lands AFTER `PORTAL-GRAPH-SPLIT` (a3) and
`PORTAL-FLAGS-DECODE` (a4).

---

## 0. Executive summary — what this session established

Three findings change the shape of the task versus the queue card:

**F1 — The aperture polygons are ALREADY PARSED.** The queue card implies new DAT work.
It is not needed. Retail's building aperture poly is `CPortalPoly { portal_index, portal }`
(`acclient.h:39075`), living in `BSPPORTAL::in_portals` inside the building GfxObj's
**drawing** BSP. holtburger parses exactly that: `BspPortal.portal_polys: Vec<PortalPoly>`
where `PortalPoly { portal_index: i16, poly_id: i16 }`
(`crates/holtburger-dat/src/physics.rs:32-39`, `:62-65`, read at `:1124-1135`, Drawing trees
only), and `GfxObj.polygons: HashMap<u16, Polygon>` resolves `poly_id`
(`crates/holtburger-dat/src/file_type/gfx_obj.rs:21`, `:54-62`). **Zero new parsing.**

**F2 — The `portal_index` ↔ `BuildInfo.portals[]` correspondence is exact, world-wide.**
Measured over all of `~/ac_base_dats/client_cell_1.dat` + `client_portal.dat`
(probe source in Appendix B; runs in 0.7 s):

```
LandblockInfo records ............ 5346
BuildInfo entries ................ 6979  (with >=1 CBldPortal: 5464)
CBldPortal records ............... 16937   stab entries 261543
  other_portal_id == 0xFFFF ...... 0
  flags histogram ................ [(1, 5729), (3, 11208)]
  entry cells subset of stab set . 5464 yes / 0 no
building GfxObj drawing-BSP:
  usable (PORT nodes present) .... 5464
  no drawing_bsp / non-0x01 model  0
  drawing_bsp but zero PORT ...... 0
  portal_poly COUNT == portals ... 5464 match / 0 mismatch
  portal_index set == 0..n-1 ..... 5464 yes / 0 no
  poly_id resolvable in polygons . 16937 yes / 0 no
```

Read that as: **every** portal-bearing building in the retail world is a `0x01` GfxObj whose
drawing BSP carries exactly as many `PortalPoly` records as the landblock's `BuildInfo` has
`CBldPortal` records, with `portal_index` forming a clean bijection onto `0..n-1`, and every
`poly_id` resolving. `BuildInfo.portals[pp.portal_index]` is a plain array index — no
lookup table, no fallback path, no partial-data arm to design.

**F3 — The Yaraq blacksmith aperture exists and is identified.** `PORTAL-P0-VALIDATE`'s
`laptopIgpuFindings2026-08-10` reports the punch alive (offered 12–28, kept most) yet grass
still over-drawing the sunken smithy courtyard, concluding *"the courtyard region is simply
covered by NO kept aperture polygon"*. Correct — because today's punch feed is
`getVisiblePortalApertures` (`apps/holtburger-web/src/lib.rs:35421`), which selects from
`cell_portal_polygons`, i.e. **EnvCell** `CCellPortal` records. The courtyard aperture is a
**building** portal, and it is right there in the DAT:

```
== LB 0x7D640000  num_cells=116 buildings=8 ==
  bld[0] model=0x01000E40 num_leaves=28 portals=6 stabs=84 (uniq 14)
      p[3] flags=0x0001 exact=1 side=1 other_cell=0x0100 other_portal=0x0003 stabs=[256..269]
      gfx 0x01000E40: PORT portal_polys=6 resolvable=6 polys=98
```

`other_cell=0x0100` is the blacksmith interior `0x7D640100` — the exact cell
`PORTAL-P0-VALIDATE` names (`@teleloc 0x7D640100 87.8 111.8 12.005`). Its aperture is
`GfxObj 0x01000E40` drawing-BSP portal poly `portal_index=3`. **The Yaraq fix is a feed
change, not a new algorithm.**

---

## 1. RETAIL SEMANTICS

### 1.1 `CBldPortal` on the wire and in memory

In-memory layout (`acclient.h:32094-32103`):

```c
struct __cppobj CBldPortal {
  int portal_side;            // decoded, INVERTED, from wire flags bit 1
  unsigned int other_cell_id; // block_mask | wire u16  (FULL cell id)
  int other_portal_id;        // wire u16, NOT masked
  int exact_match;            // wire flags bit 0
  unsigned int num_stabs;
  unsigned int *stab_list;    // block_mask | wire u16, each  (FULL cell ids)
  float sidedness;            // runtime-only; no wire field
};
```

`CBldPortal::UnPack(this, block_mask, addr, size)` — **`acclient.c:362499`**:

| step | bytes | decode | anchor |
|---|---|---|---|
| flags | u16 | `exact_match = v6 & 1` | `:362516` |
|  |  | `portal_side = ((u8)~(u8)v6 >> 1) & 1` — **inverted bit 1** | `:362517` |
| other_cell_id | u16 | `= block_mask \| v7` | `:362520` |
| other_portal_id | u16 | raw, unmasked | `:362523` |
| num_stabs | u16 |  | `:362526` |
| stab_list[i] | u16 × n | `= block_mask \| v13` — **each widened to a full cell id** | `:362537` |
| pad | 2 | `if (num_stabs & 1) addr += 2` | `:362541-362542` |

`CBldPortal::pack_size` (`acclient.c:362575`) confirms the record size:
`(2*num_stabs + 8)` rounded up to 4. Constructor defaults (`acclient.c:362406`):
`portal_side = -1`, `other_portal_id = -1`, `other_cell_id = 0`.

Two things the client does that holtburger does not (§3.1):

1. **Bit 2 is NOT read on the building side.** `CBldPortal::UnPack` reads only bits 0 and 1.
   The "leads outdoors" bit-2 sentinel is a `CCellPortal` concept
   (`CCellPortal::UnPack`, `acclient.c:362395-362398`: `if (v5 & 4) other_cell_id = -1`).
   Measured corroboration: the building-side flags histogram over the whole world is
   `{1: 5729, 3: 11208}` — bit 2 never set. A building portal leads outdoors→indoors by
   construction; it needs no sentinel.
2. **`other_cell_id` and every `stab_list` entry are landblock-widened at unpack.** Retail
   never carries a bare u16 past the parser.

`BuildInfo` container (`acclient.h:32035-32042`):
`{ building_id, building_frame, num_leaves, num_portals, CBldPortal **portals }`.
`CLandBlockInfo::UnPack` (`acclient.c:351049`) computes the block mask at `:351144`
(`addra = cell_ids & 0xFFFF0000`) and threads it into each `CBldPortal::UnPack` at
`:351203-351207`.

### 1.2 The stab list is a RESIDENCY list, not geometry

This is the single most misreadable field name in the record. It is **not** vertex indices
and **not** static objects. It is a list of **EnvCell ids that must be loaded and
registered** whenever this landblock is resident. The chain:

1. `CLandBlock::init_buildings` (`acclient.c:352120`+) builds each `CBuildingObj`
   (`makeBuilding`, `:352155-352159`) and calls
   `CBuildingObj::add_to_stablist(bldg, &lb->stablist, &max_stab, &lb->stab_num)`
   at **`acclient.c:352176`**.
2. `CBuildingObj::add_to_stablist` (**`acclient.c:719041`**) forwards to each portal:
   `CBldPortal::add_to_stablist` (**`acclient.c:362423`**), which appends with a linear
   **dedupe** against what's already in the block list (`:362444-362459`) and grows the
   array by 10 (`:362465-362466`). The landblock owns the result:
   `CLandBlock { … unsigned int stab_num; unsigned int *stablist; … }`
   (`acclient.h:31353-31354`).
3. `CLandBlock::grab_visible_cells` (**`acclient.c:351601`**) →
   `CEnvCell::grab_visible(stab_num, stablist, this)` (**`acclient.c:350001`**) →
   per entry `CEnvCell::add_visible_cell(id)` (**`acclient.c:349824`**), which on a miss
   does `DBObj::Get(QualifiedDataID(cell_id, 3))` — **loads the EnvCell record from the
   DAT** (`:349863-349864`) — and inserts it into the global
   `CEnvCell::visible_cell_table` (`:349870-349873`), stamping the owning landblock back
   into the cell (`:350013`).
4. Release is symmetric: `CLandBlock::release_visible_cells` (`acclient.c:351607`) →
   `CEnvCell::release_visible` (`acclient.c:350021`); also called on teardown at
   `:352093` and `:352435`.

The invariant that falls out and that **everything else in this document depends on**:

> `CEnvCell::GetVisible(cell_id)` (**`acclient.c:349674`** — a lookup in
> `visible_cell_table`) returns non-null **iff** some loaded landblock's building-portal
> stab list named that cell.

And `CBldPortal::GetOtherCell(this)` is *literally* `return CEnvCell::GetVisible(this->other_cell_id);`
(**`acclient.c:362493-362496`**). So a building portal only resolves at all because the
stab list already made its target resident. `CBldPortal::PreFetchCells`
(**`acclient.c:362547`**) is the async warm of the same set — `DBObj::PreFetch` on each
stab as `QualifiedDataID(id, 3)`.

**Measured residency envelope** (probe, Appendix B): 1,497 landblocks carry a building stab
list; deduped size **p50 = 17, p90 = 122, p99 = 177, max = 277** cells. It never exceeds
`LandblockInfo.num_cells` (0 of 1,497), and averages **0.939 × num_cells** — i.e. a town
landblock's stab set names ~94 % of its interior cells. By contrast the union of
`other_cell_id` **entry** cells is only 15,028 across those landblocks versus 61,509 stab
cells — the entry set is ~24 % of the stab set. §4 Stage 4 and §5 R-4 turn on this number.

### 1.3 The physics walk (outdoor → interior transit)

```
CObjCell::find_cell_list
 └ CSortCell::find_transit_cells                          acclient.c:356093 / :356103
    └ CBuildingObj::find_building_transit_cells           acclient.c:719068 (sphere)
                                                          acclient.c:719092 (parts)
       └ for each portal:  CBldPortal::GetOtherCell        :719082 / :719106
          └ if non-null: CEnvCell::check_building_transit(cell, portal->other_portal_id, …)
                                                          :719084 / :719108
```

`CEnvCell::check_building_transit` — **sphere overload, `acclient.c:348110`**:

1. `if (portal_id < 0) return;` (`:348123`) — the only guard.
2. for each sphere: `Frame::globaltolocal(&cell->pos.frame, …, &sphere->center)`
   (`:348131`) → local sphere.
3. `CCellStruct::sphere_intersects_cell(cell->structure, &local)` (`:348139`) — the **Cell**
   BSP, not the Physics BSP.
4. on the first hit: `path->hits_interior_cell = 1` (`:348147`) and
   `CELLARRAY::add_cell(cell_array, cell->m_DID.id, cell)` (`:348148`). Return.

Note the sphere overload **never touches the portal polygon** — `portal_id` is only tested
`>= 0`. The **parts overload (`acclient.c:348154`)** is the one that uses it:

- `portals[portal_id].portal` → `CPolygon*`, `portals[portal_id].portal_side` → int
  (`:348200-348202`)
- signed plane distance of the part's sphere centre, `±(radius + 0.0002)` (`:348199`,
  `:348206-348209`)
- **sidedness reject**: `portal_side == 1` requires `d <= radius`; `portal_side == 0`
  requires `d >= -radius` (`:348210-348218`)
- `Plane::intersect_box` on the part's bbox must return `3` (straddling) or `== portal_side`
  (`:348221-348222`)
- then `CCellStruct::box_intersects_cell` (`:348225`), then add-cell + recurse into the
  cell's own `find_transit_cells` (`:348227-348232`).

`PHYSICS_EPSILON` = `0.0002` matches `crates/holtburger-dat/src/physics.rs:15` exactly.

### 1.4 The render walk (outdoor camera → interior pixels)

Entry point, per building, per frame:

```
RenderDeviceD3D::DrawBuilding(building)                    acclient.c:456933
  outdoor_pview->outdoor_portal_list = building->portals;  :456937   <<< the CBldPortal array
  CPhysicsPart::Draw(parts[0], 1) / Draw(parts[0], 0)      :456948 / :456950
    └ RenderDeviceD3D::DrawMeshInternal(gfxobj, i_bBuilding=true)      :456960
        BSPTREE::build_draw_portals_only(drawing_bsp, 1)   :456983   <<< PASS 1
        BSPTREE::build_draw_portals_only(drawing_bsp, 2)   :456984   <<< PASS 2
```

`build_draw_portals_only` walks the drawing BSP **front-to-back from the camera**:
`BSPNODE::build_draw_portals_only` (**`acclient.c:362865`**) computes the camera's signed
distance to `splitting_plane` (`:362880-362883`) with the same ±0.0002 tri-state
(`0` = positive, `1` = negative, `2` = on-plane, `:362884-362893`), recursing the near child
first. Node type is a FourCC: `1279607110` = `'LEAF'` (0x4C454146) terminates,
`1347375700` = `'PORT'` (0x504F5254) hands off to
`BSPPORTAL::portal_draw_portals_only` (**`acclient.c:364410`**). At a `PORT` node, after
the near subtree, it fires the aperture list:

```c
for (v11 = 0; v11 < i->num_portals; )
    render_device->vfptr->DrawPortal(i->in_portals[v11++], /*check=*/1, portalPolyOrPortalContents);
                                                          acclient.c:364484-364488, :364511-364515
```

`RenderDeviceD3D::DrawPortal` (`acclient.c:456850`) forwards to
**`PView::DrawPortal(pview, CPortalPoly *portal, check, portalPolyOrPortalContents)` —
`acclient.c:462565`**:

```c
v5 = v4->outdoor_portal_list[portal->portal_index];   // :462579  <<< THE JOIN
v6 = portal->portal;                                  // :462580  the CPolygon aperture
PView::add_views(v5->num_stabs, v5->stab_list);       // :462581  push a view frame on each stab cell
if ( PView::ConstructView(v4, v5, v6, check, mode) ) {
    if ( mode != 1 ) PView::DrawCells(v4, /*from_outside=*/1);   // :462584-462585
    …restore state, positionPush(CBuildingObj::curr_pos)…        // :462586-462588
} else {
    if ( mode == 3 ) D3DPolyRender::DrawPortalPolyInternal(v6, 0);  // :462592-462593
}
PView::remove_views(v5->num_stabs, v5->stab_list);    // :462596
```

Line `:462579` is the whole point of this task: **`portal_index` selects the `CBldPortal`;
`portal->portal` supplies the aperture geometry.** F2 proves that index is `0..n-1` into
`BuildInfo.portals[]`, world-wide.

`PView::add_views` (**`acclient.c:462070`**) = for each stab id, `CEnvCell::GetVisible(id)`
then `CEnvCell::curr_view_push(cell)`; `remove_views` (**`acclient.c:461029`**) pops. So the
stab list is *also* the per-portal view-stack scope — a second reason the whole set (not
just entry cells) must be resident.

`PView::ConstructView(PView*, CBldPortal *outside_portal, CPolygon *ppoly, check, mode)` —
**`acclient.c:462507`**, the outdoor seed:

1. `d = N·camera + plane.d` for the aperture plane (`:462519-462522`).
2. Sidedness tri-state, ±0.0002: `d > +eps → 0`, `|d| ≤ eps → 2`, `d < -eps → 1`
   (`:462523-462532`).
3. **Sidedness gate** (`:462533-462541`): `portal_side` set ⇒ require side `== 1`;
   `portal_side` clear ⇒ require side `== 0`. On-plane (`2`) always rejects.
4. `PView::GetClip(side, ppoly, clip_view_0, &clip_pts, check)` (`:462542`,
   def `acclient.c:461052`) — projects the aperture to screen and clips; empty ⇒ reject.
5. `CEnvCell::GetVisible(outside_portal->other_cell_id)` (`:462545`) — **null ⇒ reject.**
   This is where a missing stab-list residency silently kills the whole portal.
6. `Render::copy_view(cell's top portal_view, clip_view_0, clip_pts)` (`:462548-462553`) —
   push the clipped view onto the target cell; fail ⇒ reject.
7. `if (mode != 2) D3DPolyRender::DrawPortalPolyInternal(ppoly, mode == 1)` (`:462556-462557`)
   — **the depth punch**.
8. `if (mode != 1) PView::ConstructView(pview, cell, other_portal_id)` (`:462559-462560`) —
   recurse into the *cell* overload.

The cell overload, **`PView::ConstructView(PView*, CEnvCell*, u16 portal_in)` —
`acclient.c:462423`** — is the interior flood:

```
outside_view.view_count = 0;  ++master_timestamp;  cell_todo_num = 0;  cell_draw_num = 0;   :462435-462438
PView::InitCell(cell, portal_in);          :462439   (def :461625 — per-portal inflag/seen, max_indist)
PView::InsCellTodoList(pview, cell, 0.0);  :462440   (distance-sorted todo)
while (cell_todo_num) {
    pop nearest;  append to cell_draw_list;  mark cell_view_done;      :462443-462459
    if (PView::ClipPortals(pview, cell, 0))   PView::AddViewToPortals(pview, cell);  :462460-462461
}
```

`ClipPortals` (`acclient.c:462250`) + `OtherPortalClip` (`acclient.c:462206`, which flips
sidedness on the *far* cell's matching portal: `side = other_portal.portal_side == 0`,
`:462239`) + `AddViewToPortals` (`acclient.c:462132`, which calls `InitCell`/`AddToCell` on
each newly-visible neighbour and `SetOtherSeen` at `:462190`) constitute the screen-space
portal clip. **holtburger already ports this** as
`SpatialScene::compute_visibility_with_pview` (`crates/holtburger-world/src/spatial/scene.rs:3130`)
— see §3.3. What is missing is the *outdoor seed* (`ConstructView(CBldPortal*, ppoly, …)`),
not the walk.

### 1.5 `PView::DrawCells` and the terrain punch, exactly

**`PView::DrawCells(PView *this, int from_outside)` — `acclient.c:461450`**:

```
if (outside_view.view_count) {                                   :461476
    Render::useSunlightSet(1);                                   :461478
    Render::PortalList = pview;                                  :461479
    LScape::draw(pview->lscape);                                 :461480   <<< TERRAIN, clipped to the portal view
    D3DPolyRender::FlushAlphaList(0.0);                          :461481
    ++render_device->m_nFrameStamp;                              :461482
    if (forceClear || portalsDrawnCount != 0)                    :461483   (reads AND zeroes the counter)
        render_device->Clear(4, &stru_820FC0, /*z=*/1.0f);       :461484-461487   <<< DEPTH CLEAR
    for (cell in cell_draw_list, index cell_draw_num-1 .. 0)     :461488-461502   (REVERSE = far→near)
        if (cell->structure->drawing_bsp) {
            SetCurrentMaterial(0,0); SetSurfaceArray(cell->surfaces); positionPush(cell->pos);
            for (v = 0; v < view_count; ++v) {
                CEnvCell::setup_view(cell, v);                   :461529
                for (p in cell->portals)                         :461531-461542
                    if (p.other_cell_id == -1)                   :461537   <<< the 0xFFFFFFFF outdoor sentinel
                        D3DPolyRender::DrawPortalPolyInternal(p.portal, /*zClear=*/0);   :461538
            }
        }
}
Render::useSunlightSet(0); Render::restore_all_lighting();       :461554-461555
/* phase 2 */ for (cell in cell_draw_list reverse) for each view: setup_view + DrawEnvCell(cell)   :461556-461603
/* phase 3 */ for (cell) { Render::PortalList = cell top view; DrawObjCellForDummies(cell); }      :461605-461610
```

**`D3DPolyRender::DrawPortalPolyInternal(CPolygon *p, bool zClear)` —
`acclient.c:453882`**, the punch primitive:

| behaviour | value | anchor |
|---|---|---|
| far-Z selector | `v2 = zClear ? maxZ1 : maxZ2`; `maxZ1 = 7`, `maxZ2 = 6` | `:453908-453910`; `acclient.c:45770-45771` |
| **landblock-boundary reject** | drop the poly if *every* vertex has `x == 12.0`, or all `x == -12.0`, or all `y == 12.0`, or all `y == -12.0` | `:453921-453932` |
| counter | `if (!zClear) ++D3DPolyRender::portalsDrawnCount` | `:453934-453935` |
| screen clip | `ACRender::polyClipFinish(...)`, require `clip_pts >= 3` | `:453941-453942` |
| state | no texture, alpha-test OFF, blend `SRCALPHA/INVSRCALPHA`, `CULLMODE_NONE` | `:453944-453950`, `:453959` |
| depth | `SetDepthBufferMode(DEPTHTEST_ALWAYS, (v2 >> 2) & 1)` — test ALWAYS, **write enabled for both maxZ values** | `:453951-453954` |
| **the Z written** | `v12 = v2 & 1`; `v12 ? z = 0.99999899 : z = zw/w` — i.e. `zClear=true` ⇒ **constant far depth**; `zClear=false` ⇒ the polygon's real projected depth | `:454006`, `:454015-454019` |
| primitive | `DrawPrimitiveUP(D3DPT_TRIANGLEFAN, clip_pts - 2, …)` | `:454031` |

So there are **two distinct punches** with different semantics, and holtburger has ported
only the second one's *feed*:

- **(a) Building-aperture far-Z punch.** `ConstructView` at `:462557` with
  `zClear = (mode == 1)`. Pass 1 (`build_draw_portals_only(bsp, 1)`, `acclient.c:456983`)
  runs `mode == 1` ⇒ `zClear = true` ⇒ **z = 0.99999899, DEPTHTEST_ALWAYS, depth write on**.
  Mode 1 also skips both the cell recursion (`:462559`) and `DrawCells` (`:462584`) — it is
  a *pure depth pass over every building aperture*. Pass 2 (`…(bsp, 2)`,
  `acclient.c:456984`) is `mode == 2` ⇒ no poly drawn (`:462556`), recursion + `DrawCells`
  ⇒ the interior contents. **This is the mechanism that clears terrain depth over a doorway
  or an open-top courtyard, and holtburger has never fed it.**
- **(b) Cell outdoor-sentinel real-depth punch.** `DrawCells` at `:461538` with
  `zClear = 0` ⇒ real projected depth, and it *increments* `portalsDrawnCount`, which is
  what arms the next `Clear` at `:461483`. holtburger's `getVisiblePortalApertures`
  (`lib.rs:35453-35457`, filter `(*to & 0xFFFF) >= 0xFFFE`) feeds precisely this set.

`isLandCellBoundaryPoly` (`apps/holtburger-web/scene3d/portal_clip.js:223`) is already the
port of the `±12.0` reject at `:453921-453932` — it will apply unchanged to the building
aperture feed.

### 1.6 Traversal order and culling tests, consolidated

| # | test | retail anchor | holtburger today |
|---|---|---|---|
| 1 | BSP front-to-back walk, ±0.0002 tri-state on the splitting plane | `acclient.c:362880-362893` | absent (no drawing-BSP walk) |
| 2 | `portal_index` → `CBldPortal` join | `acclient.c:462579` | **absent — the task** |
| 3 | stab-list view push / pop around the portal | `acclient.c:462581`, `:462596` | absent |
| 4 | aperture-plane sidedness vs `portal_side`, on-plane rejects | `acclient.c:462533-462541` | `apertureFacesAway` (`portal_clip.js:559`), cell-centre heuristic, `?punchSidedness` **off** |
| 5 | screen-space clip of the aperture, `clip_pts >= 3` | `acclient.c:462542`, `:453941-453942` | `clipAperturesForPunch` (`portal_clip.js:666`) |
| 6 | target cell must be `GetVisible` (resident) | `acclient.c:462545` | implicit — cell must be in `cell_aabbs` |
| 7 | view copy onto the target cell must succeed | `acclient.c:462548-462553` | `compute_visibility_with_pview` clip (`scene.rs:3176-3180`) |
| 8 | landblock-boundary ±12.0 poly reject | `acclient.c:453921-453932` | `isLandCellBoundaryPoly` (`portal_clip.js:223`) |
| 9 | far-Z 0.99999899 punch, `DEPTHTEST_ALWAYS` + depth write | `acclient.c:453951-453954`, `:454015-454019` | `portal_punch.js` (equivalent), fed from cell portals only |
| 10 | cells drawn far→near from `cell_draw_list` | `acclient.c:461488-461502`, `:461556-461603` | JS render order |

---

## 2. ACE CROSS-REF

ACE is a **server**; it carries the data model and the physics consumer, and has **no**
render consumer. That is expected and is stated here so a future agent does not go looking
for a `PView` in C#.

| retail | ACE | verdict |
|---|---|---|
| `CBldPortal` fields | `BldPortal.cs:6-27` — `PortalFlags Flags; bool ExactMatch; bool PortalSide; ushort OtherCellId; ushort OtherPortalId; List<ushort> StabList;` (`external/ACE/Source/ACE.Server/Physics/Common/BldPortal.cs`) | field-for-field match. **Note ACE keeps `OtherCellId`/`StabList` as bare `ushort`** and re-widens at use: `GetOtherCell` does `landblockID & 0xFFFF0000 \| OtherCellId` (`BldPortal.cs:29-34`) — retail widens at unpack instead (`acclient.c:362520`, `:362537`). Same result, different moment. |
| `CBuildingObj` | `BuildingObj.cs:11-15` — `List<EnvCell> BuildingCells; List<BldPortal> Portals; List<PartCell> LeafCells; List<ShadowPart> ShadowList; uint NumLeaves;` | matches `acclient.h` (`CBuildingObj::num_portals/portals/num_leaves/leaf_cells/shadow_list`, ctor `acclient.c:719133`) |
| `makeBuilding` | `BuildingObj.cs:106-128` | matches `acclient.c:719153` |
| transit | `BuildingObj.cs:54-62` / `:64-72` → `SortCell.cs:33-43` | matches `acclient.c:719068` / `:719092` / `:356093` |
| `check_building_transit` | `EnvCell.cs:128-192` — uses `CellStructure.Portals[portalId]`, `portal.PortalSide` | matches `acclient.c:348154` |
| stab accumulation | `Landblock.cs:433-456` `init_buildings` → `building.add_to_stablist(ref StabList, ref maxSize, ref stabNum)`; `BldPortal.add_to_stablist` at `BldPortal.cs:36-61` | matches `acclient.c:352176` / `:719041` / `:362423`. **ACE's dedupe loop is subtly different** (`if (j > 0)` admits, `BldPortal.cs:47`) — retail admits when the scan *fails* to find a duplicate (`v6 = (v5 == 0)`, `acclient.c:362458-362460`). Follow **retail**; ACE's variant reads like a port bug. It does not matter for BLDPORTAL-CONSUME because the consumer should dedupe with a `HashSet` anyway. |
| flags enum | `ACE.Entity/Enum/PortalFlags.cs:6-10` — `ExactMatch = 0x1, PortalSide = 0x2` | matches. Neither ACE nor retail defines a bit-2 name on the **building** side; bit 2 exists only in `CCellPortal::UnPack` (`acclient.c:362395`). |
| wire schema | `external/DatReaderWriter/DatReaderWriter/dats.xml:2588-2595` `BuildingPortal` = `Flags, OtherCellId, OtherPortalId, _numStabs, StabList[ushort], <align type="uint"/>`; `:2581-2587` `BuildingInfo` = `ModelId, Frame, NumLeaves, _numPortals(uint), Portals[]`; `:4192-4208` `LandBlockInfo` | matches `acclient.c:362499` byte for byte, including the u32 portal count and the 4-byte align |
| render consumer | **none** | ACE has no `PView`, `DrawCells`, `ConstructView`, or `DrawPortalPolyInternal`. Searched; absent. All render semantics in §1.4–§1.5 are decomp-only. |

`EnvCellFlags` (`ACE.Entity/Enum/EnvCellFlags.cs:6-11`, `dats.xml:222-226`):
`SeenOutside = 0x1, HasStaticObjs = 0x2, HasRestrictionObj = 0x8` — relevant because
`CObjCell::num_stabs / stab_list` (`acclient.h:30927-30928`) on an **EnvCell** is read under
`pack_bitfield & 2` (`acclient.c:349300-349318`) and pairs each id with a 64-byte `Frame`
(`:349319`) — i.e. that field is the cell's **static objects**, a completely different thing
from `CBldPortal::stab_list`. See §5 R-7 for the one loose end here.

---

## 3. CURRENT-CODE AUDIT

All line numbers below were opened and read on 2026-08-11 against branch `fanout-D-a5`
(base `2946486d`). Where the queue card's citation drifted, the corrected anchor is marked
**[was: …]**.

### 3.1 `crates/holtburger-dat/src/landblock.rs` — parse is complete, consumption is zero

```rust
// landblock.rs:20-35
pub struct BuildInfo {
    pub model_id: u32,
    pub frame: Frame,
    pub num_leaves: u32,
    #[br(temp)] pub num_portals: u32,          // u32 — matches dats.xml:2585
    #[br(count = num_portals)] pub portals: Vec<PortalInternal>,
}

// landblock.rs:37-50                      [was: "landblock.rs:40-49" in the queue card]
pub struct PortalInternal {
    pub flags: u16,
    pub other_cell_id: u16,
    pub other_portal_id: u16,
    #[br(temp)] pub num_stabs: u16,
    #[br(count = num_stabs)] pub stab_list: Vec<u16>,        // <<< landblock.rs:47
    #[br(pad_after = (4 - ((8 + num_stabs as u64 * 2) % 4)) % 4)] pub _align: (),
}
```

`LandblockInfo` at `landblock.rs:160-177` (`id, num_cells, objects, num_buildings(u16),
pack_mask(u16), buildings, restriction_tables`).

**`stab_list` IS retained** — the queue card's "keep stab_list" instruction is already
satisfied at the parser. The drop is downstream. Repo-wide `rg -n "stab_list"` over
non-`target`/`pkg` paths returns exactly one code hit outside docs: `landblock.rs:47` itself.
`PortalInternal` and `BuildInfo` have **no** consumer that reads `.portals`.

Two fidelity gaps versus §1.1 for the consumer to close (neither is a parser bug — the
parser is wire-correct):

- `other_cell_id` and `stab_list[i]` are bare `u16`; retail widens with `block_mask` at
  unpack. The consumer must `landblock_high | (x as u32)`.
- `flags` is never decoded. `exact_match = flags & 1`;
  `portal_side = ((!flags) >> 1) & 1` (verify against `acclient.c:362517`). Measured world
  histogram `{1 → portal_side 1 (5,729), 3 → portal_side 0 (11,208)}` — **both arms are
  live data**, this is not a constant.

### 3.2 `apps/holtburger-web/src/lib.rs` — the exact drop site

`populate_building_aabbs_for_landblock_impl` at **`lib.rs:17759`**
(wasm export `populateBuildingAabbsForLandblock` at `lib.rs:18151`).
**[was: "~:17802-17870"; 17802 is `if info.buildings.is_empty()`, the real loop starts at
17829.]**

- `lib.rs:17796` — `LandblockInfo::unpack(&info_bytes)`; `portals` are in memory here.
- `lib.rs:17811-17815` — prefetches one Setup key per building from `b.model_id`.
- **`lib.rs:17829`** — `for (sequence, build_info) in info.buildings.iter().enumerate()`.
  The body reads `build_info.model_id` (`:17830`), `build_info.frame.origin` (`:17832-17834`),
  `build_info.frame.orientation` (`:17836`). **`build_info.portals` is never touched.**
  That is the drop site, in one line: the loop simply never mentions the field.
- `lib.rs:17861-17862` — dispatch on `(model_id >> 24) as u8`; `0x01` reads the GfxObj
  directly (`:17873-17878`) — **this is where `gfx.drawing_bsp` is already in hand** and
  F2 says every portal-bearing building takes this arm (5,464 / 5,464 are `0x01`).

The EnvCell side, by contrast, is fully wired:

- **`lib.rs:21401-21409`** — `portal_cell_ids`, widening `portal.other_cell_id` with
  `landblock_high`. ✅ verified verbatim.
- **`lib.rs:21456-21461`** — direct `CellPortal` edges into `CELL_GRAPH_PENDING.portals`.
- **`lib.rs:21484-21490`** — `visible_cells[]` PVS edges into the *same* vector. This merge
  is exactly what a3's `PORTAL-GRAPH-SPLIT` is splitting.
- The in-code comment at **`lib.rs:21479-21483`** already names this task's gap:
  *"Does NOT fix the LandCell↔EnvCell gap — outdoor cells still have no edges, so from
  outside a cottage BFS-1 still returns `{current_cell}` only."*
- **`lib.rs:21663-21723`** — portal **polygons**: resolves `cell_struct.polygons[portal.polygon_id]`,
  transforms to world space, pushes `CellPortalPolygon { other_cell_id, vertices }`.
  This is the template the building-aperture resolver should copy.
- Exports: `getVisiblePortalApertures` **`lib.rs:35421`**,
  `getVisiblePortalAperturesWithCellCenter` **`lib.rs:35499`**. Selection in both is
  `(*to & 0xFFFF) >= 0xFFFE` over `snap.cell_portal_polygons` (`lib.rs:35453-35457`) plus a
  frustum test on the owning cell's AABB (`:35463-35466`). **No building apertures can ever
  appear in this feed.**

### 3.3 `crates/holtburger-world/src/spatial/scene.rs` — the heuristic to replace

`compute_visibility_with_frustum` at **`scene.rs:3033-3103`**; the outdoor branch is
`scene.rs:3061-3101` and the AABB heuristic proper is **`scene.rs:3086-3100`**
**[queue card said `~:3086-3100` — exact]**:

```rust
} else {
    // Outdoor path: frustum-cull every loaded EnvCell AABB.
    for (&cell, aabb) in self.cell_aabbs.iter() {              // 3086
        if !frustum.intersects_aabb(aabb) { continue; }        // 3087-3089
        let has_outdoor_exit = self.cell_portal_graph
            .get(&cell)
            .map(|edges| edges.iter().any(|&n| (n & 0xFFFF) >= 0xFFFE))
            .unwrap_or(false);                                 // 3090-3096
        if has_outdoor_exit { visible.insert(cell); }          // 3097-3099
    }
}
```

Two independent defects, both fixed by the retail walk:

- **No portal is consulted.** Any EnvCell whose *AABB* meets the frustum and which merely
  *has* an outdoor-sentinel edge somewhere is declared visible — regardless of whether any
  aperture actually faces the camera, is on-screen, or is occluded. This is what
  `laptopIgpuFindings` measured as *"37/116 visible"* at Yaraq.
- **It is a whole-world scan.** `self.cell_aabbs.iter()` iterates every loaded EnvCell every
  call. The retail walk is O(buildings in frustum × their portals), which is far smaller.

Supporting surface, all verified this session:

| symbol | line | note |
|---|---|---|
| `EXIT_INDOOR_BFS_MAX_CELLS = 64` | `scene.rs:362` | a3 fixes the PVS-closure overflow |
| `cell_portal_graph: Arc<HashMap<u32, Vec<u32>>>` | `scene.rs:676` | a3 splits this |
| `cell_portal_polygons: Arc<HashMap<u32, Vec<CellPortalPolygon>>>` | `scene.rs:780` | sibling index for building polys |
| `insert_building_aabb` / `clear_building_aabbs_for_landblock` | `scene.rs:1476` / `:1487` | the eviction pattern to mirror |
| `insert_cell_portal` | `scene.rs:1747` | dedupes on insert |
| `insert_cell_portal_polygon` | `scene.rs:1839` | template for the building variant |
| `current_cell` | `scene.rs:2502` | a3 moves to adjacency |
| `cell_has_outdoor_exit` | `scene.rs:2784` | a3 moves to adjacency |
| `at_interior_doorway` | `scene.rs:2815` | a3 moves to adjacency |
| `exited_envcell_to_outdoor` | `scene.rs:2881` (cap at `:2957`) | a3 moves to adjacency |
| `render_set` | `scene.rs:2984` | stays on the union |
| `compute_visibility_with_pview` | `scene.rs:3130` | **the ported interior walk — reuse it** |
| `clear_cells_for_landblock` sweep incl. polygons | `scene.rs:3720` | add the building index here |
| `clip_segment_to_cell_space` | `scene.rs:3991` | a3 moves to adjacency |
| `CellPortalPolygon { other_cell_id, vertices }` | `crates/holtburger-world/src/spatial/types.rs:66-69` | a4 adds `portal_side` here |

`compute_visibility_with_pview` (`scene.rs:3130-3190`) is a faithful port of
`ConstructView(cell)` / `ClipPortals` / `AddViewToPortals` — NDC view-poly, Sutherland-style
`pview_clip_polygon_against_polygon`, `max_depth` cap, sentinel skip at `:3162`. **BLDPORTAL-CONSUME
does not rewrite it; it seeds it from outdoors.**

### 3.4 Test suites that pin these seams (baseline measured this session)

```
cargo test -p holtburger-world   →  674 passed; 0 failed; 0 ignored          GREEN
cargo test -p holtburger-dat     →  689 passed; 1 failed; 0 ignored          PRE-EXISTING RED
      failure: terrain_subdiv::tests::triangle_corner_ring_matches_height_sampler
      (crates/holtburger-dat/src/terrain_subdiv.rs:1787 — "cut=false (0.6,0.4) not inside
       its own ring [0, 1, 2]"). Unrelated to portals. Do not chase it; do not let it
       mask a real regression — diff the failure LIST, not the count.
```

Named pins in `crates/holtburger-world/src/spatial/tests.rs` (132 `#[test]` in that file):

| test | line | what it locks |
|---|---|---|
| `compute_visibility_with_frustum_outdoor_filters_to_outdoor_exit_cells` | `tests.rs:1863` | **the heuristic being replaced — this test must be rewritten, not deleted** |
| `compute_visibility_with_frustum_indoor_does_not_apply_outdoor_filter` | `tests.rs:1948` | indoor arm must stay byte-identical |
| `render_set_bfs_three_cell_chain` | `tests.rs:1827` | BFS over the union graph |
| `cell_has_outdoor_exit_detects_sentinel` | `tests.rs:3087` | sentinel semantics (a3 territory) |
| `at_interior_doorway_requires_loaded_near_neighbour` | `tests.rs:1213` | doorway geometry gate |

Wedge suites that exercise real cell data and will catch collateral damage:
`env840_seam_tests.rs` (7), `academy_wedge_tests.rs` (3), `townnetwork_wedge_tests.rs` (3),
`faithful_bridge.rs` (55), `physics.rs` (44).

### 3.5 Build environment — read this before you start

The fanout worktrees ship `external/chorizite/` containing **only** `VENDORED.md`; the
vendored Chorizite clones are gitignored (`.gitignore:630`, `external/*`) and live solely in
`/home/wbterminal/WorldBuilder-ACME-Edition/external/chorizite/`. Consequence: a bare
`cargo test -p holtburger-world` in a fresh worktree **fails at build time**, not test time:

```
error: failed to run custom build command for `holtburger-protocol`
  panicked at crates/holtburger-protocol/build.rs:40:29:
  Failed to canonicalize .../external/chorizite/Chorizite.ACProtocol/.../protocol.xml
```

Repair (untracked, gitignored, nothing to commit):

```sh
cd <worktree>/external/chorizite
for d in ACBindings ACPlugin Chorizite Chorizite.ACProtocol Chorizite.Common \
         DatReaderWriter.Extensions RmlUiPlugin; do
  [ -e "$d" ] || ln -s "/home/wbterminal/WorldBuilder-ACME-Edition/external/chorizite/$d" "$d"
done
```

Toolchain: bare `cargo` resolves to `/opt/cargo/bin/cargo` and hits *"no rustup default"*.
Build with the explicit prefix (`CARGO_TARGET_DIR` is already exported — leave it):

```sh
env PATH="/opt/rust/toolchains/1.95.0-x86_64-unknown-linux-gnu/bin:/usr/local/bin:/usr/bin:/bin" \
    cargo test -p holtburger-world
```

---

## 4. STAGED IMPLEMENTATION PLAN

Five stages, each independently bisectable and independently revertible. Stage ordering
follows the queue card (*keep stab lists → edges index → retail walk swap*) with one
deviation called out at Stage 3.

Prereq assumption for every stage: **a3 and a4 have landed.** Concretely that means
(a) `SpatialScene` carries `cell_adjacency` (direct/walkable portal edges) *beside*
`cell_portal_graph` (the union incl. PVS), with `current_cell` /
`clip_segment_to_cell_space` / `exited_envcell_to_outdoor` / `at_interior_doorway` /
`cell_has_outdoor_exit` reading adjacency only and `render_set` / `compute_visibility*`
reading the union; and (b) `CellPortal.flags` is decoded and `CellPortalPolygon` carries a
real `portal_side`. If either is not in, **stop and re-plan** — Stage 3 in particular
consumes a4's sidedness field.

### Stage 0 — retain and index the building-portal data (inert, no flag)

*Nothing reads the new data; the OFF arm is the only arm.* Per I7 a flag guards new
*behaviour*; this stage has none. Land it unflagged so Stages 1–4 have a stable substrate.

- `crates/holtburger-dat/src/landblock.rs`: add `impl PortalInternal` decode helpers —
  `exact_match(&self) -> bool` (`flags & 1`), `portal_side(&self) -> bool`
  (`((!self.flags) >> 1) & 1 != 0`), `other_cell(&self, lb_high: u32) -> u32`,
  `stab_cells(&self, lb_high: u32) -> impl Iterator<Item = u32>`. Doc-anchor each to
  `acclient.c:362516`, `:362517`, `:362520`, `:362537`.
- `crates/holtburger-world/src/spatial/types.rs`: add
  `BuildingPortal { building_id: BuildingId, portal_index: u16, other_cell_id: u32,
  other_portal_id: u16, exact_match: bool, portal_side: bool, stab_cells: Vec<u32> }`.
- `crates/holtburger-world/src/spatial/scene.rs`: add
  `building_portals: Arc<HashMap<u32 /*outdoor landcell id*/, Vec<BuildingPortal>>>`
  beside `cell_portal_polygons` (`scene.rs:780`), with `insert_building_portal` modelled on
  `insert_cell_portal_polygon` (`scene.rs:1839`) and eviction wired into
  `clear_cells_for_landblock` (`scene.rs:3720`) **and** the building path
  (`clear_building_aabbs_for_landblock`, `scene.rs:1487`).
- `apps/holtburger-web/src/lib.rs:17829`: inside the existing loop, for each
  `build_info.portals[i]`, push a `BuildingPortal` into the pending pile alongside the
  existing `BUILDING_ORIGIN_PENDING` push at `:17844`. Key on the outdoor landcell the
  building already resolves to via `outdoor_cells_for_world_aabb`.

Tests: unit tests on the decode helpers using the F2 sample (`flags=0x0001 → side=1`,
`flags=0x0003 → side=0`); a scene test that insert + `clear_cells_for_landblock` leaves the
index empty. `cargo test -p holtburger-dat`, `-p holtburger-world`.
Rollback: revert; nothing consumed it.

### Stage 1 — resolve building aperture polygons (inert, no flag)

- New `crates/holtburger-dat/src/physics.rs` helper
  `collect_portal_polys(bsp: &BspNode, out: &mut Vec<PortalPoly>)` — recursive walk
  emitting `BspPortal.portal_polys` (port of `BSPNODE::build_draw_portals_only`
  `acclient.c:362865` / `BSPPORTAL::portal_draw_portals_only` `acclient.c:364410`, minus the
  camera-order logic, which belongs on the consumer side).
- `apps/holtburger-web/src/lib.rs:17873-17878` (the `0x01` arm, which F2 proves is the only
  arm that matters): the `GfxObj` is already unpacked. Walk `gfx.drawing_bsp`, resolve each
  `poly_id` in `gfx.polygons`, transform vertices by the placement frame exactly as the
  AABB path does (`lib.rs:17831-17836`), and attach the world-space polygon to the matching
  `BuildingPortal` via `portal_index`.
- **Assert the F2 invariant loudly, do not assume it.** If
  `portal_polys.len() != build_info.portals.len()` or `portal_index` is out of range,
  count it (`__diag` counter `bldPortalIndexMismatch`) and skip that building. F2 says the
  count is 0 across the retail world; a counter that stays 0 is cheap proof the assumption
  still holds on whatever DAT the user is running.
- New wasm export `getBuildingPortalApertures(mvp, maxDepth) -> Vec<f32>`, wire shape
  mirroring `getVisiblePortalAperturesWithCellCenter` (`lib.rs:35499`) plus `portal_side`
  and `other_cell_id`. **Additive under a new name** — a stale `pkg/` simply lacks it and
  the JS `typeof` guard falls back, per the precedent documented at `lib.rs:35493-35496`.

Tests: an `#[ignore]`d real-DAT test in `holtburger-dat` that is Appendix B's probe promoted
verbatim, asserting the six invariants (run `-- --ignored`; DATs at `~/ac_base_dats/`); a
fixture test for the BSP walk. Rollback: revert; the export is additive and unconsumed.

### Stage 2 — `?bldPortals` — replace the outdoor AABB heuristic with the retail walk

**Flag `?bldPortals`, DEFAULT OFF.** OFF = `scene.rs:3086-3100` byte-identical.

Replace the outdoor branch of `compute_visibility_with_frustum` (`scene.rs:3061-3101`) with
the port of `PView::DrawPortal` → `ConstructView(CBldPortal*)`:

```
for each building portal in `building_portals` for the landcells under the frustum:
    (1) aperture-plane sidedness vs portal.portal_side, ±0.0002, on-plane rejects
                                                            [acclient.c:462523-462541]
    (2) reject landblock-boundary polys (all-x==±12 / all-y==±12)   [acclient.c:453921-453932]
    (3) screen-space clip against the NDC viewport, require >= 3 pts [acclient.c:462542]
    (4) require the target cell resident (cell_aabbs / GetVisible analogue) [acclient.c:462545]
    (5) seed compute_visibility_with_pview(other_cell_id, clipped_view, depth)
                                                            [acclient.c:462559-462560]
```

Steps 1–3 already exist in JS (`portal_clip.js:559`, `:223`, `:666`) and step 5 already
exists in Rust (`scene.rs:3130`). The work is joining them, not writing them. Prefer the
Rust side so the physics/camera consumers see the same set; if the clip must stay in JS for
Stage 3's sake, keep **one** implementation and call it from both.

Consequences to handle deliberately:

- Building portals are genuine transit edges (`acclient.c:719084`), so the outdoor→interior
  edge belongs in **a3's `cell_adjacency`** as well as the union graph. Add it in both.
  Verify `cell_has_outdoor_exit` (`scene.rs:2784`) and `exited_envcell_to_outdoor`
  (`scene.rs:2881`) still behave — the reverse (interior→`0xFFFF` sentinel) edge is
  untouched, but the BFS now has more to walk and a3's raised
  `EXIT_INDOOR_BFS_MAX_CELLS` cap becomes load-bearing.
- Rewrite `tests.rs:1863` (`compute_visibility_with_frustum_outdoor_filters_to_outdoor_exit_cells`)
  to assert the *new* contract, keeping the old assertion under the OFF arm.
  `tests.rs:1948` (indoor) must pass unchanged.

Tests: `cargo test -p holtburger-world` (674 baseline); new outdoor-walk unit tests seeded
from the Yaraq LB 0x7D64 fixture; a real-DAT differ asserting the walk's visible set for a
known outdoor vantage is a **subset** of the old heuristic's set (the retail walk is
strictly more selective — a superset means a bug).
Rollback: `?bldPortals=off` restores the heuristic exactly; the Stage-0/1 indexes stay
inert.

### Stage 3 — `?bldPunch` — feed building apertures to the depth punch (**the Yaraq fix**)

**Flag `?bldPunch`, DEFAULT OFF.** OFF = today's `getVisiblePortalApertures` feed, unchanged.

**Deviation from the card's ordering, deliberate:** Stage 3 depends only on Stage 1, not on
Stage 2. It is the owner-priority bug. **Land it immediately after Stage 1 and before
Stage 2** unless the orchestrator says otherwise — it is a strictly additive feed into an
existing, already-live pass, and it is the smallest change that can close the Yaraq spot.

- `apps/holtburger-web/scene3d/cells.js` `tickPortalPunch` (diag stamped at
  `cells.js:2602` and `:2729`): when `?bldPunch` is on, union
  `getBuildingPortalApertures(...)` into the aperture list before
  `clipAperturesForPunch` (`portal_clip.js:666`).
- Building apertures carry a **real** `portal_side` from the DAT, so they use retail's
  sidedness gate (`acclient.c:462533-462541`) directly and **must not** route through the
  cell-centre heuristic `apertureFacesAway` (`portal_clip.js:559`) that `?punchSidedness`
  parks. Keep the two paths separate; do not let `?bldPunch` resurrect `?punchSidedness`.
- Retail's building-aperture punch is the `zClear = true` far-Z arm
  (`acclient.c:462557` with `mode == 1`, → `z = 0.99999899`, `DEPTHTEST_ALWAYS`,
  `acclient.c:454015-454019`). Confirm `portal_punch.js` writes the far constant, not the
  polygon's own depth — the cell-portal arm it was built for is the *other* (`zClear = 0`)
  case (`acclient.c:461538`).
- Count everything separately: `bldOffered`, `bldKept`, `bldDropped.{boundary,near,project,
  oversize,terrainLos,sidedness}` — do not merge with the existing cell-portal counters, or
  the A/B becomes unreadable.

Tests: new node harness suite under `apps/holtburger-web/harness/` on the aperture wire
format + the sidedness gate against the F2 sample (`flags=1` and `flags=3` both present in
LB 0x7D64, so one fixture covers both arms); `test_cell_fusion.mjs` and the punch-adjacent
suites must stay green. Requires `wasm-pack build --target web --out-dir pkg --dev` from
`apps/holtburger-web/` for the JS side (never commit `pkg/`).
Rollback: `?bldPunch=off`.

### Stage 4 — `?bldStabPrefetch` — stab-list residency

**Flag `?bldStabPrefetch`, DEFAULT OFF.** This is the retail `grab_visible` contract
(`acclient.c:351601` → `:350001` → `:349824`) and it is what makes step (4) of Stage 2 —
"target cell resident" — reliably true instead of racy.

**Do not land it as an unbounded grab.** Measured (§1.2): p90 = 122, max = 277 cells, mean
0.939 × `num_cells`. A naive port makes ~94 % of a town landblock's interiors resident on
load. Instead:

- Seed the *entry* cells (`other_cell_id`, ~24 % of the stab set) eagerly — they are what
  Stage 2 step (4) actually needs.
- Feed the remaining stab cells to the **existing** `?envcellRing` prefetch as a *hint*,
  under its budget, not as a hard requirement.
- Release on landblock evict, mirroring `release_visible` (`acclient.c:350021`) and the
  existing `clear_building_aabbs_for_landblock` sweep (`scene.rs:1487`).

Tests: assert the entry set ⊆ stab set invariant (F2: 5,464/5,464 — a cheap, strong
regression pin); assert eviction leaves zero residents; watch `sealedPark`
(`?sealedParkBudgetMb`, default 64) does not blow its cap.
Rollback: `?bldStabPrefetch=off`.

### Flag rows (I7 — add YOUR rows to `docs/url-flags.md`, touch no others)

Table header is `| Flag | Values | Default | Reader (semantics when absent) | Effect | Where |`
(`docs/url-flags.md:197`). Three rows, all `**off**`, all `=== "on"` opt-in, placed next to
the existing `portalStencil` / `portalPunch` / `punchLosSunken` / `punchSidedness` block
(`url-flags.md:256-259`). Do not touch those four rows.

### Acceptance / eyetest recipe (1070 — SwiftShader cannot render the punch)

Straight from `PORTAL-P0-VALIDATE`'s recipe A and its `laptopIgpuFindings2026-08-10`:

```
?nosw=1&autoLogin=1&autoSpawn=first&agent=1
@telepoi Yaraq              → lands at LB 0x7D64 (world-folded base 24000,19200)
stand OUTSIDE the blacksmith (Buray ibn Tamsa); interior cell 0x7D640100,
   local (87.8, 111.8, 12.005);  @teleloc 0x7D640100 87.8 111.8 12.005 works headless
A/B:  &bldPunch=on   vs  &bldPunch=off
ASSERT  liveScene3d._portalPunchDiag.bldOffered > 0
ASSERT  the aperture for GfxObj 0x01000E40 portal_index 3 is among the KEPT set
ASSERT  ON arm has strictly LOWER dropped.terrain than OFF
EYE     the grass patch over the sunken smithy courtyard is GONE
```

`__cam.set` takes AC-world **folded** metres — LB-local coords put the camera in the void.
Freecam park does not disarm the punch (verified post-`b97b9ee1`).

**All prior punch eye-verdicts from before commit `b97b9ee1` are void** — `tickPortalPunch`
read `hasV2` from `tickPortalStencil`'s scope and threw every frame into a bare `catch`, so
the pass never fed. Do not treat any older screenshot as a baseline.

---

## 5. RISK REGISTER

**R-1 — Stale stab lists vs DAT truth. Retired.** The concern that authored stab lists might
disagree with the cell graph does not survive measurement: entry cells ⊆ stab set in
**5,464 / 5,464** buildings, and the deduped stab set never exceeds `num_cells` in any of
1,497 landblocks. Keep the invariant as a test (Stage 4) rather than a runtime fallback.
*Residual:* the invariant is measured against `~/ac_base_dats/` only. Assert-and-count, do
not assume, on any other DAT.

**R-2 — Perf: the retail walk vs the AABB heuristic. Net win, but measure it.** Today's
outdoor branch is `O(all loaded EnvCells)` — `self.cell_aabbs.iter()` at `scene.rs:3086`,
every call. The retail walk is `O(buildings under the frustum × portals per building)`;
measured world mean is **16,937 / 5,464 ≈ 3.1 portals per portal-bearing building**, p50 of
the per-LB deduped stab set is 17. The walk should be *cheaper*. The real cost is the
screen-space clip per aperture. Guard: reuse the `?portalPunch` LOS cache
(`LOS_CACHE_CAM_MOVE_M = 0.75`, `LOS_CACHE_MAX_AGE_FRAMES = 30`,
`portal_clip.js:101`/`:110`) rather than inventing a second one. Bench with the existing
cam-bench before/after; record p50 frame cost in the report.

**R-3 — Residency blow-up at Stage 4.** Mean 0.939 × `num_cells`, max 277. An unbounded
`grab_visible` port would make almost every interior in a town landblock resident, which
collides with `?sealedPark`'s 64 MB return-core budget and with `slotGrid` residency
authority. Mitigation is the split in Stage 4 (entry cells eager, stab remainder as an
`?envcellRing` hint). **Do not skip this split.**

**R-4 — `?drawPools` interaction.** `ENVCELL-POOL-SWAP` established that
`?portalStencil=on` **disarms** envcell pooling loudly (a pool cannot follow a container
onto `RENDER_LAYER_PORTAL_CELL`). `?bldPunch` does *not* relayer anything — it only writes
depth — so it should compose. **Verify, do not assume**, and add the same loud+counted
disarm if it turns out a building aperture forces a relayer.

**R-5 — Sidedness regression risk.** `?punchSidedness` is parked **off** as a regression
guard because the cell-centre heuristic (`apertureFacesAway`, `portal_clip.js:559`) culled
near-side doors. Building apertures carry real `portal_side` from the DAT and use retail's
plane test directly (`acclient.c:462533-462541`), so they are not exposed to that bug — but
only if Stage 3 keeps the paths separate. If a reviewer sees `?bldPunch` routing through
`apertureFacesAway`, that is the regression.

**R-6 — a3/a4 sequencing.** Stage 2 inserts outdoor→interior edges into *both* adjacency
and the union graph; if a3's split has not landed, that write goes to the merged graph and
silently changes physics (`current_cell`, `at_interior_doorway`, `clip_segment_to_cell_space`).
Stage 3 consumes a4's decoded sidedness. **Both are hard prereqs; there is no partial
landing.**

**R-7 — One unresolved decomp ambiguity (does not block).** `CObjCell::num_stabs/stab_list`
(`acclient.h:30927-30928`) is written by `CEnvCell::UnPack` under `pack_bitfield & 2`
(`acclient.c:349300-349318`) paired with a 64-byte `Frame` array (`:349319`) — i.e. **static
objects**, matching `dats.xml:4210-4236`'s `HasStaticObjs` / `Stab` vector. Yet
`PView::DrawInside` (`acclient.c:462480`) passes those same fields to `add_views`, and
`CEnvCell::find_visible_child_cell` (`acclient.c:349713-349721`) looks them up in
`visible_cell_table` — both of which treat them as **cell ids**. The `CEnvCell::UnPack`
decompilation is visibly field-shifted (note the repeated `this[-1]` at `:349188-349190`),
so this is most likely an IDA aliasing artifact rather than two meanings for one field.
**It does not affect this task**: `CBldPortal::stab_list` is unambiguous — widened with
`block_mask` at `:362537`, prefetched as `QualifiedDataID(id, 3)` (cell) at `:362563`,
accumulated into `CLandBlock::stablist` at `:352176`, and handed to `grab_visible` at
`:351603`. Flagged here so a future reader does not re-derive it.

**R-8 — Yaraq indoor bleed is a separate bug.** `laptopIgpuFindings` also reports grass
overpainting the interior floor **from inside** `0x7D640100` on the HD520 rig, while the
owner reports indoors clean on theirs. That is `indoorDepthSplit` / seal-aperture territory,
not BLDPORTAL-CONSUME. **Do not let it contaminate the Stage-3 A/B** — the acceptance
vantage is player-OUTSIDE only.

**R-9 — Known fail-open, inherited.** `PORTAL-P0-VALIDATE` records an accepted fail-open:
hill occluder + sunken target with no re-emergence over-punches within the pass's scissor
rect. Stage 3 widens the aperture set and therefore widens this. Note it if it becomes
visible in the wild; it is not a Stage-3 gate.

---

## Appendix A — anchor index (every retail claim in this document)

| symbol | acclient.c | what it establishes |
|---|---|---|
| `CBldPortal::UnPack` | 362499 | wire decode; inverted `portal_side`; block-mask widening |
| `CBldPortal::CBldPortal` | 362406 | field defaults |
| `CBldPortal::add_to_stablist` | 362423 | dedupe-append into the landblock list |
| `CBldPortal::GetOtherCell` | 362493 | `= CEnvCell::GetVisible(other_cell_id)` |
| `CBldPortal::PreFetchCells` | 362547 | stabs prefetched as cell DIDs (type 3) |
| `CBldPortal::pack_size` | 362575 | `(2n+8)` round-up-4 |
| `CCellPortal::UnPack` | 362379 | bit 2 = leads-outdoors, cell side only |
| `CBuildingObj::add_to_stablist` | 719041 | per-portal fan-out |
| `CBuildingObj::find_building_transit_cells` | 719068 / 719092 | the physics walk |
| `CBuildingObj::makeBuilding` | 719153 | construction |
| `CEnvCell::check_building_transit` | 348110 (sphere) / 348154 (parts) | transit test; sidedness at 348210-348218 |
| `CEnvCell::GetVisible` | 349674 | the residency lookup |
| `CEnvCell::add_visible_cell` | 349824 | DAT load on miss (`DBObj::Get`, type 3) |
| `CEnvCell::grab_visible` / `release_visible` | 350001 / 350021 | residency lifecycle |
| `CEnvCell::UnPack` | 349134 | EnvCell read order; block_mask at 349209 |
| `CLandBlockInfo::UnPack` | 351049 | block mask at 351144; `CBldPortal::UnPack` at 351203 |
| `CLandBlock::init_buildings` | 352120 | stab accumulation at 352176 |
| `CLandBlock::grab_visible_cells` | 351601 | the residency trigger |
| `PView::DrawPortal` | 462565 | **`outdoor_portal_list[portal_index]` at 462579** |
| `PView::ConstructView` (bld) | 462507 | sidedness gate 462533-462541; punch 462557 |
| `PView::ConstructView` (cell) | 462423 | the interior flood |
| `PView::DrawCells` | 461450 | terrain draw 461480; depth clear 461484; sentinel punch 461537-461538 |
| `PView::InitCell` / `AddToCell` | 461625 / 461761 | per-portal view state |
| `PView::ClipPortals` / `OtherPortalClip` / `AddViewToPortals` | 462250 / 462206 / 462132 | screen-space clip |
| `PView::add_views` / `remove_views` | 462070 / 461029 | the stab-list view scope |
| `PView::GetClip` | 461052 | aperture screen clip |
| `PView::DrawInside` | 462467 | indoor entry |
| `D3DPolyRender::DrawPortalPolyInternal` | 453882 | the punch: ±12 reject 453921; depth 453951; z 454015-454019 |
| `BSPNODE::build_draw_portals_only` | 362865 | front-to-back BSP walk |
| `BSPPORTAL::portal_draw_portals_only` | 364410 | `DrawPortal` fan-out at 364484 / 364511 |
| `RenderDeviceD3D::DrawBuilding` | 456933 | `outdoor_portal_list = building->portals` at 456937 |
| `RenderDeviceD3D::DrawMeshInternal` | 456960 | the two passes, 456983 / 456984 |
| `maxZ1 = 7` / `maxZ2 = 6` | 45770-45771 | the far-Z selectors |

Structs (`acclient.h`): `CBldPortal` 32094 · `CCellPortal` 32300 · `CEnvCell` 32072 ·
`CObjCell` 30915 · `BuildInfo` 32035 · `CLandBlockInfo` 31893 · `CLandBlock` 31337 ·
`PView` 45934 · `CPortalPoly` 39075.

## Appendix B — the measurement probe (reproducible; build OUTSIDE the repo)

Everything in F2 / §1.2's envelope came from this. Recreate at `/tmp/bldprobe`, with
`holtburger-dat` + `holtburger-common` as path deps and `[workspace]` empty so it does not
join the repo workspace. Build with the §3.5 toolchain prefix; runtime is ~0.7 s.

```rust
use holtburger_dat::landblock::LandblockInfo;
use holtburger_dat::physics::BspNode;
use holtburger_dat::file_type::GfxObj;
use std::collections::BTreeSet;

fn walk_ports(n: &BspNode, out: &mut Vec<(i16, i16)>) {
    match n {
        BspNode::Port(p) => {
            for pp in &p.portal_polys { out.push((pp.portal_index, pp.poly_id)); }
            walk_ports(&p.pos, out); walk_ports(&p.neg, out);
        }
        BspNode::Leaf(_) => {}
        BspNode::Internal(i) => {
            if let Some(c) = &i.pos { walk_ports(c, out); }
            if let Some(c) = &i.neg { walk_ports(c, out); }
        }
    }
}

fn main() {
    let cell   = holtburger_dat::open_provider("/home/wbterminal/ac_base_dats/client_cell_1.dat").unwrap();
    let portal = holtburger_dat::open_provider("/home/wbterminal/ac_base_dats/client_portal.dat").unwrap();
    for x in 0u32..=0xFF { for y in 0u32..=0xFF {
        let Ok(bytes) = cell.get_file((x << 24) | (y << 16) | 0xFFFE) else { continue };
        let Ok(info)  = LandblockInfo::unpack(&bytes) else { continue };
        for b in &info.buildings {
            if b.portals.is_empty() { continue }
            let entry: BTreeSet<u16> = b.portals.iter().map(|p| p.other_cell_id).collect();
            let stabs: BTreeSet<u16> = b.portals.iter().flat_map(|p| p.stab_list.iter().copied()).collect();
            assert!(entry.is_subset(&stabs));                 // 5464/5464
            if (b.model_id >> 24) as u8 != 0x01 { continue }  // 0 exceptions world-wide
            let gb  = portal.get_file(b.model_id).unwrap();
            let gfx = GfxObj::unpack(&mut std::io::Cursor::new(&gb)).unwrap();
            let mut pp = Vec::new();
            walk_ports(gfx.drawing_bsp.as_ref().unwrap(), &mut pp);
            assert_eq!(pp.len(), b.portals.len());            // 5464/5464
            let idxs: BTreeSet<i16> = pp.iter().map(|(i, _)| *i).collect();
            assert_eq!(idxs, (0..b.portals.len() as i16).collect());   // 5464/5464
            for (_, pid) in &pp { assert!(gfx.polygons.contains_key(&(*pid as u16))); }  // 16937/16937
        }
    }}
}
```

Per-landblock dump mode (the LB 0x7D64 listing quoted in F3) is the same walk printing
`p[j] flags/exact/side/other_cell/other_portal/stabs` per portal plus
`gfx …: PORT portal_polys=N resolvable=M polys=K`. Pass the landblock as
`0xXXYY0000` — the probe masks with `0xFFFF0000`, so `0x7D64` alone reads as landblock 0.

## Appendix C — prior art

`external/holtburger/newprompts/envcell-entry-from-terrain-design-2026-06-02.md` is the
**physics-side sibling** of this dossier (deep-dive workflow `wf_0f78c568-8be`, 2026-06-02):
the outdoor→indoor *entry* design built on the same `CBldPortal` data. Read §1 and §6 before
Stage 2 — several of its open questions are answered here:

- its §6 Q2 (*"`other_portal_id == 0xFFFF` guard semantics… not independently re-verified
  for the building side"*) → **answered: 0 of 16,937 `CBldPortal` records have
  `other_portal_id == 0xFFFF`.** The 0xFFFF guard is a `CCellPortal` concern only. Its
  §1 note that `check_building_transit` is *"guarded on `portal_id != ushort.MaxValue`"*
  is imprecise for the building path — retail's guard is `portal_id >= 0`
  (`acclient.c:348123`, `:348182`).
- its §2 table row *"Building→cell portal links — PARSED, NEVER CONSUMED"* is still true as
  of `2946486d`, but its `lib.rs:9435-9442` anchor is **stale** (lib.rs has since grown past
  57k lines); the live drop site is **`lib.rs:17829`**. Its `landblock.rs:37-50` anchor is
  still exact.

`apps/holtburger-web/docs/RETAIL-PORTAL-RENDERER-AND-CELL-TERRAIN-WATER-RELATIONSHIPS.md` is
the render-side companion referenced from the `portalStencil` / `portalPunch` flag rows.
