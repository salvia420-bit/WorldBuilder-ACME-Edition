# weenie_index — unifying canonical wcid identity across the render pipeline

> **Format:** Context · Intent · Why · Objectives · Deliverables · Validation

## Context

Triggered by a visual inspection of `docs/images/DerethMapsEnhanced_zoom.png` (Holtburg, z=12 in the Leaflet-style `emit-static-site` view). The user noticed that the green statue pedestal was missing its statue and missing a door on its left side, plus glyph-only renders where sprites were expected (the "small dark circle" on the left, fence-shaped clusters top-right). Investigation traced this to a series of related gaps in the render pipeline — all instances of one underlying architectural shape: **render-time resolution paths terminate at DAT-derived data, while a growing share of the world's content lives in the ACE world DB.**

Two PRs landed this session against `master` (commits below). They closed the immediate render-time symptoms but did not address the root architectural pattern. This doc is the bridge to the next round.

| Commit | Subject |
|---|---|
| `72bcedc` | feat(terminal): surface server-managed landblock_instance objects with orientation |
| `02b3330` | feat(terminal): render thin objects, world-Z stacking, scale dispatch, drop diagnostics |
| `064189f` | perf(terminal): stream sprite atlas pack to bound peak memory |

## Why this matters now

After the two feature PRs landed, the user re-ran `emit-static-site` against `RetailSmoke` (3×3 LB region around Holtburg `0xA9B4`). The new emit-time diagnostic introduced in `02b3330` produced this output:

```
emitter:spawnSpriteCoverage: 51 of 105 surface spawns (48.6%) have a sprite;
                              54 fall back to glyph (54 unresolved wcid,
                              0 resolved-but-no-sprite).
emitter:spawnSpriteCoverage:topMissing:
    Top missing wcids: 7923, 7924, 37518, 1154, 3955, 794, 1125, 2068, 8127, 20216
```

Every one of those wcids has a real `setup_did` in the ACE DB. The mapping just isn't reaching the render-time resolver. The most striking single example:

| wcid | class_name | setup_did | what it is |
|---:|---|---:|---|
| 1125 | `portalholtburgdungeon` | `0x020005F3` | **Holtburg Dungeon entrance — the original "door under the pedestal"** |

Confirms the user's intuition from day one: the missing thing is server-side, has a real model, and lives in `landblock_instance`. The render pipeline simply can't see it because:

1. `CommandEngine.GetWcidToSetupResolver()` builds its `_wcidToSetup` map exclusively from `_ontologyService.GetAllEntries()` where `WeenieClassId is int wcid && wcid > 0 && e.ObjectId != 0`.
2. The `OntologyService` is DAT-derived — its `WeenieClassId` field is populated *incidentally* (when a DAT entry happens to reference a wcid via spell tables, building blueprints, etc.), not exhaustively.
3. The exhaustive wcid → setupDid mapping lives in `weenie_properties_d_i_d` (PropertyDataId.Setup, type=1) in the ACE world DB. The resolver never queries it.

## The systemic shape

The gap above is one instance of a recurring pattern across the codebase. Every place where ACE-DB content needs to feed render-time logic, there is a path that terminates at DAT-only data:

| Where the wire was DAT-only | Status |
|---|---|
| `is_server_managed` filter in `SpawnGazetteerBuilder.BuildFromLsdJson` | **fixed** in `72bcedc` |
| `ObjectSpriteGenerator` flat-plane skip (doors/fences/signs/banners) | **fixed** in `02b3330` |
| `Quaternion.Identity` hardcoded for spawns in `RenderPreviewRenderer` | **fixed** in `72bcedc` |
| `AutoRestoreSpawnGazetteer` only reading `spawn_gazetteer.json` | **fixed** in `72bcedc` |
| `MapToRendererCategory` collapsing all non-Creature/Npc to Prop/Small | **fixed** in `02b3330` |
| `GetWcidToSetupResolver` consults only DAT-side ontology | **OPEN — this doc's subject** |
| Static-site `EmitOverlays` copies `spawn_gazetteer.json` only (LSD shape); ACE-DB shape ignored | OPEN |
| `SpawnGazetteerBuilder.ResolveCategory` prefers Acpedia wiki cats over canonical `weenie.type` | OPEN |
| Roster ingests duplicate work that a single weenie-table query would subsume | OPEN |

## Intent

Close the load-bearing instance of the systemic gap (the wcid → setupDid resolver) and introduce the structural piece that prevents the same shape recurring: a single canonical **WeenieIndex** keyed by wcid, populated from canonical sources only, consumed at render time by every consumer that today reaches into a different store.

