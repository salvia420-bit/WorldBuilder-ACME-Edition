# In case of the floating-artifact (the real `PView::GetClip` step)

> Contingency runbook. `?stablist` ships **default ON** (2026-07-05, user-validated):
> building interiors render from an outdoor camera. It is bounded today by the
> shared depth buffer + a conservative height cull — **not** a true portal clip.
> If a building ever shows interior cells **floating in the sky** (or bleeding
> outside its silhouette), this is the retail-faithful fix. Don't build it
> pre-emptively — only when the artifact actually shows on a real GPU.

Companion reading (same folder): `RETAIL-PORTAL-RENDERER-AND-CELL-TERRAIN-WATER-RELATIONSHIPS.md`
(the decomp/Discord ground truth) and `url-flags.md` (`stablist`, `portalPunch`, `portalStencil`).

---

## What ships today (and why it's *usually* enough)

`?stablist` admits every frustum-visible `SeenOutside` interior cell to the outdoor
render set — retail's `CLandBlock::grab_visible_cells` → `CEnvCell::grab_visible`
stablist (all building interior cells are authored `SeenOutside`). Their cell-owned
static content then draws from outside. It is bounded by TWO backstops, neither of
which is the retail clip:

1. **The shared depth buffer does most of the "clip" for free.** Interior cells are
   drawn against the world pass's facade + terrain depth, so:
   - a **closed/roofed** building's facade occludes its interior (you see the shell),
   - an **open-top courtyard** shows its interior over the walls (the look the user
     likes and wants kept),
   - `?portalPunch` resets depth in door/window apertures so you see **through the
     doorway** on closed buildings.
