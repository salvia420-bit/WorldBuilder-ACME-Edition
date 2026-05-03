# Static-Site Scene Quality — Agent Action Plan

## Context

`emit-static-site` now produces a Leaflet pyramid backed by a variant-aware sprite atlas. `Setup` resolves through the full surface chain (`0x05`/`0x06`/`0x08`/`0x15`/`0x16`/`0x17`/`0x18`); `ClothingTable` substitutions and `PalSet` palette overlays paint correct NPC variants; `PhysicsScript` particle puffs land on portals and braziers; `GfxObjDegradeInfo` is wired as an opt-in `lodLevel` parameter; pixel-format coverage now includes DXT2/4 and 1-5-5-5 / 8-3-3-2 layouts. The full RetailSmoke pool (5,391 setups → 5,283 sprites, 32k×8k atlas) regenerates clean with diagnostic visibility through the heartbeat + per-200 progress lines and a final `[SurfaceDiag]` summary.

A re-audit of `external/DatReaderWriter/DatReaderWriter.Tests/DBObjs/` puts consumed types at **25 of 52**. The 27 remaining types fall into three buckets:

1. **Scene-fidelity** types whose absence makes NPCs T-pose, terrain bare, dungeons unreadable: `Animation`, `MotionTable`, `Scene`, `Region.SceneInfo`, `EnvCell`.
2. **World-orientation** types whose absence leaves the map an unlabeled grid: `Region.RegionName`, `StringTable`, `LanguageString`, sign-bearing weenie property strings.
3. **Gameplay metadata** types out of scope for top-down rendering: `CombatTable`, `ExperienceTable`, `SkillTable`, `SpellTable`, `VitalTable`, `ContractTable`, `TabooTable`, `QualityFilter`, `Wave`/`SoundTable` (audio only).

The objectives below address buckets (1) and (2) plus the frontend gaps that turn the rendered tiles into a navigable atlas instead of a contiguous-but-context-free image pyramid.

**Concurrent activation gap:** the variant rendering pipeline ships disabled because the on-disk `weenie_index.jsonl` (43,911 entries) was ingested before `ClothingBaseDid`/`PaletteTemplate` were added to the record schema. The SQL `IngestWeenieIndexAsync` already pulls the new columns; re-ingest against the ACE world DB is the precondition for measuring any variant-touching work below against a meaningfully different baseline.

## Intent

Bring `emit-static-site` from "every object renders with the right shape and texture" to "the map reads like a published AC atlas — NPCs stand in idle poses, forests look forested, regions and signs are named, dungeons are explorable per floor, and a visitor can find what they're looking for without panning blindly." Within scope: pose selection, scene-driven terrain decoration, named-zone overlay, sign labels, multi-floor dungeon UI, multi-LOD atlas pyramid, search/index, time-of-day overlay, and asset compression. Out of scope: full 3D, animation playback over time, networking, real-time tile re-rendering, audio.

## Objectives

Execute in order — each unblocks the next or its measurement.

### 0. Activate the variant + LOD pipeline

**Preconditions:** none.

**Acceptance:** `WeenieIndex` re-ingested via `IngestWeenieIndexAsync` so `ClothingBaseDid` and `PaletteTemplate` populate from the ACE world DB. Re-run sprite-gen logs `[Sprites] Added N ClothingTable variant tuples` with N > 0. A second pass with `lodLevel: 2` produces `manifest_lod2.jsonl` + `atlas_lod2.png` whose total file size is < 50% of the LOD-0 atlas.

**Files:** `WorldBuilder.Shared/Lib/AceDb/AceDbConnector.WeenieIndex.cs` (already extended; needs DB connection), `WorldBuilder.Terminal/CommandEngine.cs:11367-11425` (extend `GenerateObjectSprites` to write LOD-tagged manifest/atlas paths when `lodLevel > 0` and to thread the param through), `WorldBuilder.Terminal/JsonCommandProcessor.cs:509` (expose `lodLevel` on the JSON command).

**Verification:** Diff sprite counts and file sizes between LOD-0 and LOD-2 atlases. Confirm the `wcid → SpriteKey` resolver produces variant keys for at least the canonical Royal Guard family by inspecting `AnalyzeSpawnSpriteCoverage` output for non-zero variant hits.

### 1. Animation/MotionTable idle poses for NPCs

**Preconditions:** Objective 0.

