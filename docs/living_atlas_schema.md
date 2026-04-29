# Living Atlas — `describe-landblock` schema (v1)

This is the contract for the `describe-landblock` JSON command. Downstream
consumers (V6 placer atlas-conditioning, the WB.Terminal verbal+visual atlas
product, and per-LB explainability/validation overlays) pin against the
guarantees and per-field tags in this document.

- Version: **v1** (frozen 2026-04-29; bump on any non-additive change)
- Source of truth: `WorldBuilder.Terminal/JsonCommandProcessor.cs:619-720`
  (wire format) and `WorldBuilder.Terminal/LandblockDescriber.cs:269-548`
  (composition).
- Empirical reference: `pipeline_data/reference/atlas_describe_v1.jsonl`
  (38,255 LBs of `RetailSmoke.wbproj`, 2026-04-29 dump). Note: the dump is a
  **slimmed projection** of the wire format — `dump_atlas_jsonl.py:slim`
  retains only `context.<KEEP_CONTEXT_FIELDS>` and the top-3 structures by
  `attributedCellCount` with `<KEEP_STRUCTURE_FIELDS>`. Fields outside that
  projection are not represented in the dump and were audited from
  `JsonCommandProcessor.cs` directly.

## JSON-encoding invariant — null-stripping

The `Serialize` path uses
`JsonSerializerOptions.DefaultIgnoreCondition = WhenWritingNull`
(`JsonCommandProcessor.cs:34`). **Null fields are dropped from the wire
format entirely** — they appear as absent keys, not as `"field": null`.
A consumer must treat "key absent" and "value null" as semantically
identical. This rule applies to every field tagged `best-effort` below.

## Per-field guarantee tags

| Tag             | Meaning                                                       |
|-----------------|---------------------------------------------------------------|
| `load-bearing`  | Always present and non-null for any valid LB.                 |
| `best-effort`   | Present when the source data exists; absent (null-stripped) otherwise. |
| `experimental`  | Subject to schema/value change without a version bump.        |
| `broken`        | Documented in the C# struct but never populated. See below.   |
| `deprecated`    | Will be removed in v2.                                        |

---

## Top-level fields

| Field              | Type    | Tag           | Origin                                  | Notes                                                   |
|--------------------|---------|---------------|-----------------------------------------|---------------------------------------------------------|
| `success`          | bool    | load-bearing  | dispatcher                              | Always true on the success path.                        |
| `command`          | string  | load-bearing  | dispatcher                              | Always `"describe-landblock"`.                          |
| `landblock`        | string  | load-bearing  | derived                                 | `0x{lbKey:X4}` form.                                    |
| `lbX`, `lbY`       | uint    | load-bearing  | request                                 | Values in `[0, 254]`; ground-truth when `LbKey(x,y) = (x<<8)|y`. |
| `context`          | object  | load-bearing  | composer                                | See **`context` block** below.                          |
| `terrain`          | object  | load-bearing  | terrain doc                             | See **`terrain` block**.                                |
| `body`             | object  | load-bearing  | landblock + ontology                    | See **`body` block**.                                   |
| `relations`        | string[]| load-bearing  | composer                                | Free-text relation lines. Empty array allowed.          |
| `verbal`           | string  | load-bearing  | composer                                | Single-paragraph description; never null/empty.         |
| `validation`       | object? | best-effort   | `ValidationEngine.ValidateAll`          | Null when caller passes `includeValidation=false` (transact-diff pre-state) or the validator throws. |

---

## `context` block

