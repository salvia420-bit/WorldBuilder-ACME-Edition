# Code Review — `load` / `export` / `info` and Terrain Edit Commands

**Date:** 2026-04-29
**Scope:** `WorldBuilder.Terminal/JsonCommandProcessor.cs`,
`WorldBuilder.Terminal/CommandEngine.cs`, `WorldBuilder.Terminal/CommandResults.cs`.
**In-scope commands:** `load`, `export`, `info`, `smooth`, `raise`, `lower`,
`set-height`. **Sampled neighbor:** `paint`.

The reviewer read each JSON handler and engine method together as a single
logical unit. Auto-loader behavior, async-export divergence, and the duplicated
five-line edit pattern all received explicit attention per the brief.

---

## 1. Findings

### 1.1 Bugs

#### B1 — `Load` leaks the previous project's ontology cache when the new project has none
`CommandEngine.cs:112-120`. The auto-restore for `ontology_cache.jsonl` is the
only auto-loader without a state-reset path. Five of the six gazetteers have an
explicit `else` branch (`_townGazetteer = new()`, etc.) and the region loader
zeroes its three fields *before* the `try`. The ontology block is just
`if (File.Exists(cachePath)) { _ontologyService.LoadFromCache(cachePath); }` —
if the new project ships no cache file, whatever the service was holding from
the previous `load` survives.

User-visible consequence: load Project A (which has an ontology cache) → load
Project B (which does not). `query-ontology`, `ontology-stats`, and any
describe-landblock path that goes through ontology lookup will return Project
A's data tagged as if it belonged to Project B. Because all of this is
in-memory, the failure is invisible until someone notices "wait, why does this
landblock have NPCs from a different world."

Fix sketch:

```csharp
// Add an explicit reset, mirroring the other auto-loaders.
try {
    var cachePath = Path.Combine(p.ProjectDirectory, "ontology_cache.jsonl");
    if (File.Exists(cachePath)) {
        int restored = _ontologyService.LoadFromCache(cachePath);
        Console.Error.WriteLine($"[Ontology] Auto-restored {restored:N0} entries from {cachePath}");
    } else {
        _ontologyService.Clear();   // add this method to IOntologyService if missing
    }
} catch (Exception ex) {
    _ontologyService.Clear();
    Console.Error.WriteLine($"[Ontology] Auto-restore skipped: {ex.Message}");
}
```

If `IOntologyService` does not expose `Clear()`, that's the bug — the engine
shouldn't be the one deciding the service is "owned" but only able to add to
it. Add the method.

---

#### B2 — JSON `export` cannot trigger reposition; engine has two divergent methods, JSON only wires one
`JsonCommandProcessor.cs:498-503` calls `_engine.Export(dir, iteration)`. The
async `_engine.ExportWithRepositionAsync(dir, iteration)` is referenced **only**
from `TerminalRepl.cs:495`, behind the REPL's `--reposition` flag. Grep
confirmed: no JSON code path can ever invoke the reposition variant.

For interactive REPL users this is fine. For the JSON-RPC contract — which is
the surface that every external caller (Claude Code agent, future GUI front-end,
CI scripts) sees — there is no way to get `Export` to update the ACE-DB
instance positions after a heightmap edit. A user editing terrain in JSON mode
and then exporting will ship DAT changes that leave server-side instance Z
coordinates dangling at the old surface.

`Export` and `ExportWithRepositionAsync` also have **different failure-mode
contracts.** `Export` returns a single `bool Success`. `ExportWithReposition`
returns four boolean axes (`ExportSuccess`, `RepositionAttempted`,
`RepositionSuccess`) plus counts and an optional error string, and it catches
its own exceptions to return them as `RepositionError` rather than propagating.
A future agent author who learns the REPL semantics and assumes the JSON
behaves the same will be surprised twice.

Fix sketch:

```csharp
private string CmdExport(System.Text.Json.Nodes.JsonNode node) {
    var dir = node["directory"]?.GetValue<string>()
        ?? throw new ArgumentException("Missing 'directory' field");
    var iteration = node["iteration"]?.GetValue<int>();
    bool reposition = node["reposition"]?.GetValue<bool>() ?? false;

    if (!reposition) {
        var r = _engine.Export(dir, iteration);
        return Serialize(new { success = r.Success, command = "export",
            directory = r.Directory, iteration = r.Iteration });
    }

    var rr = _engine.ExportWithRepositionAsync(dir, iteration)
        .GetAwaiter().GetResult();
    return Serialize(new {
        success = rr.ExportSuccess && (!rr.RepositionAttempted || rr.RepositionSuccess),
        command = "export",
        directory = rr.Directory, iteration = rr.Iteration,
        repositionAttempted = rr.RepositionAttempted,
        repositionSuccess = rr.RepositionSuccess,
        instancesChecked = rr.InstancesChecked,
        instancesUpdated = rr.InstancesUpdated,
        landblocksProcessed = rr.LandblocksProcessed,
        repositionError = rr.RepositionError,
    });
}
```

