# Indoor portal clipping — design & staged plan (2026-07-06)

Fix #3 for "z-fighting near walls in dungeon hallways." The real fix for the
**cross-cell coincident two-sided wall** class that #1 (cell-static bias) and #2
(per-poly cull) cannot address.

## Why this is the only fix for the residual

Live measurement (Marketplace, headless geometry scan, 2026-07-06):

- The dominant coincident-overlap class is **cross-cell walls, exactly coplanar
  (gap ≈ 0 mm), overlapping in projection** — 640 same-facing + 120 back-to-back
  pairs across the 536-cell landblock.
- **All sampled cell polygons are `sides_type == 1` (two-sided)** —
  `distinctSidesTypeValues = {1: 712}` over 60 cells. AC authored cell geometry
  two-sided *by design*, so:
  - #2 per-poly cull is a **no-op** (nothing to cull; culling a face would hole
    the wall). Confirmed live: `?cellPerPolyCull=on` left all 996 MP wall
    material slots DoubleSide.
  - A deterministic depth bias can't pick a winner (symmetric two-sided tie).
- Retail never sees the fight because it is a **portal renderer**: each cell is
  drawn clipped to the doorway aperture(s) it is seen through, so cell A's wall
  and cell B's coincident wall never occupy the same screen pixels
  (`PView::GetClip` + iterative `PView::ClipPortals`; see
  `RETAIL-PORTAL-RENDERER-AND-CELL-TERRAIN-WATER-RELATIONSHIPS.md`).

**Scope reality:** the residual is *intermittent* — a 12-cell snapshot of the
actual simultaneously-visible render set had **zero** sub-cm coincidences; the
640/120 pairs are latent across the whole landblock and only bite when the
visibility set happens to co-include two coincident-walled cells. #1 already
fixed the *always-visible* class. So #3 is retail-correctness polish + a real
architectural upgrade, not a glaring-bug fix. Worth doing, but sequence it
accordingly.

## Ground-truth due diligence (decomp + Discord, 2026-07-06)

**Decomp (`acclient.c`) — verified retail mechanism:**
- `PView::ConstructView` (5A59A0) is the recursive walk: `GetClip` (screen clip) →
  `Render::copy_view` (install the clipped view polygon) → `DrawPortalPolyInternal`
  (depth punch) → recurse into `other_cell_id`.
- `Render::set_view` installs a **screen-space convex clip polygon** (`portal_vertex`
  + outcode `portal_inmask` + AABB `xmin/xmax/ymin/ymax`). Cell geometry is
  **software Sutherland–Hodgman clipped in screen space** against it before raster —
  NOT a stencil, NOT hardware clip planes. (`calc_clip_planes` builds 3-D portal
  planes too, but for object/light culling, not the raster clip.)
- `DrawPortalPolyInternal` (453882): `polyClipFinish` clips the portal poly, then
  draws it `DEPTHTEST_ALWAYS`, `CULLMODE_NONE`, writing far-Z — the depth punch.
  **Called in the indoor recursion too**, so retail punches per aperture even
  cell↔cell. → *Correction to an earlier draft: the punch is NOT optional indoors.*
- `PView::DrawCells` (461450): current cell drawn to the full view; each visible
  cell drawn once **per view** (`setup_view(cell, v)` looped over `num_view`) — a
  cell seen through two doorways carries **multiple clip polygons.** → *Milestone W
  must emit per-(cell, aperture-path) polys, not assume one per cell.*