| Field                    | Type      | Tag           | Origin                                  | Empirical (n=38,255)                            |
|--------------------------|-----------|---------------|-----------------------------------------|-------------------------------------------------|
| `regionName`             | string    | load-bearing  | `region_gazetteer.json`                 | 100% present, 13 distinct values.               |
| `regionDescription`      | string?   | best-effort   | `region_gazetteer.json/regions[].description` | Present iff the region's JSON has a description.|
| `townName`               | string?   | best-effort   | `town_gazetteer.json`                   | 0.15% (57 LBs match a town anchor).             |
| `culture`                | string?   | best-effort   | `town_gazetteer.json/culture`           | 0.15% (only LBs with a town anchor).            |
| `gazetteerNotes`         | string?   | best-effort   | `town_gazetteer.json/notes`             | 0.15% (only when notes were curated).           |
| `knownPoiCount`          | int       | load-bearing  | `poi_gazetteer.json`                    | `≥0`; 0 when no POIs at this LB.                |
| `knownPois`              | object[]? | best-effort   | `poi_gazetteer.json`                    | Present iff `knownPoiCount > 0` (5.3% of LBs).  |
| `knownPois[*].title`     | string    | load-bearing  | acpedia                                 | 200+ distinct values.                           |
| `knownPois[*].categories`| string[]  | load-bearing  | acpedia (may be empty array)            | 167 distinct categories; 40% of POI entries have an empty categories array. |
| `knownPois[*].description`| string?  | best-effort   | acpedia                                 | Wiki body excerpt; null on stub pages.          |
| `biome`                  | string    | load-bearing  | region override → terrain inference     | 8 distinct values: `mixed`, `temperate`, `barren`, `desert`, `mixed-watery`, `swamp`, `varied`, `watery`. Region override wins when set. |
| `biomeConfidence`        | double    | load-bearing  | `[0, 1]`                                | Forced to `1.0` when the region gazetteer supplied biome (~100%). Otherwise `top_terrain_share`. |
| `hasRoad`                | bool      | load-bearing  | terrain doc                             | True iff any vertex has `Road != 0` (3.4% of LBs).|
| `settlementHint`         | string?   | best-effort   | derived from `structureCount`           | Two values: `"isolated structure(s)"`, `"settlement (≥3 structures)"`. Null on `structureCount==0` (95.7% of LBs). |
| `dominantArchitecture`   | string    | load-bearing  | `townContext ?? regionContext ?? per-LB inference` | 10 distinct values. The per-LB inference path is **broken** (see O3 below) — every populated value comes from town or region context. |
| `structureCount`         | int       | load-bearing  | composer                                | `≥0`; equals `body.structures.length`.          |
| `dominantTerrainTypes`   | object[]  | load-bearing  | terrain doc + Region terrain-name table | Up to 3 entries; sorted desc by `vertexCount`.  |
| `dominantTerrainTypes[*].type` | int        | load-bearing | terrain doc                       | 0–80 (terrain index byte).                      |
| `dominantTerrainTypes[*].name` | string?    | best-effort  | Region terrain-name table         | Null when the LB's Region object lacks a name table; ~25 distinct names in the dump. |
| `dominantTerrainTypes[*].vertexCount` | int | load-bearing | terrain doc                  | `[1, 81]` (9×9 grid).                           |
| `dominantTerrainTypes[*].share`       | double | load-bearing | derived                       | `vertexCount / 81`; `[0, 1]`.                   |

### Validation rules (context)

- `biomeConfidence ∈ [0, 1]`.
- `structureCount == body.structures.length`.
- `townName != null  ⇒  culture != null` (the town gazetteer always carries a culture).
- `townName != null  ⇒  lbKey ∈ town_gazetteer`.
- `knownPois != null  ⇔  knownPoiCount > 0`.
- `dominantTerrainTypes.length ∈ [0, 3]` and `Σ share ∈ [0, 1]`.

---

## `terrain` block

| Field          | Type   | Tag           | Origin              | Notes                                       |
|----------------|--------|---------------|---------------------|---------------------------------------------|
| `heightMin`    | double | load-bearing  | terrain doc         | Z in world units, rounded to 2 decimals.    |
| `heightMax`    | double | load-bearing  | terrain doc         | `≥ heightMin`.                              |
| `heightRange`  | double | load-bearing  | derived             | `heightMax - heightMin`.                    |
| `cliffCount`   | int    | load-bearing  | derived             | 4-neighbour `|Δheight_byte| > 6` count.    |
| `vertexCount`  | int    | load-bearing  | terrain doc         | Always 81 for valid LBs (9×9 grid).         |
| `summary`      | string | load-bearing  | derived             | One-line English; relief × type × road × cliffs. |