The `success` composition is deliberate — reposition was *attempted but
failed* should not return `success = true`. Right now the REPL prints "warn"
and continues; a JSON agent has no way to detect the same condition.

---

#### B3 — `set-height` rejects out-of-range height with an unrelated low-level error
`JsonCommandProcessor.cs:543`. `node["height"]?.GetValue<byte>()` only handles
the *missing* case — the `??` coalescing fires when the lookup returns null.
If the caller sends `"height": 300`, `GetValue<byte>()` throws an
`InvalidOperationException` with a message about element type mismatches.
That bubbles up and is wrapped as `{"success": false, "error": "..."}`, but the
error text doesn't mention `height`, doesn't mention valid range, and doesn't
mention `set-height`. The same pattern affects `paint` (`"type"`), `fill`
(`"type"`), and `road` (`"value"`).

`set-height` deserves an additional callout: the parameter is not "Z in
meters", it's an **index into the LandHeightTable** (typically `i * 2.0` so
the index is roughly Z/2). Naming it `height` and accepting it as `byte`
encourages the misreading. A user who sends `"height": 100` thinking
"100 meters" gets ~50 m of elevation. A user who sends `"height": 300` thinking
"300 meters" gets the InvalidOperationException above. Neither path produces
the result they were trying for, and the error message does not point at the
problem.

Fix sketch:

```csharp
// In JsonCommandProcessor:
private static byte ByteInRange(System.Text.Json.Nodes.JsonNode node, string field, int? max = null) {
    var raw = node[field]?.GetValue<int>()
        ?? throw new ArgumentException($"Missing '{field}' field");
    if (raw < 0 || raw > (max ?? 255))
        throw new ArgumentException($"'{field}' must be 0..{max ?? 255}, got {raw}");
    return (byte)raw;
}

// At call site:
byte height = ByteInRange(node, "height");
```

And rename the JSON field to `heightIndex` (keeping `height` as a deprecated
alias) so the contract isn't lying about units.

---

#### B4 — `raise` / `lower` silently coerce negative `delta` to positive
`CommandEngine.cs:388, 396`. Both engine methods take signed `int delta`, then
do `Math.Abs(delta)` (positive) for raise and `-Math.Abs(delta)` (always
negative) for lower. A caller invoking `{"command": "raise", "delta": -5}`
with the intent "raise by negative five = lower by five" gets a *raise* of
five. A caller invoking `{"command": "lower", "delta": -5}` gets a *lower* of
five — same as `delta: 5`.

Two paths are reasonable: (a) reject negative `delta` with an error, or
(b) honor the sign and let `raise -5` lower terrain. The current
silent-positive coercion is the worst of both worlds: negative input is
accepted but not honored, with no signal back to the caller.

`raise` and `lower` are also redundant given a signed delta. If `delta`
were strictly signed and the engine had a single `AdjustHeight(delta)`,
we'd save a method and the failure mode disappears entirely.

Fix sketch:

```csharp
// Reject the ambiguous form, fail loud:
public TerrainEditResult Raise(float x, float y, float radius, int delta = 5) {
    if (delta < 0) throw new ArgumentException(
        $"raise requires delta >= 0; got {delta}. Use 'lower' for negative.");
    RequireProject();
    var (doc, tl, hl) = GetTerrainHelpers();
    var affected = _terrainService.GetAffectedVertices(new Vector3(x, y, 0), radius, hl);
    var changes = _terrainService.ComputeRaiseLower(affected, delta, tl);
    return ApplyHeightEdit(doc, changes);
}
```

Or merge raise+lower per the recommended refactor (§3).

---

### 1.2 Risks

