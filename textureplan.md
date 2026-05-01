# Texture parity plan

> **Status 2026-05-01 ~01:25** — Item 1 (sprite roofs) **DONE**: 313/313 surface
> loads now succeed. One-line fix in
> `ObjectSpriteGenerator.TryLoadSurface`: `Textures[0]` → `Textures[^1]`.
> Verified on 0x010014C3, 0x01002A1B, 0x01000827. Item 2 (terrain
> overlays) still pending — see updated section below.

Two real bugs surfaced during the texture push on 2026-04-30. Both are
beyond a one-flag fix; this captures the diagnosis and the work needed
to bring rendered tiles to painter parity.

## 1. Object-sprite roofs flat-shaded (233 of 313 surface lookups fail)

### Diagnosis

Filtered `generate-object-sprites` over Holtburg's 4 LBs
(`0xA9B3 0xA9B4 0xAAB3 0xAAB4`) with `SurfaceDiag` instrumentation in
`ObjectSpriteGenerator.cs:TryLoadSurface`. Result:

```
[SurfaceDiag] ok=80
  badRead_RenderSurf=233
    breakdown by kind of failing DataId:
      0x06: 233
```

- The `Surface(0x08) → SurfaceTexture(0x05) → Textures[0]` chain walks
  cleanly (no `badKind_*`, no `emptySurfaceTex`). The walk-the-chain fix
  from earlier today is doing its job.
- All 233 failing DataIds *are* correctly tagged kind `0x06`
  (`RenderSurface`). They are not pointing at a wrapper or a different
  type — they are valid RenderSurface refs.
- The dat read itself (`dats.TryGet<RenderSurface>`) returns false for
  these DIDs, even though `client_highres.dat` is loaded alongside the
  rest in `projects/RetailSmoke/dats/base/`.
- Visually consistent with what we see: walls textured, **roofs flat**.
  Multiple buildings (`0x01002A1B`, `0x010014C3`) share the pattern.

### Hypotheses (in order of likelihood)

1. **The reader is too strict.** `DatReaderWriter.TryGet<RenderSurface>`
   may demand a header signature that some highres entries don't
   satisfy. Reading the raw dat blob and parsing manually might work
   where `TryGet` doesn't. (Compare against `WorldBuilder.Lib.DatIconLoader.cs`
   — does it use a different read path that succeeds?)
2. **The DIDs are missing from this dat set.** Possible if the project
   was set up against a partial/older highres pack. Compare against
   another project's `dats/base/client_highres.dat` (e.g.
   `EnvCellMoveExport/`) — diff sizes, count entries, verify a known
   failing DID exists.
3. **DXT format edge case.** Less likely now that we added DXT1/3/5,
   but if a particular DXT variant has alignment that our decoder
   mishandles, `TryGet` may succeed but the format dispatch could
   throw. Confirm by adding `decoderThrew` per-format counter.

### Plan

1. Pick one failing DID from a logged sprite, e.g. read
   `Surface(0x08010xxx).OrigTextureId.DataId` then walk to
   `SurfaceTexture.Textures[^1]`. Hex-dump that DID's blob via
   `dats.TryGetReader(did, out var reader)` (whatever low-level API
   exists) and confirm:
   - The blob exists at all (rules out hypothesis 2).
   - Header bytes 0..16 vs what `RenderSurface.Read` expects.
2. If hypothesis 1: bypass `TryGet<RenderSurface>` and parse the blob
   directly into our own RGBA. Use `WorldBuilder/Lib/DatIconLoader.cs`
   as the reference implementation — it reads RenderSurfaces for icons
   and apparently succeeds.
3. If hypothesis 2: pull a known-good `client_highres.dat` from another
   project (or back from a fresh AC install) and compare.

## 2. Terrain renderer is base-texture only — no overlays, no roads