---

## `body` block

| Field                      | Type    | Tag           | Origin                | Notes                                      |
|----------------------------|---------|---------------|-----------------------|--------------------------------------------|
| `objectTotal`              | int     | load-bearing  | LB doc                | Includes ParticleEmitters; `objectIndex` excludes them. |
| `byCategory`               | object[]| load-bearing  | composer              | Per-category counts; ontology categories + `"Untagged"`. |
| `byCategory[*].category`   | string  | load-bearing  | ontology              |                                            |
| `byCategory[*].count`      | int     | load-bearing  | derived               |                                            |
| `structures`               | object[]| load-bearing  | ontology Structure    | See **`structures[*]`** below.             |
| `looseObjectCount`         | int     | load-bearing  | composer              | Objects not absorbed into a structure.     |
| `looseZBands`              | object[]| load-bearing  | derived               | Z-clusters of loose objects, gap=3u.       |
| `untaggedIndices`          | int[]   | load-bearing  | composer              | Object indices with no ontology entry.     |
| `interior`                 | object? | best-effort   | dungeon doc           | Present iff dungeon doc has cells.         |
| `interior.cellCount`       | int     | load-bearing  | dungeon doc           |                                            |
| `interior.zMin`/`zMax`/`zRange` | double | load-bearing | dungeon doc        |                                            |
| `interior.zBandCount`      | int     | load-bearing  | derived               |                                            |
| `interior.cellGraphEdges`  | int     | load-bearing  | dungeon doc           | Sum of inter-cell portal links.            |
| `interior.exteriorPortals` | int     | load-bearing  | derived               | CellPortals pointing outside the dungeon set. |
| `interior.staticObjectCount`| int    | load-bearing  | dungeon doc           |                                            |
| `namedObjects`             | object[]| load-bearing  | wcid_acpedia_join.jsonl| Filtered to HIGH/MED tier and name-consistent matches. Empty array when project lacks Acpedia join. |
| `spawnCount`               | int     | load-bearing  | spawn_gazetteer.json  | `≥0`; 0 when no LSD spawnMap data.         |
| `spawns`                   | object[]| load-bearing  | spawn_gazetteer.json  | Filtered to player-visible weenies.        |

### `body.structures[*]`

| Field                | Type      | Tag                  | Origin                          | Notes |
|----------------------|-----------|----------------------|---------------------------------|-------|
| `index`              | int       | load-bearing         | LB doc                          | Object-list index. |
| `modelId`            | string    | load-bearing         | LB doc                          | `0x{id:X8}`. |
| `typeDescription`    | string    | load-bearing         | composer                        | Human-readable type label. |
| `origin`             | object    | load-bearing         | LB doc                          | `{x,y,z}`, world coords. |
| `footprintShape`     | string    | load-bearing         | ontology + on-demand FootprintExtractor | `Hexagon`, `Octagon`, `Quad`, `Unknown`, ... |
| `floorZ` / `topZ`    | double    | load-bearing         | derived                         |       |
| `architecture`       | string?   | **broken**           | `entry.Architecture`            | **0% populated across 3,517 entries.** Root cause: the architecture classifier (canonical / unified ontology JSON build) does not assign `architecture` to Structure-category setups. The 8 ontology entries with non-null Architecture in `RetailSmoke` are misclassified equipment items (e.g. "Tower Shield"). See O3 below. |
| `stories`            | int?      | best-effort          | model vertex Z-histogram        | 4.7% absent (Z analysis fallback). Range observed: 1–20. |
| `playableFloors`     | int?      | **deprecated**       | always null                     | Hard-coded `null` at `LandblockDescriber.cs:396`. Will be removed in v2. Use `attributedCellCount` if you need a per-building cell signal. |
| `roofShape`          | string?   | best-effort          | model top/base XY ratio         | 4 distinct values: `pitched`, `tapered`, `flat`, `spire`. 0.5% absent (single-band models). |
| `attributedCellCount`| int       | load-bearing         | dungeon doc + footprint         | `≥0`; `>0` when this structure absorbs ≥1 dungeon cell. |
| `materialTags`       | string[]? | **broken**           | `entry.MaterialTags`            | **0% populated across 3,517 entries.** Root cause: `EnrichMaterials` (the only setter) is not invoked by default project load, and even when invoked, its texture-classification heuristics are stubs (`OntologyService.cs:855` is empty; `ClassifySurfaceByRange` only adds `"textured"`). See O3 below. |
| `nameHint`           | string?   | best-effort          | ontology Name → tag fallback    | Falls back through `entry.Name`, then keyword-tag match (`tavern`/`tower`/...), then `dat:building` → `"building"`. |
| `tags`               | string[]  | load-bearing         | ontology                        | Empty array allowed. 17 distinct values in the dump. |
| `containedIndices`   | int[]     | load-bearing         | composer                        | Object indices the building absorbed. |
| `zBands`             | object[]  | load-bearing         | derived                         | Z-bands of contained objects. |
| `footprintWorld`     | object[]? | best-effort          | composer                        | Present iff `includeFootprints=true` in request; null otherwise. |