#### R1 — No validation of `x`, `y`, `radius` for NaN, infinity, or negative radius
`JsonCommandProcessor.cs:517-547`, helper at `:1868-1869`. `F(node, field)`
extracts a `float` and throws on missing — but accepts `NaN`, `+Inf`, `-Inf`,
arbitrarily large magnitudes, and negative radii. These flow straight into
`_terrainService.GetAffectedVertices(new Vector3(x, y, 0), radius, hl)`.

`(uint)Math.Floor(NaN/192f)` is implementation-defined behavior in C#
(documented to return 0 for `Math.Floor(NaN)`, then `(uint)0` is benign — but
the intermediate `worldX/192f` and downstream consumers are not all benign).
A negative radius probably yields an empty affected-set silently. An infinite
radius probably allocates huge intermediate collections and OOMs.

The user-visible consequence is variable: silent no-op (radius=0 or negative),
absurdly large no-op-shaped allocation (infinity), or worse if downstream code
trusts the inputs. None of these get a clean error.

Fix sketch: a single `ValidateWorldPoint(x, y)` and `ValidateRadius(radius)`
helper inside `JsonCommandProcessor` (or, better, the engine entry point) that
rejects non-finite values and clamps radius to `[0.001f, MAX_RADIUS]`.

---

#### R2 — `smooth` strength is unbounded
`JsonCommandProcessor.cs:519` defaults to `0.5f` but accepts any finite float.
`_terrainService.ComputeSmooth` presumably interprets it as a 0..1 blend
factor; values outside that range will over-extrapolate (strength > 1) or
sharpen instead of smooth (strength < 0). This is not catastrophic, but it
silently degrades the operation's contract. Same fix shape as R1.

---

#### R3 — `Load` swallows each auto-loader's exception independently with no aggregate failure surface
`CommandEngine.cs:112-200`. Six `try { ... } catch (Exception ex) { Console.Error.WriteLine(...); }`
blocks. Each one logs and continues. The `LoadResult` returned to the JSON
caller has no field describing how many auto-loaders fired, succeeded, or
failed. So a JSON agent that issues `load` and gets `{"success": true}` cannot
distinguish "everything restored cleanly" from "ontology cache exists but is
corrupt and was silently dropped."

Per the brief: yes, `Load` does leave the engine in an inconsistent state if
one auto-loader partially fails (e.g., town gazetteer parses but POI
gazetteer throws halfway through — POIs become `new()` and town gazetteer
keeps the loaded data). Whether that's *bad* depends on the downstream
command's behavior with empty POIs (likely "fall back to inference" — fine).
The structural problem is that the caller can't tell. Recommend extending
`LoadResult` with an `AutoRestoreReport` (per-loader status + counts), and
serializing it from `CmdLoad`.

Channel question: stderr is the wrong channel for a JSON-RPC server. The
engine's own XML doc claims it "never touches Console or JSON directly"
(CommandEngine.cs:25). Twelve `Console.Error.WriteLine` calls in `Load`
contradict that. Stderr does not corrupt the stdout JSON-RPC frame, so it's
not a protocol bug, but: (a) most JSON callers don't capture stderr, and
(b) it's the engine making a presentation decision the engine should not be
making. Move these into the result record so the JSON layer can decide what
to surface.

---

#### R4 — Exporting while another async export is in flight is unprotected
`CommandEngine.cs:228-321`. Neither `Export` nor `ExportWithRepositionAsync`
takes a lock or checks for an in-progress export. If a JSON agent fires two
`export` commands back-to-back (or REPL+JSON simultaneously), both can race
into `_projectManager.ExportDats` and the reposition's
`InstanceRepositionService.RunAsync`. This is more theoretical than active
(the REPL is single-threaded and JSON-RPC is line-by-line on stdin), but if
JSON mode ever gets concurrent dispatch, this is the first thing that breaks.

---

### 1.3 Smells

#### S1 — `success = true` is hardcoded on every terrain-edit handler
`JsonCommandProcessor.cs:521, 529, 537, 545, 553`. `TerrainEditResult` has no
`Success` field — only `VerticesModified` and `ModifiedLandblocks`. The
serializer therefore *cannot* report failure for these ops; the only failure
mode is an exception that gets caught at the dispatcher.

The user-visible consequence: a `set-height` against out-of-bounds coordinates
returns `{"success": true, "verticesModified": 0, "landblocks": []}`. A
caller has to look at `verticesModified` to detect "the command did nothing."
Most callers won't, and won't know they should. The `success` field is then
actively misleading — present, hardcoded, ignored.