The user explicitly approved sketching the architectural fix (`/effort max`, option 2). After scrutiny of one annotation source (`wcid_acpedia_join.jsonl`, see below) the original sketch was corrected to **never** merge wiki/community data into the canonical layer.

## A correction from this session — keep it visible

The first sketch of WeenieIndex proposed to fold `wcid_acpedia_join.jsonl` (Acpedia wiki dump matched against weenie names) into the canonical record. Profiling the file revealed:

```
tier      count    %
HIGH      1,406    7.1%
MED      13,350   67.8%
LOW         159    0.8%
NONE      4,771   24.2%

64% of rows have empty acpedia_cats
59% of rows have description="}} == Notes == }}" (raw wikitext markup that didn't render)
HIGH-tier matches still suffer generic-name collisions:
  wcid 73395 (a specific door) matched generic Acpedia "Door" page →
  cats = ["creature", "no class", "object"] — semantically meaningless.
```

**The "tier" reflects name-match confidence, not content quality.** Wiki annotations are useful for prose flavour in `LandblockDescriber`. They are **not** structural data fit for a canonical record. The corrected architecture below maintains a strict trust boundary.

## Architecture — corrected

```
                ┌────────────────────────────┐
                │   CANONICAL LAYER          │
                │   - DAT (cell, portal)     │
                │   - ACE DB (weenie + props)│
                │   ↓                        │
                │   WeenieIndex              │
                │   (wcid → identity)        │
                │   gates RENDERING          │
                └─────────────┬──────────────┘
                              │
                ┌─────────────┴──────────────┐
                ▼                            ▼
          renderer                     describer
                                            ▲
                ┌───────────────────────────┘
                │   ANNOTATION LAYER
                │   - LSD spawn maps  (community-curated)
                │   - Acpedia wiki    (variable quality)
                │   ↓
                │   wcid_acpedia_join.jsonl
                │   stays SEPARATE, prose-only,
                │   NEVER joined into WeenieIndex,
                │   NEVER drives render decisions.
```

### `WeenieEntry` shape

```csharp
public sealed record WeenieEntry(
    // ── Identity (canonical, immutable) ────────────────
    int    Wcid,                  // weenie.class_Id
    string ClassName,             // weenie.class_Name (machine identifier)
    int    WeenieType,            // weenie.type (Creature=10, Door=19, Portal=7, ...)
    bool   IsServerManaged,       // true when sourced from landblock_instance

    // ── Display (canonical, from property strings) ─────
    string  DisplayName,          // weenie_properties_string [Name=1]
    string? Title,                // weenie_properties_string [Title=5]

    // ── Render handles (canonical, from property DIDs) ─
    uint?   SetupDid,             // weenie_properties_d_i_d  [Setup=1]    ← today's gap
    uint?   IconDid,              // weenie_properties_d_i_d  [Icon=2]
    uint?   PaletteBaseDid,       // weenie_properties_d_i_d  [PaletteBase]

    // ── Gameplay attrs (canonical, from property ints) ─
    int?    CreatureType,         // weenie_properties_int    [CreatureType=2]
    int?    Level,                // weenie_properties_int    [Level=25]

    // ── Provenance ─────────────────────────────────────
    WeenieSource SourceMask       // bitfield: AceDb | DatOntology | LsdSpawnMap
);
```

### Field consumption — what the renderer is allowed to see

| Consumer | May read |
|---|---|
| Renderer (sprite atlas hit, scale, glyph fallback) | `Wcid`, `WeenieType`, `SetupDid`, `IsServerManaged` |
| Spawn-glyph dispatcher (`MapToRendererCategory`, `ScaleForSpawn`) | `WeenieType`, `SetupDid`, atlas bbox via lookup |
| `LandblockDescriber` prose | All canonical fields, plus *separately-loaded* `wcid_acpedia_join.jsonl` for wiki annotation |
| Static-site overlays | All canonical fields. Wiki annotation is rendered as a footer-tier "wiki notes" only. |

The describer is the only consumer permitted to reach into the annotation layer, and it does so through a **distinct** map, not via `WeenieEntry`. Any future temptation to add an `AcpediaTitle` field on `WeenieEntry` is an architectural regression and should be refused.

## Migration path — six independently shippable commits

Each step is intentionally bounded so a regression can be reverted without unwinding the rest. Recommended cadence: one commit per session if the agent is iterating on visual feedback; two per session if running batch-style.

### Step 1 — Introduce `WeenieIndex` as an additive service (~250 LOC)

