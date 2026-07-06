# Cave of the Escaped Thief — terrain covering the entrance (diagnosis + fix)

The outdoor terrain paints over a cave/dungeon entrance. Investigated directly
at the **Cave of the Escaped Thief**, landblock `0x40D8` (71.1N, 50.2W), outdoor
cell `0x40D8002C`, terrain height ≈ 4 m. Captures are geometry/occlusion
(SwiftShader), not pixel fidelity.

## ✅ RESOLVED (2026-07-05) — the portal punch never executed
The real fix is **not** a terrain cut (that was too coarse — it removed terrain
the crater rock doesn't cover). The retail-faithful `?portalPunch` was already
the right mechanism (per-aperture depth punch = `DrawPortalPolyInternal`) — it
just **never ran**. `PortalPunchPass` stored/read its render camera as
`this.mainCamera`, but the pmndrs base `Pass` in this version has
`set mainCamera(value) {}` (an **empty no-op setter, no getter**), so the camera
was silently dropped and `render()` read `undefined` and bailed every frame
(confirmed in source `postprocessing/build/index.js:115` and at runtime:
`{fired:1, mcAfter:false, isOwnProp:false}`). Fix = use `this.camera` (the real
field) at all sites; same one-liner applied to `PortalStencilPass`. `?portalPunch`
now defaults **ON**. Result: capture `08` — the mouth shows the cave, terrain
untouched, no over-cut. Everything else was already correct (cave cells drawn,
mouth aperture detected ~13 m, split armed). The terrain-cut section below is
kept as the (rejected) intermediate hypothesis.

## What the entrance actually is (DAT oracle)
`LandBlockInfo 0x40D8FFFE` → the entrance is a **building**, not terrain and not
a bare cell:
- model **`GfxObj 0x010029E2`** (the rock crater), `frame.origin (132,60,4)`, `numLeaves 73`
- one **portal** → EnvCell `0x101`, `stabList [256,257,258,628-645]` (12 cave cells)
- `numCells 391` (the dungeon behind it)

EnvCell `0x101` is authored `SeenOutside` with an outward portal (the cave mouth).

## The bug (measured, not inferred)
- The cave cells **are** drawn — `0x100/0x101/0x102` + stab_list cells are all
  `loaded`, `visible`, and in the frustum render set. Not an admission gap.
- The 2 mouth apertures **are** detected (octagons at `(12420, 41532, z≈6)`), and
  `?portalPunch=on` **arms** correctly.
- Yet the entrance stays covered. Cause: a **24 m terrain cell sits inside the
  building footprint** and paints over the crater opening. The punch only clears
  the small portal mouth — it can't remove the surrounding terrain cell.

Retail never has this: it **does not draw terrain inside a building footprint**
(decomp `RenderDeviceD3D::DrawBuilding`; Discord — trevis: *"cut holes in the
landscape for buildings"*, gmriggs: *"if dungeon-only landblock, didn't draw the
overworld"*).

Dead ends ruled out along the way: it is **not** a depth-encoding regression
(terrain + cells both write log `gl_FragDepth`), **not** "arm the punch" (A/B
`off == on`), and **not** a building-portal admission gap (cells are drawn).

## The fix — terrain-footprint suppression (prototyped, works)
Drop the terrain triangles for the building-footprint cell. Prototype in
`terrain_subdiv.rs:679` (hardcoded to LB `0x40D8` cell `(5,2)` for the A/B):
```rust
if (landblock_id >> 16) == 0x40D8 && (i / factor) == 5 && (j / factor) == 2 {
    continue; // drop terrain triangles under the building footprint
}
```
Rebuilt wasm `--dev`, re-rendered → the grass cell is gone, the crater/cave
shows (see `06`). Generalize by: fetch `LandBlockInfo (LB|0xFFFE)` in
`fetch_subdivided_landblocks` (`lib.rs:1666`), build an `[[bool;8];8]` mask from
`buildings[]` **with portals** (`frame.origin → cell`, plus BSP-AABB cells for
large structures), pass it to `subdivide_landblock`, replace the hardcode with
`if suppressed[i/factor][j/factor] { continue; }`.

## Captures
| file | shows |
|---|---|
| `00-reference-working-retail.jpg` | retail: you see down into the cave |
| `01-bug-wireframe-topdown.png` | wireframe: terrain grid fills the entrance ring |
| `02-bug-normal-topdown.png` | normal: grass covers the ring hole |
| `03/04-terrain-hidden-*.png` | early terrain-hidden probes (hid `terrainGroup` only — the batched terrain still showed; superseded by `07`) |
| `05-bug-cave-entrance-terrain-covers.png` | composer A/B, **before**: grass cell covers the crater opening |
| `06-prototype-terrain-cut-cave-revealed.png` | composer A/B, **after** the footprint cut: grass gone, crater/cave shows |
| `07-terrain-hidden-crater-and-doorway.png` | batched terrain hidden: the crater floor + grey stone doorway that the grass was covering |

Retail ground truth: `PView::DrawCells`, `RenderDeviceD3D::DrawBuilding`
(`outdoor_portal_list = building->portals`), `D3DPolyRender::DrawPortalPolyInternal`.
Portal-clip contingency: `external/holtburger/apps/holtburger-web/docs/incasefloatingartifact.md`.
