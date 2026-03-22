# WorldBuilder — To-Do List

> **Ultimate Goal**: AI-driven procedural generation of a complete Asheron's Call world that **rivals and exceeds** the original retail hand-crafted content.
> **Hardware path**: local i7-7700HQ (CPU-bound prototyping & data extraction) → 4×RTX 4090 cluster (safetensor-driven final pass).

---

## ⚠️ HONEST PROJECT STATUS (Read This First)

### What We Have (Genuinely Good)
The **tooling and infrastructure are exceptional** — 40+ terminal commands, validation engine, benchmarks, procedural terrain, a complete JSON-protocol agentic API, dungeon grammar engine, and settlement generator. Every pipeline compiles, runs, and has been tested.

### ✅ Retail Data Extraction — COMPLETE (2026-03-03)
The retail DAT files (`TestProject/dats/base/` = identical to `ac-updates/`) have been **fully processed** through the extraction pipeline:

| Dataset | Records | File | Size |
|---------|---------|------|------|
| **Object placement training data** | 49,921 examples from 2,563 populated landblocks | `retail_training_data.jsonl` | 27 MB |
| **Spatial pattern analysis** | 25,239 adjacency pairs, slope/orientation/clustering | `retail_patterns.json` | 20 KB |
| **Dungeon topology** | 3,405 dungeons, 729,888 cells | `retail_dungeon_topology.json` | 108 MB |
| **Dungeon room catalog** | 3,134 unique room templates | `retail_dungeon_catalog.json` | 3.8 MB |
| **Weenie summary** | 19,686 weenies, 19,684 with SetupDID (100%) | `weenie_summary.jsonl` | 2.5 MB |
| **Spawn map summary** | 1,162 maps, 54,197 placements, 8,072 unique WCIDs | `spawnmap_summary.jsonl` | 430 KB |
| **Retail heightmaps** | 65,025 landblocks (9×9 vertex grids) | `retail_heightmaps.jsonl` | — |
| **Vanilla baseline metrics** | Object density, terrain dist, height histogram, road coverage | `retail_baseline.json` | — |
| **Ontology** | 21,253 entries, 19,681 enriched (13% named) | Runtime | — |

### Remaining Gaps

| Gap | What It Means | Severity |
|-----|--------------|----------|
| **82 rich ontology entries vs 19,686 needed** | Only 82 objects have architecture/biome/placement tags. The rest have a name and type but no spatial intelligence for the settlement generator. | 🔴 Critical |
| **No creature-biome or difficulty gradient data** | We can't reproduce AC's signature "harder as you go further from town" design without this. Wiki data coming tomorrow. | 🟡 High |

### The Retail Data Sources
```
TestProject/dats/base/client_cell_1.dat — 348 MB (landblock geometry, heightmaps, static objects)
TestProject/dats/base/client_portal.dat — 927 MB (models, textures, dungeon rooms, animations)
ac-updates/                             — identical copies (same MD5 hashes)
LSD-Partial-2025-02-23_16-15/           — 19,686 weenies, 1,162 spawn maps, 7,347 recipes, 6,266 spells
```

**Priority order**: Retail data extraction (Phase 10.5a) → Ontology enrichment (Phase 10.5b) → Quality scoring (Phase 10.5c) → Model training prep (Phase 12) → GPU pipeline (Phase 13).

---

## ✅ Completed Infrastructure

<details>
<summary>Click to expand completed sections (all verified & tested)</summary>

### Logic Decoupling
- [x] Extract terrain algorithms into `WorldBuilder.Shared/Lib/Terrain/TerrainAlgorithms.cs`
- [x] Extract scenery placement into `WorldBuilder.Shared/Lib/Terrain/SceneryAlgorithms.cs`
- [x] Extract stamp paste into `WorldBuilder.Shared/Lib/Terrain/StampAlgorithms.cs`
- [x] Extract portal snapping into `WorldBuilder.Shared/Lib/Dungeon/PortalSnapAlgorithms.cs`
- [x] Extract dungeon room analysis into `WorldBuilder.Shared/Lib/Dungeon/DungeonRoomAnalyzer.cs`
- [x] Refactor all UI commands to delegate to shared algorithms