Two ways to honest this up: (a) add `bool Success` to `TerrainEditResult`,
defined as `VerticesModified > 0`, and let the engine set it; or (b) make the
serializer compute it from `r.VerticesModified > 0`. The brief's spirit
prefers (a) because it makes the engine the source of truth. Either is
better than the current literal.

---

#### S2 — Five-line edit pattern duplicated four times (and varied for `paint`)
`CommandEngine.cs:376-411`. `Smooth`, `Raise`, `Lower`, `SetHeight` are
identical except for the `Compute*` call:

```csharp
RequireProject();
var (doc, tl, hl) = GetTerrainHelpers();
var affected = _terrainService.GetAffectedVertices(new Vector3(x, y, 0), radius, hl);
var changes = _terrainService.ComputeXxx(affected, ..., tl);
return ApplyHeightEdit(doc, changes);
```

Today this is fine: four sites, each four-to-five lines, differ only in the
compute step. The reason it's flagged: per §Why in the brief, ridge / erode /
slope tools are about to land. Going from four sites to seven keeps the
copy-paste alive long enough that someone *will* add a new cross-cutting
concern (input validation, undo support, dirty-tile invalidation,
transactional rollback) to one of the seven and forget the others. That is
the durable failure mode. See §3 for the proposed refactor.

`Paint` (CommandEngine.cs:408-436) is the same shape with a different body —
it builds `batchChanges` inline rather than going through `ApplyHeightEdit`,
because it edits the `Type` field instead of `Height`. A unified
`ApplyTerrainEdit` would absorb both via a per-field updater lambda.

---

#### S3 — Argument units are inconsistent across the edit family
`CommandEngine.cs:376-405`.

| Op | Unit |
|---|---|
| `set-height` | `byte` index into `LandHeightTable` (~Z/2) |
| `raise`/`lower` | signed `int` "delta" in index space |
| `smooth` | `float` blend factor (notionally 0..1) |
| `paint` | `byte` terrain-type enum |

Callers must know that "raise by 5" means "5 height-table indices" not
"5 meters" not "5 units of strength." There is no documentation in
`CommandResults.cs` or the JSON handlers naming the units. This bites
especially hard on `set-height` (see B3) where `byte height = 100` is
"about 200 m".

---

#### S4 — `info` returns `success = true` when no project is loaded
`JsonCommandProcessor.cs:507`. `{"success": true, "command": "info", "loaded": false}`
is the response when the engine has no project. `loaded=false` is the right
signal, but doubling it with `success=true` makes "did the command succeed"
mean "did the dispatcher not throw," which is true for nearly every command
and therefore conveys no information. Either drop the `success` field for
`info` or define it as `r.Loaded`. (Minor — but if `success` is going to
mean something elsewhere, it should mean the same thing here.)

---

## 2. Cross-cutting observations

**Validation strategy.** The JSON layer has no schema-level validation. Each
handler does ad-hoc extraction with `node[field]?.GetValue<T>() ?? throw`,
and a missing required field is the only thing that produces a clean error.
Out-of-range numerics, NaN, negative radii, oversized indices, and string-vs-number
type confusion all either pass through or throw a low-level message that
doesn't mention the field. A central `JsonArgs` helper (with `RequiredFloat`,
`RequiredFiniteFloat`, `RequiredByte`, `RequiredCoord`, etc.) would catch
~80% of the risk findings at one site instead of per-handler.

**Side-effect channels.** Three different channels for "something happened":
(a) the JSON response (canonical), (b) `Console.Error.WriteLine` from the
engine (Load auto-loaders), (c) caught-and-rethrown `Exception.Message`
strings from the dispatcher (everything else). A JSON consumer driving the
terminal headlessly only sees (a). Recommend: kill (b) entirely by adding
`AutoRestoreReport` records to `LoadResult`, and standardize (c) by wrapping
`ArgumentException` separately from generic `Exception` so the response can
include an error category, not just a string.

**Test coverage gap (inferred).** The engine takes six services as
constructor args, which would suggest mockability. But the reachable code
paths immediately call `_projectManager.CurrentProject!.DocumentManager
.GetOrCreateDocumentAsync<TerrainDocument>("terrain").GetAwaiter().GetResult()`
(via `GetTerrainDoc`) — the document manager isn't behind any of the injected
interfaces. A unit test for `Smooth(0, 0, 10)` requires a real project on
disk, or a fake `HeadlessProjectManager`. The five terrain-edit ops, the six
auto-loaders, and the reposition export almost certainly aren't covered by
fast unit tests today; observation, not measurement.

