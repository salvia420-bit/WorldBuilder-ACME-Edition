# INVESTIGATIVE HANDOFF — indoor cell rendering, the Vanquish420 non-stencil approach (2026-07-06)

**Status: investigation + structural outline only. No code written.** This maps
Vanquish420's documented indoor-render architecture onto holtburger-web's current
code and grounds it in the retail decomp, so whoever implements it (or Vanquish420
himself) starts from the real seams, not a blank page.

## Why this doc exists

The z-fight residual we keep circling is **cross-cell coincident two-sided walls**
in dungeons/multi-room interiors (design doc: 640 same-facing + 120 back-to-back
coplanar pairs across the 536-cell Marketplace landblock; AC authors cell geometry
`sides_type==1` two-sided, so per-poly cull is a no-op and a symmetric depth bias
can't pick a winner).

We tried the **stencil portal-clip renderer** (`?indoorPortalClip`, Milestone R in
`DESIGN-indoor-portal-clip-2026-07-06.md`) and **reverted it** the same day: it
forced a packed depth-stencil buffer (degrading the AerialPerspective depth the
whole outdoor frame samples), added a per-cell multi-pass draw explosion, and was
flat-shaded — "a large number of regressions for an intermittent 1% artifact"
(user). A Sonnet-5 dig through the dev Discord surfaced a **different, simpler
architecture** that a working alt-client dev (Vanquish420) uses, which avoids the
stencil buffer entirely. This doc investigates that.

## Vanquish420's approach (his words, dev Discord 2026-02-25)

> "It's neither depth first or breadth first in a scene graph sense — it's a flat
> **pass-based order**. Each category renders all its instances in one pass. Within
> EnvCells, the order is: **Building cells (with polygon offset 0.5), Building
> portal occluders (depth-only), Dungeon cells (no offset)**."

> "There's **no front-2-back or back-2-front sorting** within any pass, it's just
> 'all building cells, then all dungeon cells.' The **depth buffer + polygon offset
> handles the visual priority**."

> "I use **portals only for visibility/culling** [NOT GPU clipping]. I do two render
> passes: one for all building interiors and one for all dungeon cells, **batching
> by shared geometry** so we get one instanced draw per mesh type instead of per
> building or per portal."

### The four pillars
1. **Portals = CPU visibility culling only.** The portal graph decides *which* cells
   are potentially visible; the GPU never clips or stencils to a portal.
2. **Flat, category-ordered passes** — building cells → building-portal occluders
   (depth-only) → dungeon cells. No per-cell sort.
3. **Depth buffer + a per-category depth offset** resolves layering (building cells
   biased 0.5, dungeon cells 0) — no stencil.
4. **Batch by shared geometry → instanced draws** (perf, not correctness).

## Decomp grounding (retail — what's faithful, what's a deliberate deviation)

Read these before mapping, so we know what we're approximating:

- **Retail does NOT depth-bias.** `RenderDeviceD3D::SetDepthBias` is only ever called
  with `0.0` (`$DECOMP/acclient.c:457719`). Retail resolves cross-cell walls with a
  **software portal renderer**: `PView::ConstructView`/`GetClip`/`Render::set_view`
  install a screen-space convex clip polygon and Sutherland–Hodgman-clip each cell's
  geometry before raster, so coincident walls of different cells never occupy the
  same pixel. So **Vanquish420's polygon-offset is a modern GPU *approximation*, not
  a retail port** — it trades exact clipping for "cull tight + bias layering," and
  accepts the rare residual retail eliminates by construction. State this honestly;
  it's the right trade for a web client, but it is a trade.
- **Building vs dungeon is a real retail distinction.** `CBldPortal` (building
  portals, `add_to_stablist` = SeenOutside) vs `CEnvCell` (interior/dungeon cells).
  Buildings draw via `RenderDeviceD3D::DrawBuilding` (`456933`).
- **The "building portal occluders" have a retail analog.** `DrawBuilding` →
  `RenderDeviceD3D::DrawMeshInternal(i_bBuilding=1)` (`0x59F360`) calls
  `BSPTREE::build_draw_portals_only(bsp, 1)` then `(bsp, 2)` — retail draws a
  building's **portal polygons separately** (two modes; the punch-vs-contents split
  ties back to `DrawPortalPolyInternal`'s `zClear` in `ConstructView`). So a
  depth-only portal-occluder pass is grounded, not invented — clarify the exact
  semantics with Vanquish420 (see Open Questions).
- **Portal visibility is the load-bearing part.** `CEnvCell::add_visible_cell` /
  `find_visible_child_cell` / `GetVisible` + `PView::ClipPortals` build the visible
  set. Vanquish420 keeps this and drops only the *raster* clip. Our wasm already does
  the equivalent BFS (below).

## holtburger-web today — what already exists (map, don't rebuild)

The current indoor render is literally "just render everything" (trevis's phrase):
one shared world pass, `worldMask=BOTH`, both terrain (layer 0) and interior cells
(layer 1) into one depth buffer, no stencil, no clip. Three of Vanquish420's four
pillars are ALREADY here in some form:

| Vanquish420 pillar | holtburger today | Gap |
|---|---|---|
| Portals = visibility culling | ✅ `tickCellVisibility3D` (cells.js ~1145–1196) unions `getRenderSetWithFrustum(mvp)` with `getRenderSetWithPView(mvp,0)` (wasm BFS portal walk, depth-cap 8) → `cellContainer.visible = renderSet.has(cellId)` (cells.js ~1063) | Culling may be **looser** than retail's per-view `ClipPortals` → more coincident cells co-visible than Vanquish420's client. Investigate tightening. |
| Per-category depth offset | ⚠️ Shader-bias primitives exist: `applyFloorDepthBias` (`gl_FragDepth -= 2e-4`, floor-vs-terrain), `applyFillDepthBias` (`+= 2e-4`), `?cellStaticBias` (décor props toward camera) — materials.js ~399–460, cells.js ~67 | No **building-vs-dungeon per-category** bias. Must add one, keyed on the cell category. |
| Building vs dungeon signal | ✅ `cell_seen_outside` bit per cell (wasm `scene.cell_seen_outside` / `insert_cell_seen_outside`, lib.rs ~12582); interior cells are `(cellId & 0xffff) >= 0x100` (cells.js ~1421) | SeenOutside ≠ perfect classifier (dungeon *mouths* start SeenOutside then flip deeper — gmriggs). Pick the right category key. |
| Batch by shared geometry | ⚠️ cell meshes are **fused per cell** already (`new THREE.Mesh(fused, materials)`, cells.js ~779) | Not instanced *across* cells by mesh type. Perf follow-up, not correctness. |

### The one gotcha that changes everything
**`polygonOffset` is DEAD in this renderer.** The renderer runs
`logarithmicDepthBuffer: true` (index.js:768), so every material writes
`gl_FragDepth`, and the fixed-function polygon offset is discarded once a fragment
shader writes depth (materials.js:389, terrain.js:683). **Vanquish420's "polygon
offset 0.5 / 0" cannot be copied literally** — it must become a **shader
`gl_FragDepth` bias** (exactly what `applyFloorDepthBias`/`applyFillDepthBias`
already do). This is the single most important adaptation. Map "offset 0.5" to a
log-depth epsilon (start from the existing `2e-4`; tune on the 1070).

## Basic structure — what a holtburger implementation looks like

This is an **evolution of the existing shared-depth pass**, not a new renderer. All
behind `?indoorCellsV2=off` (default-off, render-change convention). No stencil
buffer → no packed depth-stencil → no outdoor AerialPerspective cost (the thing that
sank the stencil approach).

**Milestone A — category tagging (data).** Give every visible interior cell a
category: `building` (SeenOutside-attached, `CBldPortal` side) vs `dungeon`
(deep `CEnvCell`). Source = `cell_seen_outside` + building-attachment; expose a
per-cell category from wasm alongside the render set, or derive it JS-side from the
existing SeenOutside bit. Headless-verifiable: dump category per cell in the
Marketplace + a Holtburg cottage, eyeball against known layout.

**Milestone B — per-category shader depth bias (correctness core).** Extend the
`applyFillDepthBias` family to a `applyCellCategoryBias(material, category)`:
building-cell materials get a small toward-camera `gl_FragDepth` nudge; dungeon-cell
materials get none (or the opposite sign). Apply via the existing cache-owned-clone
path (never mutate shared base materials — see `getCachedFloorBias`). This resolves
building-vs-terrain and building-vs-dungeon layering the way Vanquish420's offset
does. Headless-verifiable: the biased material compiles + the `gl_FragDepth` inject
lands (grep the compiled shader), no new console errors.

**Milestone C — category-ordered draw (structure).** Draw the visible interior cells
in Vanquish420's order — all building cells, then the depth-only building-portal
occluders, then all dungeon cells — instead of the current unordered layer-1 draw.
In holtburger this is a draw-order/renderOrder arrangement within the existing cells
draw (or a small dedicated pass), NOT a stencil pass. Because it's pure depth +
draw-order, `?indoorCellsV2=off` is trivially byte-identical.

**Milestone D — building-portal occluders (the fuzzy one).** A depth-only pass for
the building/portal boundary (retail `build_draw_portals_only`). **Get the exact
role from Vanquish420 first** (Open Questions) — this is the least-specified pillar.

**Milestone E — culling tightness (the actual residual lever).** The design doc's
measurement is the key: a 12-cell *simultaneously-visible* snapshot had **zero**
sub-cm coincidences; the 640/120 pairs only bite when the visible set co-includes
two coincident-walled cells. So the real win may be **tightening `getRenderSetWithPView`
toward retail's per-view `ClipPortals`** so coincident cells are rarely co-visible —
then bias handles the rest. Measure co-visible coincidence count before/after; this
is GPU-independent and the highest-leverage, lowest-risk change.

**Milestone F — instancing** (perf; batch shared cell geometry across cells). Last.

## Open questions — clarify with Vanquish420 (he built this)

1. **"Building portal occluders (depth-only)"** — what geometry exactly (the portal
   polygons? the facade shell? the doorway quads?), and what does the depth-only
   write buy you *given* portals are already culling? Occlude the interior outside
   the opening? Prevent dungeon-over-building bleed?
2. **"Polygon offset 0.5"** magnitude — under our `logarithmicDepthBuffer` that's a
   `gl_FragDepth` epsilon, not a fixed-function unit. What's the offset relative to
   (near/far range, units)? Any per-distance scaling?
3. **Building vs dungeon classification** — what's his source of truth? Does he split
   on the building-attachment (CBldPortal) or on SeenOutside, and how does he handle
   dungeon mouths that are SeenOutside on entry?
4. **Coincident dungeon-vs-dungeon walls** (both "no offset") — does his culling
   guarantee they're never co-visible, or does he accept residual there? i.e. how
   much is the offset doing vs. the culling tightness?
5. **Two-sided cell geometry** — does he keep cells `DoubleSide`, or does the
   pass-order + occluders let him backface-cull interiors (gmriggs's "one easy way to
   prevent interior flicker: backface-cull envcells")? We measured cells authored
   two-sided, so this interacts with #1.

## Why this over the stencil approach

- **No stencil buffer** → no packed 24-bit depth-stencil → the AerialPerspective /
  cloud depth the whole *outdoor* frame samples is untouched (the reverted stencil
  pass's worst regression).
- **No per-cell multi-pass** → draw-calls scale with mesh types (instanced), not with
  visible-cell count × passes.
- **It's the current renderer + ordering + a per-category bias**, so `=off` is
  byte-identical by construction and the blast radius is tiny.
- Corroborated by two independent working devs' philosophy: "99% of the time it's
  fine… just rendering everything" (trevis) — Vanquish420 keeps "render everything"
  and adds only the cheap ordering/bias that removes the 1%.

Honest caveat: this is a **GPU approximation, not the retail portal renderer**. It
will not be pixel-identical to acclient in pathological coincident-and-co-visible
cases; retail's software clip is the only thing that is. The bet (Vanquish420's, and
worth taking) is that tight culling + category bias makes the residual invisible in
practice at a fraction of the stencil cost.

## Code map / anchors

| What | Where |
|---|---|
| Current cell-visibility cull (PVS ∪ frustum → `.visible`) | `scene3d/cells.js` `tickCellVisibility3D` ~1063, ~1145–1196 |
| Cell mesh/material build (fused per cell) | `scene3d/cells.js` `buildEnvCellsForLandblock` :239, mesh :779 |
| Shader depth-bias primitives (the log-depth polygon-offset replacement) | `scene3d/materials.js` `applyFillDepthBias` ~399, `applyFloorDepthBias` ~425, `getCachedFloorBias` ~1923 |
| `?cellStaticBias` (existing per-static bias, the #1 fix) | `scene3d/cells.js` ~67 |
| `polygonOffset` is dead under logdepth (why shader bias) | `scene3d/materials.js` ~389, `scene3d/terrain.js` ~683 |
| logarithmicDepthBuffer on | `scene3d/index.js` :768 |
| SeenOutside / building-interior signal | wasm `src/lib.rs` `cell_seen_outside` ~12582, `insert_cell_seen_outside`; interior-cell id test `(cid & 0xffff) >= 0x100` (cells.js ~1421) |
| PVS BFS (portal walk, the culling to maybe-tighten) | wasm `get_render_set_with_pview_internal` (lib.rs ~28959), `getRenderSetWithPView` ~28880 |
| Current indoor render path (shared BOTH pass) | `scene3d/atmosphere_pipeline.js` `preFrameSkySync` (worldMask=BOTH indoors) |
| Retail: no depth bias | `$DECOMP/acclient.c:457719` `SetDepthBias(v1, 0.0)` |
| Retail: building draw + portals-only | `DrawBuilding` :456933, `DrawMeshInternal`→`build_draw_portals_only` (0x59F360 / :456960) |
| Retail: building vs dungeon classes | `CBldPortal::*` (`add_to_stablist`), `CEnvCell::*` (`add_visible_cell`, `find_visible_child_cell`, `check_building_transit`) |
| Retail: software portal clip (what we're approximating) | `PView::ConstructView`/`GetClip`/`Render::set_view`/`polyClipFinish` — see `RETAIL-PORTAL-RENDERER-AND-CELL-TERRAIN-WATER-RELATIONSHIPS.md` |
| Discord source quotes (full dig) | Sonnet-5 report, 2026-07-06 (Vanquish420 20260225 `worldbuilder`) |

## What NOT to repeat (from the reverted stencil attempt)

- Don't force a stencil/packed-depth buffer for the whole session — it degraded the
  outdoor AerialPerspective.
- Don't "validate" by checking the data feed + `_errored`; **instrument the actual
  render** (draw calls, a real eye-test). The stencil pass threw on every indoor
  frame while its data feed looked perfect and `_errored` read false (the throw
  escaped the try before the catch).
- Nothing render-visible flips default-on until it's seen on the R9 290 / 1070.
