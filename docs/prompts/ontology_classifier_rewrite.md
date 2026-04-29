# OntologyService classifier rewrite — make Setup/GfxObj categories trustworthy as an agent contract

## Why this exists

`OntologyService` (`WorldBuilder.Shared/Services/OntologyService.cs`, 1,557 lines) is one of the oldest pieces of code in the Terminal stack — the auto-classifier that turns raw `Setup` (0x02) and `GfxObj` (0x01) entries into `(Category, Scale, Tags, Bounds, Footprint)` tuples for every other observation surface to consume. It was written before `transact`, `transact-diff`, `render-preview`, `describe-landblock`, the tile pyramid, or `emit-static-site` existed, and it shows: bare `catch { }` blocks, magic-threshold heuristics, degenerate-bounds fallbacks that silently invent `Vector3.Zero`-bound "Tiny" entries when a part fails to load, and an asymmetry between the Setup and GfxObj classification paths.

Meanwhile, **30+ call sites** across `CommandEngine`, `TransactDiffEngine`, and `LandblockDescriber` now read `entry.Category` as a string contract — `"Structure"`, `"Scenery"`, `"Furniture"`, `"Prop"`, `"Unknown"` drive glyph dispatch in `render-preview`, structure-vs-loose splits in `describe-landblock`, before/after summaries in `transact-diff`, validation gates in `LBK010` (footprint flushness), and constraint presets in the `OntologyService` enrichment layers. The Living Atlas's promise — *"identity is stored, context is derived"* — quietly assumes those derivations don't lie. Today they sometimes do.

This is foundational debt. The newer surfaces are bricks built on this slab; the slab needs to harden before more bricks land on it.

## Context — what exists in the repo

Read these before touching anything; the design assumes you understand what's already wired.

