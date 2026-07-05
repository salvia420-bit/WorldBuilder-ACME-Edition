# Retail portal renderer & the terrain ↔ building-interior ↔ env-cell relationships

> ⚠️ **ADD TO MEMORY LATER** (user TODO). This doc is hard-won intelligence gathered
> 2026-07-04/05 from the retail decomp + the AC dev-community Discord archive, to guide
> fixing the terrain/water-vs-cell rendering issues in holtburger-web. Distil the
> "Retail algorithm" + "How our client differs" + "Phase-2 design" sections into a
> memory pointer (type: reference) when ready.
>
> Provenance: decomp facts verified against `/home/wbterminal/ac-headers/acclient.c`
> (signatures/constants confirmed, not just agent-cited line numbers). Discord facts
> from `/mnt/wbterminal2/ac-discord-archive/_indextest/ac.db` (channel/author/date given).
> Live probe: `scripts/multi-agent/town_interior_visibility_probe.mjs` +
> `crates/holtburger-dat/examples/probe_outdoor_aperture.rs`.

---

## The problem (four issues, two root causes)

Reported symptoms in holtburger-web:
1. **Building interiors show only NPCs from outside.** Standing in a town (e.g. Yaraq),
   looking into a building, you see ACE-placed NPCs but not the interior gfxobjs / lighting.
2. **Terrain covers dungeon entrances** (env cells) — regressed by a terrain height change.
3. **Terrain covers building-interior floors** when terrain grade > interior floor (common),
   and floor↔terrain **z-fight** when coplanar. A prior fix attempt failed.
4. **Water covers ocean-placed env cells.** Many dungeons sit in Dereth's oceans; our
   rising/falling water (which we keep) occludes them.