**Acceptance:** `TriangulateModel` consults `Setup.DefaultMotionTable[0]` (or per-WeenieType MotionTable from the ontology), reads `MotionTable.Cycles`/`Modifiers` to find the `Motion.Stand`/`Motion.Ready` entry, resolves to an `Animation`, samples `Animation.PartFrames[0]` to derive per-part `Frame.Origin`/`Orientation` deltas, and applies them on top of `Setup.PlacementFrames` before triangulation. Schema: `dats.xml:3639-3711`. Tests: `AnimationTests.CanReadEOR`, `MotionTableTests.CanReadEOR`. Bare props (no MotionTable) fall through to existing `PlacementFrames` resolution unchanged.

**Files:** `WorldBuilder.Terminal/ObjectSpriteGenerator.cs` (extend `TriangulateModel`/`GetDefaultPlacementFrame`).

**Verification:** Render Holtburg 3×3 with sprite-gen at `lodLevel: 0`. Town-guard sprites should show shoulders down, weapons hanging at hip, not the splayed arms-out T-pose. NPCs that lack MotionTable (vendors with rigid setups) render unchanged.

### 2. Scene-decorated terrain — render foliage / rocks via Region.SceneInfo

**Preconditions:** Objective 0 stable.

**Acceptance:** `TilePyramidEmitter`'s terrain pass consults the active `Region` (0x13) for `SceneInfo` (gated by `PartsMask.HasSceneInfo`), walks the resulting `Scene` (0x12) entries to extract per-cell scenery placements (each carrying a GfxObj/Setup ref + position + scale), and overlays them as small sprite blits onto the terrain layer at z ≥ 9. Spawning is deterministic per (cellId, sceneIndex) so re-renders match. Schema: `dats.xml:3842-3850` (Scene), `dats.xml:3847-3877` (Region). Tests: `SceneTests.CanReadEOR`, `RegionTests.CanReadEOR`.

**Files:** `WorldBuilder.Terminal/RenderPreviewRenderer.cs` (add scene decoration pass after terrain raster, before object glyphs), `WorldBuilder.Terminal/TerrainTextureLoader.cs` (extend to expose Region.SceneInfo + the resolved Scene set).

**Verification:** Render a heavily-forested LB (e.g. 0x1A23 Holtburg outskirts). Trees should appear as clustered scatter sprites, not bare grass. A second render with the same (project, LB) inputs produces an identical tile (deterministic).

### 3. Named-zone label overlay (region_gazetteer driven)

**Preconditions:** none of the above.

**Acceptance:** New per-site vector layer (`zones.geojson`) emitted alongside the tile pyramid. Source data: the existing `region_gazetteer.json` (13 entries — Direlands, Aerlinthe, Ispar, etc.) for centroids; per-zone polygons synthesized as a Voronoi tessellation of those centroids clipped to the world bounds (or convex hull of town gazetteer entries grouped by zone, when richer source data lands). Frontend renders this as a Leaflet GeoJSON layer with semi-transparent fills + outline + label centroid. Visible at z=6-9; hidden at z≥10 to avoid covering the sprite layer.

**Files:** `WorldBuilder.Terminal/StaticSiteEmitter.cs` (emit zones.geojson; Voronoi via a small dependency-free helper), `WorldBuilder.Terminal/StaticSite/app.js` + `index.html` (add Leaflet GeoJSON layer + zoom-bounded visibility).

**Verification:** Open the static site at z=7. Direlands, Aerlinthe, Ispar etc. show as labeled colored zones with reasonable boundaries. Zoom to z=11 — the layer fades out and sprites are fully visible.

### 4. Sign + landmark text labels (read InscriptionText)

**Preconditions:** Objective 0 (re-ingest) — extend the bulk weenie SQL to pull PropertyString.Inscription (id 16, per ACE) into the index.

**Acceptance:** `WeenieIndexEntry` gains `Inscription` (string?). Spawn glyph dispatch in `RenderPreviewRenderer` consults the entry; signs (WeenieType 27 — `Hook`/`Sign` family) render with a small italic label drawn next to the sprite at z ≥ 11. Town-name signs become legible at zoom 10+. Hover tooltip on the frontend shows the full Inscription text via the rendered `objects.geojson` properties; tooltip surfaces wcid + display name + inscription for any object with non-null inscription.