### WorldBuilder.Terminal — Scaffolding
- [x] `WorldBuilder.Terminal.csproj` targeting .NET 8
- [x] `Program.cs` with batch/REPL routing
- [x] `CommandLineArgs.cs` with `--project`, `--export`, `--iteration`
- [x] `HeadlessProjectManager.cs` with minimal DI container
- [x] `TerminalRepl.cs` with full command routing
- [x] Added to `WorldBuilder.slnx`

### Build Verification
- [x] .NET 8 SDK installed, full solution compiles
- [x] OntologyService compiles and DI wiring works
- [x] ACViewer Screenshot CLI compiles (0 errors)

### ACViewer Screenshot CLI (Tier 1)
- [x] CLI argument parser, screenshot orchestration, all render modes
- [x] Map, landblock, model, dungeon screenshots all tested ✅
- [x] 5-frame GPU countdown verified, batch mode implemented
- [x] Runtime crash fixes (path resolution, crash logging, texture guards)

### ACViewer Asset Catalog (Tier 2)
- [x] CatalogService batch-renders all Setup/GfxObj models
- [x] Per-model metadata + PNG thumbnails + master index.json
- [x] Tested: 3,005 PNGs generated from 5,935 Setups
- [x] OntologyService integration via `import-catalog` command

### WorldBuilder.Terminal — 40+ Commands
- [x] Terrain editing: `smooth`, `raise`, `lower`, `set-height`, `paint`, `fill`
- [x] Terrain queries: `get-height`, `terrain-info`
- [x] Roads: `road`
- [x] Objects: `list-objects`, `add-object`, `remove-object`, `move-object`
- [x] Dungeon: `analyze-dungeons`
- [x] Stamps & Portals: `paste-stamp`, `snap-portal`
- [x] State observation: `get-heightmap`, `get-terrain-data`, `list-landblocks`, `get-world-info`, `get-region`, `get-dungeon-info`, `get-bulk-heightmap`, `get-object-detail`, `get-terrain-layers`, `diff-terrain`
- [x] Validation: `validate-dungeon`, `validate-landblock`, `validate-terrain`, `validate-building-portals`, `validate-all` (30 diagnostic codes)
- [x] Ontology: `scan-ontology`, `query-ontology`, `ontology-stats`, `classify-ontology`, `enrich-ontology`, `enrich-materials`, `import-catalog`, `export-ontology`, `mine-strings`
- [x] DAT management: `export-textures`, `clone-dat`, `import-texture`, `defragment-dat`
- [x] Benchmarks: `benchmark`, `set-landblock-heightmap`, `set-landblock-terrain`, `bulk-place-objects`
- [x] Procedural terrain: `generate-terrain`, `auto-paint`
- [x] Data ingestion: `ingest-weenies`, `enrich-weenies`, `ingest-spawn-maps`, `ingest-spells`, `ingest-recipes`
- [x] Analysis: `analyze-landblock-patterns`, `export-training-data`, `analyze-dungeon-catalog`, `analyze-dungeon-topology`
- [x] Generation: `generate-settlement`, `generate-dungeon`
- [x] Data extraction: `extract-retail-heightmaps`, `compute-vanilla-baseline`

### Agentic Workflow Integration
- [x] JSON stdin protocol, `--json` flag, structured output
- [x] `docs/agent_api_reference.md` + `docs/agent_api_schema.json`
- [x] Test harness: PowerShell 25/25, Python 55+ tests

### Phase 7 — Speed Testing & Bulk Operations ✅
- [x] BenchmarkMode flag, results: 8,825 ops/sec (set-height), 786,839 vertices/sec (bulk), 91,197 ops/sec (add-object)
- [x] **Assessment: 🟢 GREEN — Full-scale generation feasible on commodity hardware**

### Phase 8 — Procedural Terrain Generation ✅
- [x] Simplex noise library with fBm octave layering
- [x] Coastline masking (ray-casting polygon containment)
- [x] `generate-terrain` command (noise params + coastline → 65K landblocks)
- [x] Height-to-texture auto-painting (`auto-paint` command)
- [x] Edge stitching validation, export & load testing

### Phase 6.5 — LSD Data Ingestion Pipeline ✅
- [x] `ingest-weenies` → 19,686 files, 19,684 with SetupDID (100%)
- [x] `enrich-weenies` → 19,681 enriched (13% named, 2.6% with levels)
- [x] `ingest-spawn-maps` → 1,162 maps, 54,197 weenies, 8,072 unique WCIDs
- [x] `ingest-spells` → 6,266 spells, 5 schools
- [x] `ingest-recipes` → 7,347 recipes, 7,323 with precursors