### Validation rules (body)

- `objectTotal ≥ structures.length + looseObjectCount + untaggedIndices.length` (untagged ⊆ loose ∪ unclassified, depending on category).
- `Σ structures[*].attributedCellCount ≤ interior.cellCount` when interior exists.
- `interior != null  ⇔  dungeon doc has ≥1 cell`.
- `spawns.length == spawnCount`.
- `footprintWorld != null  ⇔  request.includeFootprints == true`.

---

## `validation` block

| Field                         | Type     | Tag          | Origin                |
|-------------------------------|----------|--------------|-----------------------|
| `isValid`                     | bool     | load-bearing | `ValidateAll`         |
| `errorCount` / `warningCount` / `infoCount` | int | load-bearing | `ValidateAll` |
| `diagnostics`                 | object[] | load-bearing | `ValidateAll`         |
| `diagnostics[*].severity`     | string   | load-bearing | `error`/`warning`/`info` |
| `diagnostics[*].code`         | string   | load-bearing | ~45 codes across DNG/LBK/TRN/BSH/BLD |
| `diagnostics[*].message`      | string   | load-bearing |                       |
| `diagnostics[*].context`      | string?  | best-effort  | per-diagnostic        |

`validation` itself is `best-effort` at the top level — null when the
caller asked for `includeValidation=false` or when `ValidateAll` raised
(soft-fail; no field on the result indicates *why* it's null).

---

# Bug-tracking entries

## O3a — `body.structures[*].architecture` is 100% null

**Status**: broken, **deferred**.

**Root cause**: `OntologyService.EnrichFromCanonical` (line 1052) reads
`architecture` from the canonical enrichment JSON; `EnrichFromUnified`
(line 1235) reads `architectures` from the unified ontology JSON. Neither
upstream JSON has architecture data for Structure-category setups —
empirical scan of `RetailSmoke/ontology_cache.jsonl`:

- 523 Structure entries
- 8 (1.5%) have non-null Architecture, all of which are **misclassified
  equipment items** ("Tower Shield" → Architecture=`Neutral`, etc.) that
  got tagged Structure by some other path.
- 0 of the 523 have non-empty MaterialTags.

There is no code path in C# or in `scripts/build_unified_ontology.py`
that assigns Architecture to a building based on its setup/model
properties (textures, geometry, naming). The describer's per-structure
`architecture` is therefore always null on real buildings.

**Why downstream still sees architecture-by-region**: `context.dominantArchitecture`
falls back through `townContext.Culture → regionContext.Culture →
per-structure dominant architecture` (`LandblockDescriber.cs:457`).
The first two cover all 13 regions × 58 towns, so the LB-level field is
~100% populated even though the per-structure field is 0%. Consumers
that want a per-building architecture get nothing; consumers that want a
per-LB architecture get the regional culture override.

**Fix plan (v2)**:
- (Required) Add a building-architecture classifier upstream of
  `build_unified_ontology.py` that maps Structure setup IDs to one of the
  10 known architecture cultures using retail building name tables.
  After re-running `scan-ontology` + `enrich-unified`, the field becomes
  populated and graduates to `best-effort`.
- (Alternative) If no classifier is built before V7 trains, drop
  `architecture` and `materialTags` from `StructureBlock` and from V6
  atlas vocab in `build_atlas_context.py`.

**Don't fix mid-V6**: the V6 atlas vocab is already pinned (the field is
currently absorbed as the `<UNK>` token). Removing the field changes the
context-vector shape and forces a re-dump + re-train.