### The classifier itself
- `WorldBuilder.Shared/Services/OntologyService.cs`
  - **Cross-reference scanners** (lines 79–84, 176–225) — `ScanBuildingIds` walks `LandBlockInfo.Buildings.ModelId`; `ScanSceneryIds` walks `Scene.Objects.ObjectId`. Both swallow on failure (lines 200–202, 221–223 *do* log; the inner enumerator catches at lines 88–92, 103–105, 115–119, 128–135 do **not**).
  - **`ClassifySetup`** (lines 231–284) — uses building/scenery sets first, falls back to heuristics. `ClassificationSource` records `"Building" | "Scene" | "Heuristic"`. Footprint extraction is gated on `Category ∈ { "Structure", "Scenery" }` (line 272).
  - **`ClassifyGfxObj`** (lines 286–320) — the asymmetric path. **Never** consults `buildingIds` / `sceneryIds`; always runs the heuristic (lines 305–307). `partCount` is hardcoded to `1`.
  - **`ComputeSetupBounds`** (lines 326–369) — the degenerate-fallback site. If no part has any vertex, `min = max = Vector3.Zero` (line 367). The same fallback exists in `ComputeGfxObjBounds` at line 388. Downstream this looks indistinguishable from a legitimate point-mass at the origin.
  - **`ClassifyScale`** (lines 396–402) — `Tiny < 0.5 < Small < 2.0 < Medium < 5.0 < Large < 15.0 < Massive`.
  - **`ClassifyCategoryByHeuristic`** (lines 404–436) — six magic-threshold rules. `maxDim > 10 && partCount > 3 → Structure`, `aspectRatio > 3 && maxDim > 2 → Scenery`, `maxDim > 8 && partCount ≤ 2 → Scenery`, etc. No confidence, no overlap protection, no tie-break logic. A 10.01 m / 4-part object is `"Structure"`; 9.99 m / 4-part is whatever rule 4–6 catches.
  - **`PlacementFrames` handling** (lines 346–352) — picks `Values.FirstOrDefault()`, not the canonical default-frame key. If the dict is unordered (it is — it's a `Dictionary<uint, ...>`), the chosen frame is non-deterministic across runs.
  - **`BuildTags`** (line 438+) — derives string tags from `Scale`, `Category`, `DatType`, `ClassificationSource`. Tag strings become part of the cache.
  - **`CacheToFile` / `LoadFromCache`** (lines 1426, 1471) — JSONL persistence at `<project>/ontology_cache.jsonl`. Auto-restored at `CommandEngine.Load` (`CommandEngine.cs:113`).

### The string contract — every consumer of `Category`
Treat these as the API. Don't break them; if you must, change them all in one PR.

- `WorldBuilder.Terminal/CommandEngine.cs` — ~25 reads of `_ontologyService.GetEntry(...).Category` driving glyph dispatch, structure pairing, query-radius density bins, scenery scatter, ontology enrichment commands, `compare-to-retail` model-vs-retail class-space accounting.
- `WorldBuilder.Terminal/RenderPreviewRenderer.cs` (via `ResolveShapeForObject`, `ResolveSizePxForObject`) — glyph shape and size keyed off `Category`.
- `WorldBuilder.Terminal/LandblockDescriber.cs:296` — `Entry: ontology.IsScanned ? ontology.GetEntry(obj.Id) : null` — fed into `LandblockBody.Structures` vs. `LooseObjectCount` split.
- `WorldBuilder.Terminal/TransactDiffEngine.cs:288, 311, 608, 709` — before/after categorical deltas in `transact-diff` responses.
- `WorldBuilder.Shared/Lib/Validation/...` — at least `LBK010` (and likely BLD-family) reads `Category == "Structure"`.

### What "looks correct" looks like
- `WorldBuilder.Terminal/CommandEngine.RenderPreview` and the newer `transact-diff` / tile-pyramid code are the implicit yardstick: they validate inputs, log structured errors, and assume the data they consume is internally consistent. The classifier needs to deserve that assumption.

## Intent

Replace the heuristic classifier with a **two-stage classifier that returns a confidence score**, harden the geometry-extraction stage so it cannot invent `Vector3.Zero` bounds, and unify the Setup and GfxObj code paths so the same model classified through different entry points returns the same `Category`. Preserve the existing `Category` string vocabulary (`"Structure" | "Scenery" | "Furniture" | "Prop" | "Unknown"`) — the call-site contract is load-bearing — but extend `OntologyEntry` with explicit `Confidence` and `ClassificationReason` fields so downstream surfaces can grade their own trust.

The rewrite is internal. The agent JSON protocol's `entry.category` field stays exactly as it is. New fields are additive and optional.

## Objectives

1. **No more silent-zero bounds.** When `ComputeSetupBounds` / `ComputeGfxObjBounds` cannot extract any vertex, the entry is marked `Category = "Unknown"`, `ClassificationSource = "BoundsFailed"`, `Confidence = 0`, `ClassificationReason = "no-vertex-data"`. Never let a degenerate entry get scale-classified as `"Tiny"` and category-classified by heuristic.
2. **Symmetric Setup ↔ GfxObj classification.** `ClassifyGfxObj` consults `buildingIds` and `sceneryIds` the same way `ClassifySetup` does. A model used as a Scene scenery object that also exists standalone in `portal.dat` resolves to the same `Category` either way.
3. **Confidence-aware heuristic.** `ClassifyCategoryByHeuristic` returns `(Category, float Confidence ∈ [0,1], string Reason)`. The two boundary-straddling rules — *"large multi-part → Structure"* and *"large single-part → Scenery"* — return reduced confidence in a configurable margin band (default ±10% of each threshold) so downstream consumers can opt to ignore boundary cases when their decision matters.
4. **Deterministic frame selection.** `PlacementFrames` picks the lowest key, not `Values.FirstOrDefault()`. Two runs over the same DAT must produce byte-identical `ontology_cache.jsonl`.
5. **Structured failure surface.** Every `catch` either logs at WARN with the entry id and exception message, or rethrows. No bare `catch { }` left in the file. Failed-to-classify entries appear in a new `report.FailedEntries: List<(uint id, string reason)>` and are logged at scan-end count summary.
6. **Cache-format compatibility.** Old `ontology_cache.jsonl` files load without error: missing `Confidence` defaults to `1.0`, missing `ClassificationReason` defaults to `null`, missing `FailedEntries` is treated as empty. New caches are forward-compatible with the old reader (extra fields ignored).
7. **Test coverage that pins the contract.** A new `OntologyServiceTests` suite (xUnit, in `WorldBuilder.Tests`) covers: degenerate-bounds path → `"Unknown"`; symmetric Setup vs. GfxObj for the same id; deterministic frame selection across 100 runs; threshold boundary at exactly 10 m / 8 m / 5 m / 1 m maxDim; round-trip through `CacheToFile` / `LoadFromCache`; and the cross-reference scanner brute-force fallback (`LandBlockInfo` enumeration empty → 256² lookup) returns the same building-id set as the enumerated path on a known DAT fixture.

## Specs

### 1. `OntologyEntry` schema additions

Append-only — do not reorder existing fields, do not change existing serialized names. New fields:

```csharp
public float Confidence { get; set; } = 1.0f;        // [0,1] — heuristic = computed; cross-ref hit = 1.0
public string? ClassificationReason { get; set; }    // human-readable rule id, e.g. "heuristic:large-multi-part"
                                                     // or "boundary:struct-vs-scenery@9.97m" or "no-vertex-data"
```

JSON wire field names: `confidence`, `classificationReason`. Serialize only when non-default to keep the cache compact.

### 2. Geometry extraction — fail loudly

In `ComputeSetupBounds` and `ComputeGfxObjBounds`, replace the `min = max = Vector3.Zero` fallback with a `bool boundsValid` out-parameter:

```csharp
private static void ComputeSetupBounds(
    Setup setup, IDatReaderWriter dats,
    out Vector3 min, out Vector3 max, out int totalPolys, out bool boundsValid);
```

Callers (`ClassifySetup`, `ClassifyGfxObj`) must check `boundsValid` first. When false:

```csharp
entry.Category = "Unknown";
entry.Scale = "Unknown";
entry.ClassificationSource = "BoundsFailed";
entry.Confidence = 0f;
entry.ClassificationReason = totalPolys == 0 ? "no-polygons" : "no-vertex-data";
return entry;
```

`ClassifyScale` gains an `"Unknown"` case alongside the existing five tiers.

### 3. Symmetric GfxObj classification

`ClassifyGfxObj` accepts the same `buildingIds` / `sceneryIds` sets that `ClassifySetup` does. Both call paths route through a shared inner method:

```csharp
private OntologyEntry ClassifyByCrossRefOrHeuristic(
    uint id, string datType,
    Vector3 min, Vector3 max, int partCount, int polyCount,
    HashSet<uint> buildingIds, HashSet<uint> sceneryIds);
```

`ClassifySetup` and `ClassifyGfxObj` keep their geometry-extraction logic local but delegate the category decision. Phase 3 of `ScanAsync` (line 112) passes the same sets.

### 4. Confidence-aware heuristic

Replace `ClassifyCategoryByHeuristic` with a method that walks the existing six rules in order and, for each, computes confidence based on distance from the threshold:

| Rule | Trigger | Margin band | Confidence in band |
|---|---|---|---|
| 1 | `maxDim > 10 && partCount > 3 → Structure` | `9 ≤ maxDim ≤ 11` | `0.5 + 0.5 * (maxDim - 9) / 2` |
| 2 | `aspectRatio > 3 && maxDim > 2 → Scenery` | `2.7 ≤ aspectRatio ≤ 3.3` | `0.5 + 0.5 * (aspectRatio - 2.7) / 0.6` |
| 3 | `maxDim > 8 && partCount ≤ 2 → Scenery` | `7 ≤ maxDim ≤ 9` | `0.5 + 0.5 * (maxDim - 7) / 2` |
| 4 | `maxDim < 1 && polyCount < 50 → Prop` | `0.8 ≤ maxDim ≤ 1.2` | `0.5 + 0.5 * (1.2 - maxDim) / 0.4` |
| 5 | `maxDim < 3 && aspectRatio < 0.5 → Furniture` | (no band — categorical) | `0.85` |
| 6 | `maxDim ∈ [1,5) && partCount ≥ 2 → Furniture` | (no band) | `0.85` |
| 7 | `maxDim ∈ [1,8) → Prop` | (no band) | `0.7` |
| fallback | else `→ Unknown` | — | `0.0` |

Outside the margin band a rule fires at confidence `1.0`. `ClassificationReason` is the rule id (`"heuristic:large-multi-part"`, `"boundary:struct-vs-scenery@9.97m"`, etc.).

Cross-reference hits (`buildingIds.Contains(id)` → `Structure`, `sceneryIds.Contains(id)` → `Scenery`) always fire at confidence `1.0` with `ClassificationSource = "Building" | "Scene"` and `ClassificationReason = "crossref"`.

### 5. Deterministic placement-frame selection

In `ComputeSetupBounds` (currently line 348):

```csharp
// Old: var defaultPlacement = setup.PlacementFrames.Values.FirstOrDefault();
var defaultKey = setup.PlacementFrames.Keys.Min();
var defaultPlacement = setup.PlacementFrames[defaultKey];
```

Document the choice with one short comment: ordering by key, not by enumeration order, makes the cache reproducible across runs and across .NET runtime versions.

### 6. Failure surface

Every `catch` in `OntologyService.cs` either:
- Logs at `Console.Error.WriteLine` with `[Ontology] ERROR id=0x{id:X8}: {ex.GetType().Name}: {ex.Message}` and continues, OR
- Adds `(id, reason)` to a new `report.FailedEntries` list and continues, OR
- Rethrows (only for the outer scan invocation if the DAT readers themselves are unusable).

The four currently-bare blocks (lines 90, 103, 117, 133) become the `FailedEntries`-append form.

`OntologyScanReport` gets:
```csharp
public List<(uint Id, string Reason)> FailedEntries { get; } = new();
```

Scan-end log line includes `failed={report.FailedEntries.Count}`.

### 7. Cache compatibility

`LoadFromCache` (line 1471) reads new fields when present and tolerates their absence. Add a one-line `cacheVersion: 2` field to new caches; readers tolerate `cacheVersion: 1` (or missing) and treat them as the legacy format. No migration command required — caches are regenerated on demand from `cache-ontology`.

### 8. Tests — `WorldBuilder.Tests/OntologyServiceTests.cs`

Required cases:

1. `BoundsFailed_WhenSetupHasNoVertices_ReturnsUnknown` — fabricate a Setup with one part whose GfxObj has empty `VertexArray`. Expect `Category == "Unknown"`, `ClassificationSource == "BoundsFailed"`, `Confidence == 0`, `Scale == "Unknown"`.
2. `Symmetric_SetupAndGfxObj_SameId_SameCategory` — same id present both as a Setup part and as a standalone GfxObj entry, with the id in `sceneryIds`. Both code paths return `Category == "Scenery"`, `ClassificationSource == "Scene"`.
3. `Deterministic_PlacementFrameSelection` — Setup with 3 placement-frame keys (e.g. `[5, 0, 9]`) → bounds computed against frame `0` every run. Run 100x; assert byte-identical bounds.
4. `Heuristic_BoundaryConfidence_StructureVsScenery` — synthetic Setup with `maxDim = 9.97`, `partCount = 4` → `Category == "Structure"`, `Confidence ≈ 0.74`, `ClassificationReason` matches `"boundary:..."`.
5. `Cache_RoundTrip_PreservesNewFields` — scan a small fixture, `CacheToFile`, `LoadFromCache`, assert `Confidence` and `ClassificationReason` survive.
6. `Cache_LegacyFile_LoadsAsConfidenceOne` — hand-crafted JSONL without `confidence` field loads with `Confidence == 1.0` on every entry.
7. `BruteForceFallback_SameSet_AsEnumeratedPath` — DAT fixture with `LandBlockInfo` enumeration both populated and (mocked) empty; both paths produce the same `buildingIds` set.

Use the existing `WorldBuilder.Tests` xUnit conventions and `IDatReaderWriter` mocking patterns from `QuickWorldHelpersTests.cs`.

### 9. Out of scope

- The `ClassifyCategoryByHeuristic` rule *vocabulary* itself (which six rules, in what order). Boundary confidence is the change; rule semantics are preserved so cached agent-training data isn't invalidated.
- Replacing the heuristic with a learned model. Confidence scoring is the on-ramp; the learned-model path is a future doc.
- Renaming the `"Structure" | "Scenery" | "Furniture" | "Prop" | "Unknown"` vocabulary. The 30+ string-matching call sites stay untouched.
- The `Enrich*` methods (lines 484–1424). They consume the cache but don't drive the classifier; they're a separate refactor.

## Risks and acceptance

- **Diagnostic-code stability.** `LBK010` and any other validator that string-matches `Category == "Structure"` must continue to fire at the same rate on the same retail DATs. Run the existing `tests/test_agent_protocol.py` validation suite against `projects/RetailSmoke` before and after; assert error/warning/info counts are within ±1% per landblock.
- **Cache regeneration on first launch.** Existing `<project>/ontology_cache.jsonl` files load fine, but they don't carry `Confidence`. Document in the rewrite PR description that running `cache-ontology` once after upgrade rewrites the cache with the new fields. No data loss; just an opt-in.
- **Confidence interpretation drift.** Downstream consumers will start reading `entry.Confidence`. Until they do, all behavior is identical to the pre-rewrite classifier — confidence is ignored. Land the classifier rewrite first; teach call sites to use confidence in follow-up PRs.
- **Brute-force fallback runtime.** The 256×256 `LandBlockInfo` lookup at lines 183–191 is slow on cold caches. Not changed by this rewrite, but flag it as known cost in the PR; the primary `GetAllIdsOfType<LandBlockInfo>` path is the fast one and is exercised first.

The acceptance gate is a single command:

```bash
dotnet test WorldBuilder.Tests --filter FullyQualifiedName~OntologyServiceTests
```

…plus the pre/post agent-protocol diff on `projects/RetailSmoke`. If both pass, the slab is hardened and the next brick can land.