### Phase 9 — Procedural Dungeon Generation ✅
- [x] Dungeon room catalog extraction (`analyze-dungeon-catalog`)
- [x] Dungeon topology extraction (`analyze-dungeon-topology`)
- [x] Graph Grammar engine (L-System, 7 node types, seeded RNG)
- [x] `generate-dungeon` command (end-to-end pipeline)
- [x] Validation pass integrated

### Phase 10 — Spatial Data Extraction & Settlement Generator ✅
- [x] `analyze-landblock-patterns` — adjacency, slope, orientation, clustering
- [x] `export-training-data` — JSONL per object with full spatial context
- [x] `generate-settlement` — 5 templates, constraint enforcement, collision detection

</details>

---

## ✅ Phase 10.5a — Retail Data Extraction (COMPLETE)

> **COMPLETED**: 2026-03-03. TestProject already contained retail DATs (verified via MD5 hash match with `ac-updates/`).
> Full extraction pipeline executed successfully against real Asheron's Call world data.

### Task 1: Full extraction pipeline — ✅ COMPLETE

**Discovery**: `TestProject/dats/base/` contains the same retail DAT files as `ac-updates/` (MD5: `6401B73FD3842FFDB953339522A7331A`). No separate retail project needed.

**Pipeline executed**:
```
load TestProject/TestProject.wbproj
scan-ontology                              → 21,253 entries (5,935 Setups + 15,318 GfxObjs) in 9.5s
ingest-weenies LSD-Partial-...             → 19,686 processed, 0 errors, 19,684 with SetupDID (100%)
enrich-weenies ...                         → 19,681 enriched
ingest-spawn-maps LSD-Partial-...          → 1,162 maps, 54,197 weenies, 8,072 unique WCIDs
export-training-data 0 0 254 254           → 49,921 examples from 2,563 landblocks in 168s → 27MB JSONL
analyze-landblock-patterns 0 0 254 254     → 25,239 adjacency pairs in 1.6s → retail_patterns.json
analyze-dungeon-topology                   → 3,405 dungeons, 729,888 cells, 0 errors
analyze-dungeon-catalog                    → 3,134 unique room templates, 0 errors
ontology-stats                             → 13% named, 2.6% with levels, 36 weenie types
```

**Key findings from retail data**:
- **2,563 populated landblocks** out of 65,025 total (3.9% — rest is ocean/empty)
- **49,921 static objects** placed across the world
- **Slope distribution**: Flat 3%, Gentle 27%, Moderate 52%, Steep 17%
- **No compass orientation bias** (N:28%, E:24%, S:24%, W:24%)
- **3,845 object clusters**, average 13 objects/cluster, largest 6,694 (major city)
- **3,405 dungeons**: HubAndSpoke 52%, Complex 29%, Branching 15%, Linear 3%, Single 1%
- **3,134 unique room templates**: Hub 28%, Corridor 21%, DeadEnd 21%, Room 16%, Passage 11%, Isolated 3%

- [x] Load retail DATs (already in TestProject)
- [x] `scan-ontology` → 21,253 models
- [x] `ingest-weenies` + `enrich-weenies` + `ingest-spawn-maps`
- [x] `export-training-data 0 0 254 254` → `retail_training_data.jsonl` (27 MB, 49,921 examples)
- [x] `analyze-landblock-patterns 0 0 254 254` → `retail_patterns.json` (20 KB)
- [x] `analyze-dungeon-topology` → `retail_dungeon_topology.json` (108 MB, 3,405 dungeons)
- [x] `analyze-dungeon-catalog` → `retail_dungeon_catalog.json` (3.8 MB, 3,134 room templates)

### Task 2: Extract retail terrain baseline — ✅ COMPLETE

- [x] **`extract-retail-heightmaps` command** — dumps all 65,025 landblock heightmaps as JSONL
  - Each record: `{ lbX, lbY, lbKey, heightIndices: [81], heightsWorld: [81], terrainTypes: [81], roadFlags: [81] }`
  - Exported 65,025 landblocks in 2,982ms
- [x] Run against retail DATs → `retail_heightmaps.jsonl`
- [x] Terrain statistics computed via `compute-vanilla-baseline` (terrain type distribution, height histogram, road coverage)