## O3b — `body.structures[*].materialTags` is 100% empty

**Status**: broken, **deferred**.

**Root cause**: `OntologyService.EnrichMaterials` (line 745) is the only
setter. It is not invoked by `Load()` or by any auto-loader — it requires
an explicit `enrich-materials` JSON command. Even when run, its
heuristics are stubs:

- `ClassifyTextureById` (line 844) has a single empty branch and never adds anything.
- `ClassifySurfaceByRange` (line 863) only adds `"textured"` for any 0x08-prefixed surface — not a real material classification.

So `materialTags` is **broken-by-construction**: there is no real
texture→material mapping in the codebase.

**Fix plan (v2)**: same as O3a — either build a real material classifier
that reads the AC retail texture name table, or remove the field.

## O6 — 10 LBs failed to load (0.026%)

**Status**: low-priority categorization.

The 10 failing LBs from `/tmp/atlas_dump.stderr`:

```
0x2380, 0x2381, 0x2480, 0x2481, 0x2482, 0x2581, 0x2681, 0x277A, 0x287A, 0xA7B3
```

Nine cluster in `(lbX=35..40, lbY=122..130)` — a contiguous oceanic patch
in the western Direlands border. The tenth (`0xA7B3`) is also off-shore.
**Category: edge-of-world**. These coordinates appear in the V4 tensor
file `lb_coords` (the dump source) but the underlying retail cell.dat
has no LandBlock entry for them — `LandblockDocument.Load` returns null
or throws because `dats.TryGet<LandBlock>(0x{lbKey}FFFF)` returns false.

**Fix plan**: The dumper should pre-filter `lb_coords` against the cell.dat's
landblock-id set so these never get queried. No code change in
WorldBuilder.Terminal is needed; this is an upstream pipeline data-set
hygiene issue (the V4 tensor build included synthetic ocean tiles).

# Stdin-mode parity fix (O2) — landed in this review

The bug: `Program.cs` pre-loaded a project via
`projectManager.LoadProject(path)` directly, bypassing
`CommandEngine.Load()` and its three auto-loaders (ontology cache,
building pairings, town gazetteer). In stdin mode this surfaced as a
silent-bug class — the most recent victim was `settlementHint`, always
null because no object got tagged `Category="Structure"` without the
ontology cache.

The fix: introduce `JsonCommandProcessor.Preload(path)` and
`TerminalRepl.Preload(path)` that simply call `_engine.Load(path)`.
`Program.cs` now constructs the processor/REPL **first**, then preloads
through them so the same code path the JSON `load` command uses also
runs at startup.

The five lazy-load blocks in `CommandEngine.DescribeLandblockFromDocs`
(lines 707-780) remain in place — they handle the
`poi_gazetteer.json` / `wcid_acpedia_join.jsonl` /
`spawn_gazetteer.json` / `region_gazetteer.json` files that
`Load()` itself never auto-loaded. Until `Load()` is extended to cover
those four (a separate change), the lazy-loads are still load-bearing
scaffolding for any code path that bypasses startup pre-load (e.g.
the JSON `load` command followed immediately by `describe-landblock`
without an intervening REPL session, or transact-diff describing
pre-state docs through `DescribeLandblockFromDocs`).