**Transactional model.** None of the terrain-edit ops are transactional. If
`UpdateLandblocksBatchInternal` throws partway through (out-of-memory, disk
issue), some landblocks will have been mutated and others won't. There's no
rollback. This is acceptable for an interactive editor where the user can
re-load and try again, but it means JSON callers shouldn't assume "either the
whole edit succeeded or nothing changed." Worth flagging in the JSON contract
docs.

---

## 3. Recommended refactor

Introduce a single `ApplyTerrainEdit` entry point on `CommandEngine` that
absorbs `Smooth`, `Raise`, `Lower`, `SetHeight`, and `Paint`. Concretely, in
`WorldBuilder.Terminal/CommandEngine.cs`:

```csharp
public enum TerrainEditOp { Smooth, Raise, Lower, SetHeight, Paint }

public TerrainEditResult ApplyTerrainEdit(
    TerrainEditOp op, float x, float y, float radius, TerrainEditParams p) {
    RequireProject();
    ValidateBrush(x, y, radius);   // single place for NaN/Inf/negative checks
    var (doc, tl, hl) = GetTerrainHelpers();
    var affected = _terrainService.GetAffectedVertices(new Vector3(x, y, 0), radius, hl);
    return op switch {
        TerrainEditOp.Smooth    => ApplyHeightEdit(doc, _terrainService.ComputeSmooth(affected, p.Strength, tl)),
        TerrainEditOp.Raise     => ApplyHeightEdit(doc, _terrainService.ComputeRaiseLower(affected,  p.Delta, tl)),
        TerrainEditOp.Lower     => ApplyHeightEdit(doc, _terrainService.ComputeRaiseLower(affected, -p.Delta, tl)),
        TerrainEditOp.SetHeight => ApplyHeightEdit(doc, _terrainService.ComputeSetHeight(affected, p.HeightIndex, tl)),
        TerrainEditOp.Paint     => ApplyPaintEdit(doc, affected, p.TerrainType, tl),
        _ => throw new ArgumentOutOfRangeException(nameof(op))
    };
}
```

The five JSON handlers in `JsonCommandProcessor` collapse into one
`CmdTerrainEdit` plus a thin per-op param parser. `TerrainEditResult` gains a
`bool Success` so the serializer stops hardcoding `success = true`. Adding
ridge / erode / slope becomes "add an enum value, add a `Compute*` call" —
*not* "copy-paste a five-line method, hope you remember to add the same
validation that exists everywhere else."

This is the single change with the highest leverage on the next month of
work. It does not require touching `_projectManager`, `_terrainService`, or
`CommandResults.cs`'s public shape (only the addition of `Success`). It
opens the door to undo/redo and dirty-tile invalidation later by giving
those concerns a single insertion point.

---

## 4. What was *not* a problem

- **`CmdExport` honestly threads `r.Success`** (`JsonCommandProcessor.cs:502`).
  This is the *only* serializer in the in-scope set that doesn't hardcode
  `success = true`. Worth preserving.
- **`InvalidateCaches()` ordering in `Load`** is correct: project swap →
  cache invalidate → auto-loaders. Reads against `_terrainDocCache` /
  `_heightTableCache` after a load won't return stale data.
- **`region_gazetteer.json` auto-loader** explicitly resets `_regions`,
  `_regionAnchors`, and `_lbToRegionCache` *before* the `try`
  (`CommandEngine.cs:189-191`). This is the only auto-loader that handles
  state cleanup correctly when the file is absent. (See B1 for the inverse
  case in the ontology block — this loader is the model the others should
  follow.)
- **`LoadResult` and `ProjectInfoResult` field shapes** are honest:
  non-nullable on the loaded path, nullable + `Loaded=false` on the unloaded
  path. No surprises in the record contracts themselves — only in how
  `CmdInfo` wraps them (S4).
- **`FormatLbs` / `FormatLbsArray`** (`JsonCommandProcessor.cs:1874-1884`)
  is correct, allocation-aware, and returns a stable hex format. No issue.
- **`ApplyHeightEdit`** (`CommandEngine.cs:9912-9935`) is the right
  abstraction shape for the height-edit family — the recommended refactor
  generalizes it, doesn't replace it.
- **The five-line edit duplication is small enough today that it isn't a
  bug.** The flag is forward-looking (§S2 / §3): adding three more ops
  without unifying the entry point is what bakes the cost in.