### Task 3: Extract retail object density baseline — ✅ COMPLETE

- [x] **`compute-vanilla-baseline` command** — computes reference quality metrics from retail data:
  - Object density per populated landblock: mean, median, stddev, min, max
  - Object density by category (Scenery, Prop, Structure, Furniture, Creature, NPC, Portal)
  - Per-region statistics (8×8 macro-regions with avg density)
  - Terrain type distribution (global frequency)
  - Height distribution (16-bucket histogram)
  - Road coverage (percentage of vertices with road > 0)
- [x] Scanned 65,025 landblocks, 2,563 populated, 49,921 objects in 4,412ms → `retail_baseline.json`
- [x] These metrics become the **quality gates** for Phase 10.5c

---

## 🔲 Phase 10.5b — Ontology Enrichment at Scale

> **THE 82 vs 19,686 PROBLEM**: Only 82 objects have rich semantic tags. The auto-enrichment gives names and types, but not the architecture style, biome compatibility, or placement rules that the settlement generator needs.

### Task 1: AC Wiki Data Ingestion

> **STATUS**: User will prepare AC wiki data tomorrow. The wiki (asheron.fandom.com) contains structured pages for every creature family, town, dungeon, and cultural style.

**What the wiki provides**:
- Creature family → biome mappings (Drudges → temperate/forest, Tumeroks → highlands, etc.)
- Creature family → level ranges (Drudge Skulker 1-5, Drudge Stalker 15-20, etc.)
- Town names, locations, and cultural affiliations
- Dungeon names, level ranges, and themes (undead crypt, olthoi hive, etc.)
- Cultural architecture descriptions (Aluvian = medieval European, Sho = East Asian, Gharu'ndim = North African/Arabian)

- [ ] **Design wiki data format** — define JSON structure for wiki-sourced creature/town/dungeon data
- [ ] **`ingest-wiki-creatures` command** — parse wiki creature data → enrich ontology with biome and level range tags at the creature family level
- [ ] **`ingest-wiki-towns` command** — parse wiki town data → create a towns reference table with coordinates, culture, and size
- [ ] **`ingest-wiki-dungeons` command** — parse wiki dungeon data → enrich dungeon catalog with themes and level ranges
- [ ] Potentially: **wiki scraping utility** — if feasible, a script to extract structured data from wiki pages automatically

### Task 2: ACE Source Code Auto-Tagging

> **AVAILABLE DATA**: `WeenieClassName.cs` has 31,120 entries with naming patterns like `aluvianhouse`, `sholantern`, `gmdoor`. These names encode architecture style.

- [ ] **`auto-tag-architecture` command** — pattern-match weenie class names to infer architecture tags:
  - Names containing `aluvian` → architecture=Aluvian
  - Names containing `sho` → architecture=Sho
  - Names containing `gm`/`gharun` → architecture=Gharu'ndim
  - Names containing `viam` → architecture=Viamontian
  - Names containing `empyrean`/`falatacot` → architecture=Empyrean
  - Names containing `door`/`gate` → type=Interactive_Door
  - Names containing `tree`/`bush`/`shrub` → type=Scenery_Tree/Bush
  - Names containing `chest`/`crate`/`barrel` → type=Furniture_Storage
- [ ] Run against full weenie set → measure coverage improvement (target: 30%+ with architecture tags, up from 0.4%)
- [ ] **`auto-tag-biome` command** — use spawn map locations + terrain type lookup to infer biome tags:
  - If a creature spawns on terrain type 4 (desert), tag it as biome=Desert
  - If a creature spawns on terrain type 5 (snow), tag it as biome=Snow
  - Statistical: assign the biome where >50% of spawn instances occur

### Task 3: Difficulty Gradient Computation

> **WHY**: AC's world design has creatures get harder the further you go from starter towns. This gradient is THE signature design pattern. Without it, generated worlds feel random.

- [ ] **Define starter town coordinates** — hardcode the 9 Nexus town positions:
  - Holtburg, Lytelthorpe, Rithwic (Aluvian)
  - Yanshi, Shoushi, Nanto (Sho)
  - Yaraq, Samsur, Al-Arqas (Gharu'ndim)
- [ ] **`compute-difficulty-gradient` command** — for each creature in spawn maps:
  - Compute minimum distance to any starter town
  - Record (distance, creature_level) pairs
  - Fit a regression curve: `expected_level = f(distance_from_town)`
  - Output: gradient curve parameters + scatter data for visualization
- [ ] This gradient becomes a hard constraint for the creature distribution model

---

## 🔲 Phase 10.5c — Quality Scoring & Validation

> **DEPENDS ON**: Phase 10.5a (retail baseline) + Phase 10.5b (enriched ontology)
> To **exceed** retail AC, we need quantitative measures of quality, not just "it compiles and runs."

- [ ] **`score-landblock <x> <y>`** — compute quality score for a generated landblock:
  - Object diversity (Shannon entropy of object categories)
  - Creature level appropriateness (vs difficulty gradient curve)
  - Biome consistency (all objects in landblock compatible with terrain type)
  - Spacing naturalness (compare inter-object distances to retail distribution)
  - Object density (compare to retail mean ± 2σ)
- [ ] **`score-region <x1> <y1> <x2> <y2>`** — aggregate quality across a region:
  - Mean/min/max landblock scores
  - Terrain transition smoothness between landblocks
  - Cultural consistency (no Sho buildings mixed with Aluvian in same town)
- [ ] **`compare-to-vanilla <x> <y>`** — side-by-side metrics: generated vs retail landblock
- [ ] **Quality gates** — define pass/fail thresholds:
  - Object density within ±20% of retail mean
  - Creature level within ±10 of difficulty gradient curve
  - Zero biome constraint violations
  - Spacing naturalness score ≥ 0.7 (where 1.0 = matches retail distribution exactly)

---

## 🔲 Phase 12 — ML Training Data Packaging

> **DEPENDS ON**: Phase 10.5a (extracted data) + Phase 10.5b (enriched ontology)
> **PURPOSE**: Package the extracted retail data into the specific tensor formats needed for GPU training.
> This is where we transition from "C# extraction tools" to "Python ML pipeline."

### Training Domain 1: Terrain Generation
- [ ] **Dataset format**: Each sample = `{ landblock_coords, biome_type, neighbor_summary }` → `{ 9×9 heightmap, 9×9 terrain_type_grid }`
- [ ] **Model architecture**: U-Net or diffusion model (treat heightmap as 9×9 single-channel image)
- [ ] **Training samples**: ~65K landblocks from retail (Phase 10.5a Task 2)
- [ ] Package as `.safetensors` dataset
- [ ] CPU prototype: train toy model on i7 to validate pipeline

### Training Domain 2: Object Placement
- [ ] **Dataset format**: Each sample = `{ terrain_patch, biome, existing_objects[], settlement_type }` → `{ object_id, position_offset, orientation, scale }`
- [ ] **Model architecture**: Autoregressive transformer (place objects one at a time, conditioned on existing)
- [ ] **Training samples**: 54,197 spawn records + `export-training-data` output (Phase 10.5a Task 1)
- [ ] **Ontology dependency**: Needs Phase 10.5b for meaningful object identity
- [ ] Package as `.safetensors` dataset
- [ ] CPU prototype: train toy model on i7

### Training Domain 3: Creature Distribution
- [ ] **Dataset format**: Each sample = `{ landblock_x, landblock_y, terrain_type, distance_from_towns, biome }` → `{ creature_wcid, level, spawn_probability }`
- [ ] **Model architecture**: Small MLP or gradient boosted trees
- [ ] **Training samples**: Derived from spawn maps + difficulty gradient (Phase 10.5b Task 3)
- [ ] **Ontology dependency**: Needs creature-biome tags from wiki data
- [ ] CPU prototype: this model is small enough to train fully on CPU

### Training Domain 4: Dungeon Generation (HARDEST)
- [ ] **Dataset format**: Each sample = `{ difficulty_tier, theme, target_depth }` → `{ graph_adjacency_matrix, node_types[], room_template_ids[] }`
- [ ] **Model architecture**: Graph variational autoencoder or graph neural network
- [ ] **Training samples**: ~1,082 retail dungeons — **small dataset, will need augmentation**
- [ ] Data augmentation strategy: random room permutation, mirror, theme re-labeling
- [ ] CPU prototype: train on i7 to validate graph structure generation

---

## 🔲 Phase 13 — Producer-Consumer Architecture (4×4090 Deployment)

> **DEPENDS ON**: Phase 12 (trained models exist)
> Required before 4×4090 deployment. The GPUs generate landblock content; a single-threaded consumer writes to DAT files.

- [ ] **Staging directory format** — define intermediate landblock payload format (JSON or binary shard per landblock)
- [ ] **Model inference server** — Python FastAPI server hosting trained models, accepts landblock params, returns generated content
- [ ] **Concurrent producer workers** — partition 255×255 grid into quadrants, each GPU generates independently
- [ ] **Single-threaded DAT consumer** — reads from staging queue, calculates byte offsets, locked writes to master DAT
- [ ] **Pipeline integration test** — simulate 4 concurrent producers using 4 CPU threads on i7-7700HQ, verify DAT integrity after consumer merge
- [ ] **Load test** — boot exported DATs in AC client/ACViewer to verify no corruption

---

## 📊 Realistic Timeline Assessment

| Phase | Est. Time | Blocking On |
|-------|-----------|-------------|
| 10.5a — Retail extraction | 2-4 hours CPU time | Just need to run it |
| 10.5b — Wiki ingestion | 1-2 days | User preparing wiki data tomorrow |
| 10.5b — Auto-tagging | 1-2 agent sessions | ACE source code access |
| 10.5b — Difficulty gradient | 1 agent session | Spawn map + town coords |
| 10.5c — Quality scoring | 1-2 agent sessions | 10.5a + 10.5b results |
| 12 — ML packaging | 2-3 days | Python ML environment setup |
| 12 — CPU prototypes | 1-2 weeks | Iterate on model architectures |
| 13 — GPU pipeline | 1-2 days setup | Trained models + 4090 rental |

---

## 📚 Architecture Reference (for implementing agents)

### How commands are structured (follow this pattern exactly):

1. **Business logic** → `CommandEngine.cs` as a public method returning a result record
2. **Result records** → `CommandResults.cs` as `public record XxxResult(...);`
3. **REPL routing** → `TerminalRepl.cs` in the main `switch` block + a `HandleXxx()` helper
4. **JSON routing** → `JsonCommandProcessor.cs` in the main `switch` block + a `CmdXxx()` helper
5. **Help text** → added in both `PrintHelp()` (TerminalRepl) and `CmdHelp()` (JsonCommandProcessor)

### OntologyService enrichment pattern
Study `EnrichFromStrings()` and `EnrichMaterials()` in `OntologyService.cs` for the established pattern: iterate `_entries.Values`, match criteria, update fields, return count enriched. New enrichment methods must be added to `IOntologyService.cs` interface as well.

### Key file locations:
| File | Purpose |
|------|---------|
| `WorldBuilder.Terminal/CommandEngine.cs` | All command implementations (~3,500+ lines) |
| `WorldBuilder.Terminal/CommandResults.cs` | Result record types |
| `WorldBuilder.Terminal/TerminalRepl.cs` | REPL command routing |
| `WorldBuilder.Terminal/JsonCommandProcessor.cs` | JSON stdin protocol routing |
| `WorldBuilder.Shared/Services/OntologyService.cs` | Ontology scan + enrichment |
| `WorldBuilder.Shared/Services/IOntologyService.cs` | Ontology interface |
| `WorldBuilder.Shared/Lib/OntologyEntry.cs` | Ontology entry data model |
| `WorldBuilder.Shared/Lib/Resources/object_ontology_schema.json` | Hand-curated schema (82 entries) |
| `WorldBuilder.Shared/Lib/Dungeon/DungeonGrammar.cs` | Graph grammar L-System engine |
| `WorldBuilder.Shared/Lib/Dungeon/DungeonTopologyAnalyzer.cs` | Dungeon graph extraction |
| `WorldBuilder.Shared/Lib/Dungeon/DungeonRoomAnalyzer.cs` | Room template extraction |
| `ac-updates/` | **Retail DAT files** (cell 348MB, portal 927MB) |
| `LSD-Partial-2025-02-23_16-15/` | LSD dataset (19,686 weenies, 1,162 spawn maps, 7,347 recipes, 6,266 spells) |
| `TrainingDataReadiness.md` | Detailed gap analysis and training data assessment |

### Build command:
```
dotnet build WorldBuilder.Terminal/WorldBuilder.Terminal.csproj
```

### Error handling convention:
- Wrap individual file operations in try/catch
- Log progress every N items: `Console.WriteLine($"[Prefix] ...{processed}/{total}")`
- Return partial results on error (don't throw — return result with error message)
- Never let one bad input file kill a batch operation