**Discord (dev corpus) — what the client authors actually did/said:**
- trevis (renderer author): *"stencil tests with portals and drawing inside cells,
  only letting outside draw where there wasn't an inside"* — independently chose the
  **stencil** GPU realization (self-corrected from scissor: *"scissors are rectangles,
  stencils are per pixel"*). gmriggs: *"is it marking the portals with the stencil
  buffer?"* → **validates Milestone R's stencil approach.**
- trevis: *"to properly draw a dungeon you really need a start cell and then render
  out from there"* → **validates the start-cell BFS of Milestone R.**
- trevis: *"my current portal renderer only does inside/out, not cell↔cell… it would
  need to be updated for cell↔cell to make fancy dungeons, which acclient does"* →
  **confirms indoor→indoor is the un-done gap = Milestone R.**
- trevis: *"i dont recursively do portal rendering"* (a known bug he has) → our
  `getRenderSetWithPView` **already recurses to depth 8**, so Milestone W hands R
  nested clipping the hand-rolled renderer never got. Inherit its edge case:
  near-plane / transition **flashing** when the camera sits on a portal (mitigated —
  the wasm already Sutherland–Hodgman-clips against `z+w>=0` in homogeneous space).
- **The devs deprioritized this on purpose:** trevis: *"99% of the time it's fine
  without [a portal renderer], just rendering everything"*, *"i hate portal
  rendering"*, and portal passes *"would mean even more passes"* (perf). gmriggs's
  z-fight complaints are all the **outdoor** floor-vs-water case (already handled by
  `terrainLower`/`floorBias`/`portalPunch`), NOT the interior wall case.

**Net:** the three milestones are architecturally correct and independently
corroborated. The due diligence tightens two details (keep the depth punch; support
multi-view cells) and reinforces the cost/benefit: this is finicky, multi-pass polish
that the original authors skipped because "rendering everything" is fine 99% of the
time — consistent with the measured *intermittent* residual after #1.

## Verified existing infrastructure (reuse, don't rebuild)

- **The indoor portal walk already exists and is nested.**
  `SessionHandle::get_render_set_with_pview_internal` (apps/holtburger-web/
  src/lib.rs:28919) BFS-walks the portal-polygon chain exactly like
  `PView::ClipPortals`, to `PVIEW_MAX_DEPTH = 8`. Its queue element is
  `(cell_id, view_poly, depth)` (lib.rs:28987) where **`view_poly` is the
  screen-space clipped aperture polygon** for that cell, produced by
  `holtburger_world::pview_clip_polygon_against_polygon(&projected, &view_poly)`
  (lib.rs:29006, Sutherland–Hodgman, near-plane clipped in homogeneous space).
  **It returns only `cell_id` and throws `view_poly` away.**
- **A stencil aperture-clip pass already exists** — `PortalStencilPass`
  (scene3d/portal_stencil.js): MARK aperture → (punch depth) → DRAW cells masked
  to stencil. Built for the OUTDOOR→interior case (`?portalStencil`), single
  stencil ref, flat-shaded, `RENDER_LAYER_PORTAL_CELL = 2`. The MARK/DRAW
  machinery generalizes directly.
- **The indoor frame is already split into passes** (atmosphere_pipeline.js):
  world (layer 0) → depth-clear → cells (layer 1). The cells pass is where all
  BFS-visible cells are currently drawn *unclipped into one depth buffer* — the
  exact spot the z-fight originates and where the clip must go.
- **Aperture wire format precedent** — `get_visible_portal_apertures`
  (lib.rs:29048) already serializes polygons as
  `[count, (nverts, x0,y0,z0, …) × count]`; mirror it.

## The gap

1. The per-cell clip polygon the PView walk computes is **not exposed** to JS.
2. The indoor cells pass draws **every visible cell unclipped** — no per-cell
   stencil/scissor.

## Plan (3 milestones)

### Milestone W — wasm: expose per-cell clip polygons — ✅ DONE + VERIFIED (2026-07-06)

Shipped: `SessionHandle::get_pview_cell_clips` / `getPViewCellClips` (lib.rs),
returning `Vec<u32>` (see wire note below). Live-verified headless in the
Marketplace: on a 15-cell hallway view the returned cell-id set **exactly equals
`getRenderSetWithPView`** (0 missing / 0 extra), **no duplicate cells**, wire fully
consumed, every poly ≥3 verts and finite, current cell emitted at depth 0 with the
full NDC viewport, and **nested recursion to BFS depth 4** (`{0:1,1:3,2:5,3:5,4:1}`).
Clip polys are bounded to NDC `[-1,1]` on level views; tilted near-plane-crossing
views leave a few verts marginally outside (bounded — the GPU viewport-clips them
during stencil raster, harmless). A first draft packed `cell_id` as f32 and
collided (ids > 2²⁴); switching to `Vec<u32>` with `f32::to_bits` coords fixed it.


New `SessionHandle::get_pview_cell_clips(mvp: &[f32], max_depth: u8) -> Vec<f32>`.
Clone `get_render_set_with_pview_internal`, but accumulate each dequeued
`(cell_id, view_poly, depth)` and serialize:

```
[ view_count,
  (cell_id, depth, nverts, bits(x0),bits(y0), …)  × view_count ]   // Vec<u32>
```
**Return `Vec<u32>`, not `Vec<f32>`** — AC cell ids exceed 2²⁴ and lose precision
as f32 (caught in verification: `0x016c01bc` collided). Header fields are native
u32; NDC coords are `f32::to_bits` (NDC ∈ [-1,1] is always normal, never NaN, so
JS aliases the same `ArrayBuffer` as a `Float32Array` to read coords exactly).
First cut emits one record per **distinct** visible cell (the first-reached
aperture path). Full multi-view (retail's `num_view` — a cell drawn through two
doorways) is a follow-up; not needed for the z-fight (the coincident wall is
outside *every* aperture regardless).

- `view_poly` is already in **screen/NDC space** (post-projection, 2D) — perfect
  for stencil rasterization; no world re-projection needed. Emit 2D `x,y` per
  vertex (NDC).
- `depth == 0` = current cell → emit a full-viewport sentinel (or omit; JS draws
  the current cell unclipped).
- Reuse `pview_clip_polygon_against_polygon`; the only new work is *keeping* the
  polygon instead of discarding it, plus serialization.
- Build: `env PATH=… capped-build wasm-pack build --target web --out-dir pkg
  --release` (release, ~5 min; `--dev` for iteration). `pkg/` is gitignored →
  rebuild after any pull. Bump the manifest if the wire contract is consumed via
  the bake worker (it is not — this is a live per-frame session call).

**Verifiable headless:** call `get_pview_cell_clips` from a dungeon; assert
cell_count matches `getRenderSetWithPView`, every non-current poly has ≥3 verts,
and each poly's NDC bbox is inside `[-1,1]²`.

### Milestone R — JS: indoor portal-clip render pass

New `IndoorPortalClipPass` (or extend `PortalStencilPass` with an indoor mode),
inserted into the **indoor** branch of the cells pass. Per frame, when
`isCurrentCellIndoor()`:

1. Feed = `get_pview_cell_clips(mvp, 0)`; group by `depth`.
2. Draw the **current cell** (depth 0) to the shared color+depth buffer,
   unclipped (it fills the view; its own geometry + depth are the base).
3. For each other visible cell, **near→far by depth**: stencil-MARK its 2D clip
   polygon (a screen-space NDC triangle-fan, no depth test — visibility is
   already baked into the clip), then DRAW that cell's geometry with
   `stencilFunc = EQUAL(ref)` + normal depth test, so it appears **only inside
   its doorway aperture** and is depth-occluded by nearer current-cell geometry.
   The neighbor's coincident wall lies *outside* the aperture → stencil-clipped →
   never rasterized → **no z-fight.**
4. **Entities** in a cell inherit that cell's stencil ref (clip them to the same
   aperture so NPCs don't poke through walls beside a doorway).

Stencil-ref strategy: 8-bit stencil = 255 refs. Assign one ref per drawn cell;
reuse refs across apertures that don't overlap in screen space (or, simplest
first cut: draw strictly in BFS order with MARK-then-DRAW-then-CLEAR per cell so
one ref suffices — slower but correct, matches retail's iterative draw). **Keep
the per-aperture depth punch** (far-Z, `DEPTHTEST_ALWAYS`, within the stencil):
the decomp calls `DrawPortalPolyInternal` in the indoor recursion too, so it is
part of the faithful algorithm — reuse the existing `PortalPunchPass` shader. A
cell visible through **multiple** doorways is drawn once **per** clip polygon
(retail's `num_view` loop) — clip + punch + draw for each.

Gate: `?indoorPortalClip` (default OFF, per the render-change convention).
Requires the composer to allocate a **stencil buffer** when the flag is on
(mirror `stencilBuffer: !!portalStencil` in atmosphere_pipeline.js:274).

### Milestone V — validation

- **Headless (GPU-independent):** with the pass on, re-run the coincident-overlap
  scan but count only triangles that *actually rasterize* (clip each cell's tris
  against its NDC clip poly in JS) — assert cross-cell coincident overlaps in the
  clipped set drop to ~0. Also assert every visible cell still contributes ≥1
  clipped triangle (no cell fully vanished).
- **1070 eye-test (required):** walk MP hallways + a multi-room dungeon and a
  building interior. Confirm: (a) no wall-flicker, (b) no missing walls / no
  see-through into the void, (c) neighbor rooms appear only through their
  doorways, (d) no entity leakage beside doorways, (e) no perf cliff (draw-call
  count scales with visible-cell count — expected fine, retail did this).
  SwiftShader cannot judge stencil/depth fidelity.

## Risks / open questions

- **Overlapping apertures** (two doorways whose screen projections overlap): the
  per-cell-ref or iterative-clear draw order must ensure cell A never draws in
  cell B's aperture. Retail's strict iterative draw handles this; the single-ref
  MARK/DRAW/CLEAR-per-cell variant is the safe first cut.
- **Transparent cell surfaces** (glass, glows) already split into a transparent
  fused mesh — they must be drawn in each cell's stencil-clipped stage, after its
  opaque stage, preserving the existing transparent-queue behavior.
- **`view_poly` winding / NDC handedness** — validate the emitted 2D polys wind
  consistently for a triangle-fan stencil mark (may need `frontFace`/no-cull on
  the mark draw). Cheap to get right; test headless.
- **Interaction with `?stablist` / `?portalPunch`** (outdoor interior reveal):
  indoor clip is a *disjoint* branch (only when `isCurrentCellIndoor()`), so they
  compose without conflict, but confirm the layer-mask / pass ordering.

## Recommendation (post-due-diligence)

The plan is sound and corroborated — but the due diligence lowers its priority,
it does not raise it. The people who built this renderer looked at cell↔cell
portal clipping and **chose not to do it** ("99% of the time it's fine… just
rendering everything", "i hate portal rendering", "more passes"), because the
payoff is an intermittent 1% z-fight and the cost is a recursive, multi-pass,
near-plane-fragile stencil renderer that only the real GPU can validate. #1
already removed the always-visible class; #2 was a no-op (two-sided data). So the
residual this fixes is genuinely the tail.

Recommended sequencing:
1. **Milestone W — ✅ DONE (2026-07-06).** Small, self-contained, headless-verified,
   independently useful (a per-cell clip-poly export is reusable for occlusion
   culling / PVS diagnostics), and it commits us to nothing visual. `getPViewCellClips`
   now exists and is correct; source committed, pkg rebuilt (release).
2. **Hold Milestone R** until interior fidelity becomes a priority (a dungeon-
   content push), then build it behind `?indoorPortalClip=off` and batch V onto a
   1070 session with the other owed eye-tests (visual suite, portalPunch,
   horizonFade, terrainSlopeShading). Budget for the perf hit (per-cell passes)
   and the near-plane transition-flash edge case trevis already hit.

Blunt version: ship #1 (done), leave the intermittent cross-cell flicker to the
portal-renderer track, and don't spend a multi-pass renderer on a 1% artifact
unless dungeons become the headline feature.