**Files:** `WorldBuilder.Shared/Lib/WeenieIndex.cs`, `WorldBuilder.Shared/Lib/AceDb/AceDbConnector.WeenieIndex.cs` (additive ingest of PropertyString.Inscription), `WorldBuilder.Terminal/RenderPreviewRenderer.cs` (sign label paint), `WorldBuilder.Terminal/StaticSite/app.js` (Leaflet tooltip layer fed from objects.geojson).

**Verification:** Render Holtburg town center. Tavern, smithy, vendor signs show their inscriptions as labels at z=11+. Hover any sign at any zoom — tooltip appears with the full text.

### 5. Multi-LOD sprite atlas swap in TilePyramidEmitter

**Preconditions:** Objective 0 (LOD-N atlases exist on disk).

**Acceptance:** `SpriteAtlasLoader.TryLoad(spritesDir, lodLevel)` opens the LOD-N file pair when present. `TilePyramidEmitter` selects atlas per zoom: LOD-0 at z ≥ 11, LOD-1 at z = 10, LOD-2 at z ≤ 9. Frontend tile size and atlas references stay constant — the LOD substitution is server-side at render time. Atlas total file size at `outDir/object/` drops by ≥ 35% for a full Dereth render (measured via `du -sh`).

**Files:** `WorldBuilder.Terminal/SpriteAtlasLoader.cs` (lodLevel param + per-LOD path), `WorldBuilder.Terminal/CommandEngine.cs` (`GetOrLoadSpriteAtlas` returns per-LOD instances; cache keyed by lodLevel), `WorldBuilder.Terminal/TilePyramidEmitter.cs` (zoom→LOD selector).

**Verification:** Render full Dereth at `maxZoom=12`. Compare object-tile total size against a baseline (LOD-0-only) render; expect a measurable drop. Visual A/B at z=8 — expected to be visually indistinguishable.

### 6. Indoor dungeon multi-floor renderer + floor-selector UI

**Preconditions:** none.

**Acceptance:** `DungeonRenderer` already clusters cells into floors via `LandblockDescriber.ClusterByCellZ`; extend to emit one tile-pyramid layer per floor under `outDir/dungeon/{lbHex}/floor{n}/`. `StaticSiteEmitter` writes a `dungeons.json` manifest mapping each indoor LB to its floor count + per-floor cell counts. Frontend gains a floor-selector dropdown that swaps the active dungeon layer when an indoor LB is in view; outdoor LBs ignore the selector.

**Files:** `WorldBuilder.Terminal/DungeonRenderer.cs` (per-floor emit loop), `WorldBuilder.Terminal/StaticSiteEmitter.cs` (dungeons.json + per-floor URL emit), `WorldBuilder.Terminal/StaticSite/app.js` (floor-selector widget; visibility gated on indoor-LB hover), `WorldBuilder.Terminal/StaticSite/index.html` (selector markup).

**Verification:** Open Holtburg Catacombs (LB 0xA9B4 family). Default view shows floor 0; selector cycles through floors 1-N with each showing a different cell layout. Outdoor LBs hide the selector.

### 7. Search + index static pages

**Preconditions:** Objective 4 (sign text + WeenieIndex enriched) so search hits include human-readable inscriptions and display names.

**Acceptance:** `emit-static-site` produces three additional view modes alongside the map: `index.html?view=npcs` (paginated table of NPCs by name + region + level), `?view=towns` (gazetteer by region with map links), `?view=dungeons` (dungeon list with floor counts + spawn density). Each row links to a deep-link map URL (`#lat,lng,zoom`). Search is client-side over a generated `search_index.json` (≤ 5 MB after gzip). One unified search bar across views.

**Files:** `WorldBuilder.Terminal/StaticSiteEmitter.cs` (emit search_index.json + view-template HTML or partials), `WorldBuilder.Terminal/StaticSite/app.js` + `index.html` (router for `view=` modes + search bar + result rendering).

**Verification:** Open the static site, click "NPCs" — table loads with all known NPCs. Type "Royal Guard" in search — table filters to matching rows. Click a row — map deep-links to that NPC's spawn coord at z=11.

### 8. Time-of-day overlay (lit windows + brazier glow)

**Preconditions:** Objective 5 (per-LOD atlas already in place so a "night" atlas variant can ship as a parallel pyramid).