- New `WorldBuilder.Shared/Lib/WeenieIndex.cs` with the record + dictionary + JSONL load/save.
- New `AceDbConnector.IngestWeenieIndexAsync()` — single bulk query joining `weenie` + `weenie_properties_string` (Name=1, Title=5) + `weenie_properties_d_i_d` (Setup=1, Icon=2, PaletteBase=*) + `weenie_properties_int` (CreatureType=2, Level=25). One round trip; ~80k rows for retail.
- New `CommandEngine.IngestWeenieIndex()` writes per-project `weenie_index.jsonl`.
- New `AutoRestoreWeenieIndex` mirrors `AutoRestoreSpawnGazetteer`.
- Field: `private WeenieIndex _weenieIndex = WeenieIndex.Empty;`
- **Nothing yet consumes it.** Behaviour change: zero. Test: ingest, restart, verify auto-restore count.

### Step 2 — Resolver consults WeenieIndex first, ontology second (~30 LOC)

- `GetWcidToSetupResolver()` checks `_weenieIndex.TryGetSetup(wcid)` first; falls back to current ontology map.
- `ScaleForSpawn` checks `_weenieIndex.Get(wcid)?.SetupDid` for the atlas-bbox lookup; preserves heuristic fallback.
- The `spawnSpriteCoverage` diagnostic introduced in `02b3330` should jump from 48.6% → ≥95% on RetailSmoke after this step lands.
- Test: re-emit static site, confirm `topMissing` list shrinks dramatically; visual: Holtburg dungeon portal (wcid 1125) appears at z=12.

### Step 3 — Fold roster ingests into projections (~80 LOC net deletion)

- `IngestCreatureRosterAsync` reads `_weenieIndex`, filters `Type==10`, writes the existing `creature_gazetteer.json` schema.
- Same for `IngestNpcRosterAsync` (Type ∈ {4, 12, 20}).
- Existing parallel queries (`AceDbConnector.Roster.cs`) become deprecated; the rosters become projections of one canonical source.
- Backwards compat: `AutoRestoreSpawnGazetteer` already prefers `ace_spawn_records.jsonl` — projects with old `creature_gazetteer.json` keep working.

### Step 4 — `SpawnGazetteerBuilder.ResolveCategory` prefers canonical `weenieType` (~10 LOC)

Current ordering is **backwards**: it prefers `acpediaCategories` (variable quality) over `weenieType` (canonical):

```csharp
// CURRENT (wrong): Acpedia first, type fallback
if (acpediaCategories is { Length: > 0 }) { /* match cats */ }
return weenieType switch { 10 => "Creature", ... };
```