> **Update 2026-05-01:** Holtburg-only emit confirmed the per-corner base
> sampler **already produces detailed terrain** (real grass, dirt, forest,
> water tiles all visible). The earlier "all flat dark blue" was just
> because the previous run had only reached SW ocean LBs. The remaining
> gap to painter parity is **on-terrain road bands** and the smooth
> alpha-mask blends between adjacent terrain types — both are real but
> the visual delta is smaller than first feared.

### Diagnosis

The painter (`WorldBuilder/Editors/Landscape/LandSurfaceManager.cs`)
loads three texture atlases per region:

| Atlas | Layers | Source | Used for |
|---|---|---|---|
| `terrainAtlas` | 36 (RGBA8 512²) | `TexMerge.TerrainDesc` | Per-cell base terrain |
| `alphaAtlas` (terrain) | 16 (RGBA8 512²) | `TexMerge.CornerTerrainMaps` + `SideTerrainMaps` | Smooth blends between adjacent terrain types |
| `alphaAtlas` (road) | (shared) | `TexMerge.RoadMaps` | Road masks |

Per vertex (`FillVertexData:284`) the painter writes a **base** UV +
up to **3 overlay** UVs + up to **2 road overlay** UVs, each with an
alpha-mask atlas index. The fragment shader composites them.

Our renderer (`WorldBuilder.Terminal/RenderPreviewRenderer.cs:419`)
calls `SampleTerrainAt(types[corner], worldX, worldY, tileWu)` four
times and bilinearly interpolates. **Only the base texture is sampled.**
No overlays. No roads. No alpha-mask blending.

That is why the rendered tiles look like flat-tiled base textures
without the gradient transitions and road banding the painter shows.

`TerrainTextureLoader` itself only loads `TerrainDesc` — never reads
`RoadMaps`, `CornerTerrainMaps`, or `SideTerrainMaps`.

### Plan

1. Extend `TerrainTextureLoader` to also load:
   - `RoadMaps` → `Tile[]` indexed by `TextureId`
   - `CornerTerrainMaps` → `Tile[]` indexed
   - `SideTerrainMaps` → `Tile[]` indexed
   These are the **alpha masks** — they're greyscale, used to blend
   neighbors. `LandSurfaceManager.GetAlphaTexture(...)` shows the painter
   reads them as RGBA but treats one channel as alpha.
2. Surface `TextureMergeInfo` to the renderer. The painter resolves it
   per-cell via `SurfacesBySurfaceNumber[surfaceNumber]` where
   `surfaceNumber` comes from the landblock's `Cells[].SurfNum`. Mirror
   that lookup in our `RenderPreviewRenderer`.
3. Rewrite `SampleTerrainAt` to do the painter's composite pipeline on
   CPU for one pixel:
   1. Sample the base.
   2. For each of up to 3 overlays: sample overlay color + sample
      corresponding corner/side alpha mask + alpha-blend onto base.
   3. For each of up to 2 road overlays: sample road color + sample
      road alpha mask + alpha-blend onto current.
   4. Return the final RGB.
4. Verify a known-textured land region (Holtburg LB) matches a
   screenshot from the painter.

### Notes / risks

- This roughly doubles per-pixel terrain cost (was 4 samples / pixel,
  becomes ~12 in the worst case). At z=12 the doc already flags 67M
  pixels × 4 samples per LB; this would be ~67M × 12. Plan for
  emit time roughly 3× current. Can mitigate with mipmapped lower-res
  texture caching for distant zooms.
- Corner/Side alpha selection logic depends on the **rotation** byte
  from the landblock cell record. The painter's
  `LandUVsRotated[rotIndex]` mirrors that — port carefully or output
  will swirl/blur at LB seams.
- Road overlays interact with terrain overlays in a defined order
  (terrain first, then road on top). Honour that.

## Out of scope tonight

- Both fixes are real engineering, not flag flips. They land tomorrow.
- The current overnight chain will produce
  `dist-fresh/projects/vanilla/tiles/` with **textured walls + flat
  roofs + base-only terrain**. That's the visible improvement we
  should have on wake — useful for comparing tomorrow's fixes against.