2. **A conservative floating-satellite cull.** `get_render_set_with_frustum`'s
   stablist block (`src/lib.rs`) computes the lowest frustum-visible `SeenOutside`
   cell (≈ the buildings' base in view) and drops any admitted cell whose AABB floor
   is more than `FLOAT_CULL_BAND_M = 100.0` m above it. No AC building is remotely
   100 m tall, so a real multi-story floor is never culled, while sky-satellite cells
   (e.g. Holtburg `0xA9B40158` at ~195 m) are.

**The gap the depth buffer CANNOT close:** an interior cell that projects only against
the **sky** — nothing in front of it in the depth buffer — wins the depth test and
**floats**. The 100 m cull catches the egregious ones; a genuine upper/satellite cell
within the band, viewed against sky, could still float. That is the case this doc is for.

---

## The retail-faithful fix: `PView::GetClip` (screen-space portal clip)

Retail never relies on depth to bound interiors. It draws each admitted interior cell
**clipped in screen space to the building's door/window portal polygons**, so a cell
only paints where it is genuinely visible **through an aperture**. Floating satellites
clip away (no aperture shows them); nothing paints outside the doorway; no see-through.

Verified in the decomp (`/home/wbterminal/ac-headers/acclient.c`, bodies read):

- **`PView::GetClip(Sidedness, CPolygon *ppoly, Vec2Dscreen **clip_view, int *clip_pts, int check)`**
  projects the portal polygon to screen (`PrimD3DRender::xformStart`) and calls
  **`ACRender::polyClipFinish`** — a classic **Sutherland–Hodgman** clip of the cell's
  projected geometry to that convex screen outline (2D cross-product side test,
  interpolated intersection points, ping-ponging `polyBuf[0]`/`polyBuf[1]`). NOT
  stencil, NOT hardware clip planes, NOT a scissor rect. `Render::set_view` installs
  the active portal polygon's screen extents. Nested portals clip the already-clipped
  view again (iterate until no more visible portals — cap the depth).
- **`D3DPolyRender::DrawPortalPolyInternal(CPolygon *p, bool zClear)`** — the per-aperture
  depth punch: `DEPTHTEST_ALWAYS`, and when `zClear` writes `gl_FragDepth = 0.99999899`
  (≈ far) into the doorway so terrain/walls can't occlude the interior there.
- **`RenderDeviceD3D::DrawBuilding`** sets `outdoor_pview->outdoor_portal_list =
  building->portals` — the clip list for the interior draw.

So the retail order is: admit the stablist → draw each interior cell **clipped to the
building's portal apertures** (`GetClip`) with a **far depth punch** in the aperture
(`DrawPortalPolyInternal`).

---

## We already have most of the machinery

Do not start from scratch — the hard parts exist:

- **`SessionHandle::getVisiblePortalApertures(mvp)`** (`src/lib.rs`) — returns the
  visible outdoor-facing door/window aperture polygons in AC world space (validated
  live: ~20–100 real quads per town). This is the clip list.
- **`holtburger_world::pview_project_polygon` + `pview_clip_polygon_against_polygon`**
  — the Sutherland–Hodgman project + clip the wasm already uses in
  `get_render_set_with_frustum`'s PView walk. The math for `polyClipFinish` is done.
- **`scene3d/portal_punch.js`** (`?portalPunch`) — the per-aperture far-depth punch
  (`gl_FragDepth = 0.99999899`, `depthFunc=Always`), the WebGL `DrawPortalPolyInternal`.
- **`scene3d/portal_stencil.js`** (`?portalStencil`, WIP scaffold) — the GPU
  realization of the *clip*: mark each aperture into the **stencil** buffer
  (depth-tested → occluded doorways don't mark → no see-through), reset depth to far
  in the mask, then draw the interior cells **stencil-tested to the aperture**. Retail
  uses a software clip; **stencil is the GPU equivalent of `GetClip`** for arbitrary
  convex apertures (scissor is rectangle-only, insufficient for angled doors).

---

## Implementation sketch (when the artifact demands it)

1. Keep `?stablist` admitting the cells (unchanged).
2. World pass draws terrain + facade only (the `?portalPunch` split already does this:
   `worldMaskPass = WORLD_ONLY`).
3. For each visible aperture (`getVisiblePortalApertures`): **stencil-mark** it
   depth-tested (portal_stencil's mark material) + **punch depth to far** in the mark
   (portal_punch / portal_stencil reset material).
4. Draw the interior cells (layer 1) **with the real textured/lit materials**,
   **stencil-tested to the aperture** (NOT the flat-grey `scene.overrideMaterial` the
   milestone-1 scaffold used, and NOT re-layered to layer 2). Interior wins in the
   punched aperture, is stencil-clipped elsewhere → floaters gone, no see-through.
5. The composer needs a **stencil buffer** (`atmosphere_pipeline.js` allocates one only
   when `portalStencil` is on — extend to the clip mode). Verify `gl.getParameter(
   gl.STENCIL_BITS)` on the R9 290; SwiftShader is too lenient to trust here.

### ⚠️ Preserve the open-top over-the-wall view (user preference)
A **strict** retail door-clip shows interiors **only through the doorway** — which
would *remove* the over-the-wall courtyard view the user explicitly likes. The chosen
policy (2026-07-05) is **hybrid**: clip roofed/closed buildings to their apertures, but
let open-top courtyard buildings keep drawing over the walls (the depth buffer already
gives that for free). Detecting open-top vs closed is the open design question — a
building whose interior cells are visible over the facade top (not occluded) is
"open"; one fully enclosed by its facade is "closed". Until that's built, the 100 m
cull + depth buffer is the backstop and the strict clip is NOT applied.

---

## Anchors

| What | Where |
|---|---|
| Stablist admission + `FLOAT_CULL_BAND_M` cull | `src/lib.rs` `get_render_set_with_frustum` (outdoor branch, `stablist_render_enabled`) |
| Aperture list | `src/lib.rs` `get_visible_portal_apertures` |
| S–H project/clip helpers | `holtburger_world::pview_project_polygon`, `pview_clip_polygon_against_polygon` |
| Depth punch (WebGL `DrawPortalPolyInternal`) | `scene3d/portal_punch.js` |
| Stencil clip scaffold (`GetClip` GPU equiv) | `scene3d/portal_stencil.js` |
| Default-on flag driver | `scene3d/cells.js` `tickCellVisibility3D` (`setStablistRender`) |
| Retail ground truth | `docs/RETAIL-PORTAL-RENDERER-AND-CELL-TERRAIN-WATER-RELATIONSHIPS.md` |
| Decomp | `/home/wbterminal/ac-headers/acclient.c`: `PView::GetClip`, `ACRender::polyClipFinish`, `Render::set_view`, `D3DPolyRender::DrawPortalPolyInternal`, `RenderDeviceD3D::DrawBuilding` |
