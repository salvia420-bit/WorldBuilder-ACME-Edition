# Re-emitting the Living Atlas after the visual fixes

These changes overhaul the visual atlas tile pipeline:
- Floor PNGs anchored to LB extent so top/bot no longer shifts buildings.
- Tile pyramid split into separate `terrain/` + `objects/` (glyph) + `object/` (sprite) layers; floor mode hides the object layers and keeps terrain.
- Sprite tier downsampled to `minZoom` (was z≥11), so building textures appear at all zoom levels.
- Spawn-gazetteer NPCs / creatures / quest items render alongside static objects.
- Real Asheron's Call terrain tiles sampled per-pixel from `Region 0x13000000 → TerrainInfo → LandSurfaces → TexMerge` (palette stays as fallback).
- `BelowNormal` process priority + a `throttleMs` knob on `emit-tile-pyramid`, `emit-static-site`, and `generate-object-sprites` so the renderer co-exists with the ML run.

Existing dists ship the old `tiles/exterior/` layer that is no longer emitted. They need a fresh static-site emit before the frontend renders correctly.

## Re-emit (recommended)

JSON, while the ML run is in flight:

```json
{"command":"emit-static-site","projectSlug":"vanilla","outDir":"dist","emitObject":true,"emitFloor":true,"throttleMs":50}
```

`throttleMs:50` sleeps 50 ms between LBs and pairs with the auto-applied `BelowNormal` priority. Bump it (e.g. `200`) if the ML run is still seeing throughput drops; drop to `0` when the box is idle.

If the project doesn't have a sprite atlas yet:

```json
{"command":"generate-object-sprites","throttleMs":20}
```

(then re-run `emit-static-site`).

If the dist already has an old `tiles/exterior/` directory, delete it after the new emit — it's stale and the frontend no longer references it:

```bash
rm -rf dist/projects/<slug>/tiles/exterior
```

## What the frontend now expects

```
dist/projects/<slug>/tiles/
  terrain/{z}/{x}/{y}.png    # terrain raster + roads, opaque
  objects/{z}/{x}/{y}.png    # object glyphs only, transparent terrain
  object/{z}/{x}/{y}.png     # sprite-mode (textured) — all zooms now
  floor/<lbHex>/<z>/<x>/<y>/<floor>.png
```

Floor selector behaviour:
- `terrain` stays visible (surface context for the dungeon).
- `objects` and `object` are removed when a floor is opened so building roofs no longer occlude the floor plan.

## Scaling and performance notes

- The terrain raster now does four texture samples per pixel. At z=12 (one LB = 4096 px) that's ~67M pixels × 4 samples per LB; expect ~2× the per-LB wall time of the previous procedural-palette path. The split-layer extra render adds another ~1× of object-only raster.
- AC tile period is hard-coded to 24 wu (one cell). Override via `RenderPreviewRenderer.Input.TerrainTileWu` if a project uses different terrain scales.
- `[TerrainTex] Loaded N tiles, M failed` lands on stderr at first render after project load. RetailSmoke's vanilla dat reports `33 tiles, 0 failed`.

## Files this work touched

- `WorldBuilder.Terminal/RenderPreviewRenderer.cs` — `LayerMode`, spawn-glyph pass, terrain texture sampling.
- `WorldBuilder.Terminal/DungeonRenderer.cs` — `Input.UseLbExtent` for tile-pyramid alignment.
- `WorldBuilder.Terminal/TerrainTextureLoader.cs` — new; decodes `Region` → terrain tile RGBA.
- `WorldBuilder.Terminal/CommandEngine.cs` — three-layer pyramid emit, throttle, spawn category mapping, terrain texture cache.
- `WorldBuilder.Terminal/ObjectSpriteGenerator.cs` — inter-sprite throttle.
- `WorldBuilder.Terminal/JsonCommandProcessor.cs` — `throttleMs` parameter on the emit commands.
- `WorldBuilder.Terminal/StaticSiteEmitter.cs` — pass throttle through to the pyramid emitter.
- `WorldBuilder.Terminal/StaticSite/app.js` — three-layer install, floor-mode visibility flip.