**Acceptance:** Sprite-gen learns a `nightMode: true` flag that emits a parallel atlas (`atlas_night.png` + `manifest_night.jsonl`). In night mode, the renderer dims every base sample by a 0.4 multiplier, then overlays per-Setup `Lights` entries (already on the Setup record at `dats.xml:3624-3626`) as colored glow discs (warm yellow for default `Light.Color`, blue for ice/lifestone setups detected via WeenieType). `TilePyramidEmitter` gains a `mode: day|night` knob. Frontend toggle swaps day/night tile sets; the variant atlas pipeline carries through so variant NPCs also have a night variant.

**Files:** `WorldBuilder.Terminal/ObjectSpriteGenerator.cs` (night-mode render path; new helper `OverlayLights`), `WorldBuilder.Terminal/CommandEngine.cs` (night atlas emit branch), `WorldBuilder.Terminal/TilePyramidEmitter.cs` (mode parameter), `WorldBuilder.Terminal/StaticSite/app.js` (day/night toggle).

**Verification:** Toggle night mode in the frontend. Holtburg appears in dim blues with lit warm-yellow windows at the inn and guard tower, plus the orange glow of braziers visible at the gates.

### 9. WebP/AVIF asset compression

**Preconditions:** Objective 0 stable; perf-only, can run last.

**Acceptance:** `TilePyramidEmitter` writes WebP (lossless or quality=90) instead of PNG when `format: "webp"` is passed; atlas PNGs convert to WebP when `format: "webp"` on `generate-object-sprites`. Frontend autodetects via `<picture>` source priority. Total static site size for full Dereth shrinks by ≥ 35%.

**Files:** `WorldBuilder.Terminal/TilePyramidEmitter.cs` (encoder switch), `WorldBuilder.Terminal/ObjectSpriteGenerator.cs` (`PackAtlasStreaming` format param), `WorldBuilder.Terminal/StaticSite/app.js` (WebP detection + Leaflet layer URL template).

**Verification:** `du -sh outDir/` before vs after; expect ≥ 35% shrinkage. Visual A/B at z=12 — no perceptible quality loss.

## Why

Each objective ties to a concrete user-visible outcome:

- **Objective 0** — without re-ingest, none of Obj 1, 4, 5, 7 can be measured against a meaningfully different baseline. The WeenieIndex schema is already extended and the SQL ingest already pulls the new columns; this is gating activation, not new code.
- **Objective 1** — the most jarring static-site artifact today is NPCs in T-pose with arms straight out. A single MotionTable lookup turns "stick figures with weapons floating beside them" into "guards at parade rest". Highest impact-per-line change in the plan.
- **Objective 2** — Dereth's wilderness reads as bare grass without scene decoration. A scattered-foliage layer turns the map into a recognizable landscape instead of an aerial topographic survey, and finally activates `Scene` and `Region.SceneInfo` (two of the highest-impact unconsumed types from the audit).
- **Objective 3** — even players who know the world have to hover-and-guess where they are at low zoom. Named-zone labels make the map self-orienting from z=7 onward and use existing gazetteer data — no new ingest required.
- **Objective 4** — town signs are how AC players navigated cities. Reading the inscription and rendering it as a label turns the map into a working in-world directory; the underlying property string is already in the ACE DB and the WeenieIndex extension is one column wider.
- **Objective 5** — the LOD-0 atlas is ~180 MB. At z=8 each sprite renders to 1-2 px, so we're shipping 180 MB to produce ~5 KB of rendered pixels. Multi-LOD swap is a free 35%+ size win that also reduces render-pass memory pressure for low-zoom tile rendering.
- **Objective 6** — dungeons currently render as a flat union of all floors, which produces an unreadable spaghetti. Per-floor selector unlocks dungeon content as actual navigable maps, doubling the value of the existing `DungeonRenderer` work without new render code.
- **Objective 7** — the static site is currently scroll-only. Search + index pages turn it into a destination atlas you can land on with a query, not just a map you pan to find things in. Compounds with Obj 4 (signs become discoverable text).
- **Objective 8** — time-of-day toggle is the wow factor that demonstrates the depth of the underlying data. It also surfaces `Setup.Lights`, which would otherwise stay unused on top of the Setup pose and particle work.
- **Objective 9** — performance + bandwidth, lowest priority but compounds with deployment cost (CDN, mobile users). Unblocks shipping the full Dereth render as a downloadable static archive.

Together, **Objectives 1-4** close the visual-fidelity gap that makes the current `emit-static-site` read as "a tech demo of tile rendering"; **Objectives 5-7** close the UX gap that makes it read as "a viewer" instead of "an atlas"; **Objectives 8-9** are polish on top of a solid base.