Flip to type-first; use Acpedia cats only as a tiebreaker for ambiguous types (e.g., Type=1 "Generic" can be Object or Surface depending on Acpedia hint, but that's a refinement, not an override).

### Step 5 — Static-site overlay format unification (~60 LOC)

- `StaticSiteEmitter.EmitOverlays` regenerates `spawns.js` from in-memory gazetteer + WeenieIndex (joined), instead of byte-copying source JSON.
- Single overlay shape regardless of source provenance (LSD vs ACE-DB vs synthetic).
- Closes the "if only `ace_spawn_records.jsonl` exists, frontend overlay panel is empty" issue noted as out-of-scope item #1 in the prior session.

### Step 6 — Cleanup (~100 LOC mostly deletion)

- Mark `_wcidToSetup` map (and its lazy build path) obsolete; remove after one cycle.
- Delete `OntologyEntry.WeenieClassId` field — no longer needed for the wcid→setup join. Verify nothing else reads it (grep).
- Update `docs/agent_api_reference.md`: document `ingest-weenie-index` command + its supersession of the per-roster commands (which remain available as projection helpers).
- Add `WeenieIndex` test fixtures to `WorldBuilder.Tests`.

**Total: ~3 dev days, six commits, each independently shippable.**

## The surgical alternative — when to choose it instead

If shipping this branch to mainline within 24 hours, ship the surgical version instead:

> `ingest-wcid-setups` writes a focused `wcid_setup_index.jsonl` with only `(wcid, setupDid)` pairs. `AutoRestore` reads it. `GetWcidToSetupResolver` consults it as fallback.
> ~80 LOC, half a day. Solves today's diagnostic. Leaves the other open systemic gaps in place.

The surgical fix is itself subsumed by Steps 1+2 of the architectural path. It is **wasted work** if the architectural path is taken next; choose one. **Do not do both halfway.**

Decision rule:
- Iteration mode → architectural is fine, take the time.
- Imminent merge to mainline → surgical, then architectural in a follow-up branch.

## Reference data on disk (RetailSmoke project)

Useful when verifying any step lands:

```
/home/wbterminal/projects/RetailSmoke/
├── ace_spawn_records.jsonl          365k lines  (auto-restored, post-72bcedc)
├── spawn_gazetteer.json             0 bytes     (LSD source, empty for this project)
├── creature_gazetteer.json          → ace-db ingest output
├── npc_gazetteer.json               → ace-db ingest output
├── housing_gazetteer.json           → ace-db ingest output
├── wcid_acpedia_join.jsonl          19,686 lines  (ANNOTATION LAYER — keep separate)
├── ontology_cache.jsonl             21,253 entries (DAT-side — stays as-is)
├── poi_gazetteer.json
├── region_gazetteer.json
├── town_gazetteer.json
├── sprites/
│   ├── atlas.png                    16,384 × 14,051 px @ 174 MB (post-064189f streaming pack)
│   └── manifest.jsonl               4,934 entries
└── ... (terrain docs, project.db, etc.)
```

Mariadb fixture:
```
host=127.0.0.1  user=baltic  password=baltic  database=baltic
$ /home/wbterminal/WorldBuilder-ACME-Edition/scripts/spin-up-mariadb.sh   # bring up
$ /home/wbterminal/WorldBuilder-ACME-Edition/scripts/spin-down-mariadb.sh # tear down
```

## Validation

After Step 2 lands, the emit-static-site diagnostic should report:

```
spawnSpriteCoverage: ≥95% of surface spawns have a sprite;
                     remaining unresolved are wcids whose setup is empty in ACE DB
                     (legitimate ontology gap, not a pipeline bug).
```

Visual smoke test (Holtburg, LB `0xA9B4`): the green statue pedestal area should now show:
- The Holtburg Dungeon portal (wcid 1125, setup `0x020005F3`) at the position the user originally identified as missing.
- Royal Guards (wcid 37518) where they spawn in retail.
- Apple/monster generators rendering as thin glyph-or-sprite at their canonical positions.

Visual cross-check: `tools/town_placer.html` opens against the same project. Same town outlines should appear unchanged — Step 1's index should not regress town placement.

## Out-of-scope but adjacent (open follow-ups)

These were noted across the session but are NOT in the WeenieIndex plan:

1. **Sprite atlas regen for new world projects** — the streaming pack landed in `064189f` but the existing `RetailSmoke` atlas is the only one currently regenerated against the new thin-object code. Other projects' atlases pre-date `02b3330` and still glyph-fall back for thin objects until regen. Recommend: re-run `generate-object-sprites --force --spritePx 256` per project at convenient time.

2. **Painter-sort transitivity** — the proximity-aware comparator in `RenderPreviewRenderer` (post-`02b3330`) is not strictly transitive at the proximity boundary. Visually fine in tested cases. If glaring stacking artifacts surface, the right fix is two-pass: bucket by spatial cell, sort within bucket by Z, then merge buckets by max-ShapeZ. Currently bounded by IntroSort's tolerance.

3. **`AnalyzeSpawnSpriteCoverage` is surface-only** — skips cell ≥ `0x100` (indoor). Floor-tier glyph drops aren't reported. Easy extension once Step 2 lands.

4. **Defensive read on `landblock_instance` origin columns** — `GetAllInstancesAsync` reads `angles_*` defensively (post-`72bcedc`); should also defend `origin_*` for partial dumps. Low risk for retail data.

5. **Targeted unit tests** — `SpawnRecord` shape changed in `72bcedc`; current tests compile but no fixture exercises `IsServerManaged` / `Orientation`. Add coverage when convenient.

## What is currently running on the host

State at session handoff (verify with `ps -ef | grep WorldBuilder.Te`):

| Port | Surface | Source |
|---:|---|---|
| 8090 | Wide gallery, no overlay | `/tmp/dereth-gallery-clean` |
| 8091 | Tight gallery, radius=0 (NPC zoom) | `/tmp/dereth-gallery-tight` |
| 8092 | Static site (Leaflet, Holtburg 3×3) | `/tmp/dereth-site2` |

Tailscale IP: `100.116.47.66`. These were timing-bound `dotnet run` processes and may have exited by the time the next agent reads this; restart with:

```bash
dotnet run --no-build --project /home/wbterminal/WorldBuilder-ACME-Edition/WorldBuilder.Terminal
> serve-render-gallery /tmp/dereth-gallery-clean --port 8090
```

(Note: `serve-render-gallery` is a generic static file server; works for the static site dir too.)