**Recommended v2 follow-up**: extend `CommandEngine.Load()` to also
auto-load the four gazetteers, then delete the corresponding lazy-load
blocks in `DescribeLandblockFromDocs`. This collapses the parity surface
to one entry point.

# Stdout hygiene fix (O4) — partial

The hot-path bug: `OntologyService.LoadFromCache` (line 1514) wrote
`"Skipping malformed cache line: ..."` to **stdout**, which would
poison the JSON stream the next time the lazy-load fired on a corrupt
cache file. Fixed in this review (now writes to `Console.Error`).

**Remaining sites** (98 `Console.WriteLine` calls in
`WorldBuilder.Shared`, all reachable from at least one stdin JSON
command — `scan-ontology`, `enrich-{materials,canonical,unified,weenies,ontology}`,
`import-catalog`, `cache-ontology`, `analyze-dungeon-{topology,catalog}`,
`worldgen-analyze-buildings`, `worldgen-scan-retail-towns`, the export
path):

| File                                                  | Sites |
|-------------------------------------------------------|-------|
| `Services/OntologyService.cs`                          | 30    |
| `Lib/WorldGen/BuildingAnalyzer.cs`                     | 38    |
| `Lib/Dungeon/DungeonRoomAnalyzer.cs`                   | 10    |
| `Lib/Dungeon/DungeonTopologyAnalyzer.cs`               | 7     |
| `Models/Project.cs` (export path)                      | 6     |
| `Lib/WorldGen/RetailTownBuildingScanner.cs`            | 4     |
| `Lib/WorldGen/TownDecorationCatalog.cs`                | 1     |
| `Lib/WorldGen/BuildingPlacer.cs`                       | 1     |

These sites pollute stdout only when a stdin JSON client invokes the
corresponding command. The dumper that produced
`atlas_describe_v1.jsonl` only invokes `describe-landblock`, so these
sites never fired on the V6 dump — but any client that calls
`scan-ontology` or `enrich-*` over stdin will see prose mixed into its
JSON stream.

**Fix plan (mechanical)**: replace `Console.WriteLine` with
`Console.Error.WriteLine` everywhere in `WorldBuilder.Shared/`. Every
site is a progress/diagnostic log; none is wire-format output. The
existing `Console.Error.WriteLine` calls in
`CommandEngine.cs:121-152` and `OntologyService.cs:1521` are the model.
This is ~98 mechanical replacements with zero risk of behavioral change
for the REPL (where stderr renders to the same terminal).

---

# What this review did NOT touch

- **`describe-landblock` JSON wire format**: unchanged (V6 atlas vocab is
  pinned to it).
- **`LandblockDescriber.cs` composition**: unchanged. No new fields, no
  splitting.
- **The 5 lazy-load blocks**: unchanged. Still load-bearing until the v2
  follow-up extends `CommandEngine.Load()` to cover the four gazetteers.
- **The verbal text generator**: unchanged. Not in scope; null-safety on
  fields O1 marks unpopulated should be a separate audit when any field
  graduates from `broken` to populated.
- **V6 trainer code (`scripts/PopulationPipeline/OutdoorML/`)**:
  unchanged. Atlas vocab and tensor schema are downstream of this
  review and must not be regenerated mid-V6 training.

# Files modified by this review

| File                                                       | Change |
|------------------------------------------------------------|--------|
| `WorldBuilder.Terminal/Program.cs`                         | Stdin and interactive pre-load now go through `processor.Preload` / `repl.Preload`. |
| `WorldBuilder.Terminal/JsonCommandProcessor.cs`            | Added `public LoadResult Preload(string)` → `_engine.Load(path)`. |
| `WorldBuilder.Terminal/TerminalRepl.cs`                    | Added `public LoadResult Preload(string)` → `_engine.Load(path)`. |
| `WorldBuilder.Shared/Services/OntologyService.cs`          | `LoadFromCache` malformed-line warning routes to stderr instead of stdout. |
| `docs/living_atlas_schema.md`                              | This document. |