**Issue 1** is an independent *visibility-set* matter (see "Issue 1 status" — likely already
fixed). **Issues 2/3/4 are ONE bug:** our renderer is "acviewer-style" (single shared depth
buffer, draw-everything, no portal clipping), and terrain (and water, which *is* terrain)
therefore occludes / z-fights any cell geometry at or below grade. gmriggs (ACViewer's author)
names this exactly:

> *"i am getting z-fight between the dungeon floor and overworld water. **this is one of the
> cons of acviewer-style renderer, vs. acclient portal renderer.**"* — worldbuilder, 2026-02-13

---

## Retail algorithm (ground truth — verified in the decomp)

Retail is an **iterative portal renderer that clips in screen space and resets depth
per-aperture.** It is NOT stencil, NOT hardware frustum planes, NOT a scissor rect.

> *"acclient used a portal renderer, where it drew the current cell, clipped along the cell
> openings, and then drew into the next cells iteratively."* — gmriggs, worldbuilder, 2026-02-12

**Mechanism (all in `acclient.c`):**

1. **Screen-space polygon clip.** `PView::GetClip(Sidedness side, CPolygon *ppoly, Vec2Dscreen
   **clip_view, int *clip_pts, int check)` projects the portal polygon to screen;
   `ACRender::polyClipFinish(...)` Sutherland–Hodgman-clips the cell's projected geometry to
   that convex screen outline; `Render::set_view` installs it as the active clip region.
   Nested portals clip the already-clipped view again.
2. **Depth is "punched" to FAR inside the aperture.**
   `D3DPolyRender::DrawPortalPolyInternal(CPolygon *p, bool zClear)` draws the doorway polygon
   with `DEPTHTEST_ALWAYS` and, when `zClear`, writes `z = 0.99999899` (≈ far plane) into every
   aperture pixel. Terrain/walls already rasterized in front get their depth **reset only inside
   the doorway**, so the interior (drawn after, clipped to that same aperture) always wins depth
   there; outside the aperture it's clipped away, so there is nothing to fight and no see-through.
3. **Outdoor → interior via the building "stablist".** `LScape::grab_visible_cells` →
   `CLandBlock::init_buildings` → `CBuildingObj::add_to_stablist` → `CEnvCell::grab_visible`
   registers each building's interior cells as visible before drawing; `RenderDeviceD3D::
   DrawBuilding` sets `outdoor_pview->outdoor_portal_list = building->portals`, and
   `PView::DrawPortal`/`ConstructView` clip the interior to the door polygon.

Verified call chain:
`SmartBox::RenderNormalMode` → (outdoor) `LScape::draw` → per-block far→near `DrawBlock`
(terrain first, then `DrawSortCell`→`DrawBuilding`) → `PView::DrawPortal` → `GetClip` +
`DrawPortalPolyInternal` (depth punch) + `copy_view` (interior = door aperture) → recurse →
`PView::DrawCells`/`DrawEnvCell`.

### Key facts that rewrite the fix

- **Terrain is NOT holed or graded under buildings/dungeons.** No hole/suppress pass exists.
  Buildings sit at their authored frame; only *scenery* is snapped to the terrain plane
  (`CLandBlock::adjust_scene_obj_height`).
- **Z-fighting is solved by one global constant, not depth bias.**
  `float zFightTerrainAdjust = 0.0099999998;` — every terrain vertex is drawn ~1 cm **below**
  true elevation (in `ACRender::landPolyDraw`), so any floor/object at true ground height wins
  depth cleanly. Runtime slope bias is unused: `RenderDeviceD3D::SetDepthBias` is called exactly
  once, with `0.0`. gmriggs did the identical hack in ACViewer: *"i bumped [building interior
  floors] up like 0.01"* (2026-02-13).
- **Water is just opaque terrain** (terrain-type bytes `0x10`–`0x14` = the water types,
  textured through the normal depth-tested + depth-written terrain pass). No separate translucent
  water surface, reflection, or animated plane in retail. (Our rising/falling water is our own
  addition and is fine to keep.)
- **Ocean dungeons are never drawn from outside — by exclusion, not occlusion.** A dungeon in a
  water landblock has no building shell, so nothing feeds it into the `stablist`, and
  `CEnvCell::GetVisible` is never called for it. When you're *inside* one, `seen_outside == 0`
  means it never even pulls in the terrain/water. So water never "covers" it; it is simply never
  submitted from an outdoor camera.
- **`seen_outside` (SeenOutside) is the flag that gates outdoor interior rendering.** Only cells
  with SeenOutside render when the camera is outdoors.
  > *"Retail interiors are portal-driven (each EnvCell carries its visible-cell list), and only
  > cells flagged seen-outside should render when the camera is outdoors. If you bolted interiors
  > onto an outdoor frustum/distance cull keyed by terrain cell, the interiors fail the test and
  > get dropped every frame."* — z-z, acme-worldbuilder, 2026-06-12
  > *"I'm only rendering EnvCells with SeenOutside flag currently."* — trevis, worldbuilder, 2026-02-26

  **Our client reads the SeenOutside bit but only for ambient-sound gating, not for render.**

### Community corroboration (who/when)

- Landscape has **no spatial partitioning; only indoor cells carry a visible-cells list**;
  BSP is only needed if you *edit* geometry. (paradox 2022-06-17; trevis 2025-06-14/20)
- An **EnvCell owns no geometry** — it's `environment_id` → Environment (0x0D) → a specific
  **CellStruct index** + surface list + frame. Grab CellStruct 0 or fail the 0x0D parse → zero-poly
  cell dropped as "empty." (z-z 2026-06-12; decompiled `CEnvCell : CObjCell` posted by gmriggs 2024-03-11)
- **Buildings = a facade GfxObj shell + interior EnvCells; every entry/exit is a CellPortal.**
  (jovrtn/gmriggs/OptimShi 2025-10-16)
- **ACME's shipped solution is NOT a true portal renderer** — a flat pass-based order: building
  cells (polygon offset 0.5) → building portal occluders (depth-only) → dungeon cells (no offset),
  leaning on depth buffer + polygon offset. (Vanquish420 2026-02-25) — a pragmatic alternative
  to full portal clipping, noted for comparison.
- Water-landblock dungeons are a **convention** (cleanliness + server perf), not a requirement.
  (gmriggs 2026-03-09)

---

## How OUR client currently works (and why it breaks)

- Single shared-depth pass: the indoor depth-clear split was **removed** 2026-05-29
  (`scene3d/atmosphere_pipeline.js` ~L394-412, `worldMaskPass.mask = CAM_LAYER_MASK_BOTH`,
  depth-clear/cells passes disabled) because the old *global* clear caused see-through
  (downhill cottages/basements drawing through hills). Terrain writes log-depth
  (`scene3d/terrain.js` ~L1353) and correctly occludes anything behind/below — including cells
  we want to show. This is the acviewer-style trap.
- Cells are built (geometry, statics, scripts, lights) into per-cell `THREE.Group`s under
  `cellsGroup`, created `visible=false`, flipped on by `tickCellVisibility3D` (`scene3d/cells.js`)
  from the wasm render set. NPCs live in `entitiesGroup` (always visible) → "only NPCs" symptom.
- The wasm already computes **screen-space clipped portal polygons**
  (`getRenderSetWithPView`, Sutherland–Hodgman, `apps/holtburger-web/src/lib.rs`) — the exact
  input a portal-stencil pass needs. Nothing consumes them for GPU clipping yet.
- Terrain regression for issue 2: commit `5261caf0` (2026-06-26) raised terrain visual Z to full
  collision grade and deleted the ±0.3 m downward visual clamp — removing the margin that let
  at-grade dungeon-entrance cells peek above terrain.

---

## Issue-by-issue mapping

| Issue | Root | Fix |
|---|---|---|
| 1 — interiors show only NPCs | visibility-set; likely already fixed by `9eb284a0` | (optional) gate outdoor interior visibility on **SeenOutside** for robustness |
| 2 — terrain buries dungeon entrances | acviewer shared depth (+ `5261caf0`) | portal-stencil per-aperture depth reset; interim: adopt `zFightTerrainAdjust` |
| 3 — terrain over floor / z-fight | acviewer shared depth | same; `zFightTerrainAdjust` replaces the fragile per-building `-2e-4` bias |
| 4 — water over ocean dungeons | cells drawn without portal exclusion | portal-stencil (interiors draw only within an aperture, where depth is reset & water isn't drawn) |

---

## Phase-2 design: retail-faithful portal-stencil pass (chosen approach)

We already have the hard part (`getRenderSetWithPView` → clipped portal polygons). GPU build:

1. **Outdoor pass unchanged**: terrain (optionally lowered by `zFightTerrainAdjust` ≈ 0.01),
   buildings, outdoor statics → shared depth.
2. **Per visible portal aperture** (from the PView walk):
   a. Rasterize the aperture polygon into the **stencil** buffer (mark aperture pixels).
   b. **Reset depth to far** within the stencil mask (draw the aperture quad with
      `depthTest=ALWAYS`, write far) — the WebGL realization of `DrawPortalPolyInternal`'s
      depth punch.
   c. Draw that cell's geometry with **stencil test = inside aperture**, normal depth test.
   d. Recurse into nested portals, clipping against the accumulated aperture.
3. Delete the obsolete/fragile bits this subsumes: per-building `floorDepthBias`, and the fear of
   the old global depth-clear (this bounded version does not cause see-through).

This structurally eliminates 2/3/4: terrain can't intrude into an aperture (depth reset),
interiors show through doors/windows, ocean dungeons appear only through their portals, and
z-fighting is gone. Buildable **flag-off**, eye-tested on the GTX-1070 later (per capped-builds /
chrome-testing discipline; local browser OOMs on full-render town scenes).

Cheap complementary win, adoptable independently: draw terrain ~1 cm low globally
(`zFightTerrainAdjust`) — retail-faithful, kills coplanar floor fights.

---

## Issue 1 status (evidence)

- Static proof (`probe_outdoor_aperture.rs`, real Holtburg-town DAT): **0%** of 69 outdoor-exit
  cells are dropped by the portal-polygon gate — the scout's "polygons don't resolve" theory is
  **false** for real town data.
- Live proof (`town_interior_visibility_probe.mjs`, headless nullRender, Holtburg): the outdoor
  render-set (`getRenderSetWithFrustum`) **admits 48 interior cells** and 116 cell containers are
  built. → Interiors do render from outside; **issue 1 appears already fixed by `9eb284a0`**
  (2026-07-02 "building interiors — walk-in cell binding + outdoor portal-clipped visibility").
- Not yet confirmed by a *rendered* frame (local full-render OOMs; 1070 eye-test deferred).

---

## Open questions / verification TODO

- Confirm issue 1 with a rendered 1070 eye-test in a town (interiors visibly present, not just in
  the render set).
- Decide whether to switch the outdoor-exit gate from the portal-polygon heuristic to the
  retail-faithful **SeenOutside** flag (more robust; our wasm already parses the bit).
- Phase-2: prototype the stencil portal pass; verify no see-through and no stencil leakage across
  nested portals; confirm interaction with the sky/atmosphere/cloud-depth passes in
  `atmosphere_pipeline.js`.
- Watch `5261caf0` and `61afddd1` (terrain multidraw default-ON) when eye-testing entrances.
