# Code Review — Terrain Queries & Object Management Commands

**Date:** 2026-04-29
**Scope:** `WorldBuilder.Terminal/JsonCommandProcessor.cs`,
`WorldBuilder.Terminal/CommandEngine.cs`, `WorldBuilder.Terminal/CommandResults.cs`.
**In-scope commands:** `get-height`, `terrain-info`, `get-heightmap`,
`get-terrain-data`, `list-objects`, `add-object`, `remove-object`,
`move-object`, `rotate-object`. **Sampled neighbors:** `clear-objects`,
`query-radius`, `get-bulk-heightmap`, `get-object-detail`.

This is the second review on the JSON command surface. The first
(`docs/code_review_project_terrain_20260429.md`, commit `ba7db8f`)
introduced `F`, `ByteInRange`, `FloatInRange`, the `r.Success` threading
convention on `TerrainEditResult`, and the `LoadAutoRestoreReport` channel.
Those helpers are the baseline; this pass treats divergence from them as a
finding.

---

## 1. Findings

### 1.1 Bugs

#### B1 — `lbX`/`lbY` over 255 silently alias to a different landblock
`CommandEngine.cs:9917`, every `CmdXxx` that calls `U(node, "lbX")`
(`JsonCommandProcessor.cs:645, 655, 664, 680, 691, 796, 819, 828, 866`).
`U` accepts any `uint`. `LbKey(uint lbX, uint lbY) => (ushort)((lbX << 8) | lbY)`
masks both arguments down to 8 bits via the `ushort` cast. Walk
`LbKey(300, 5)`: `(300 << 8)` is `0x0001_2C00`, OR `5` is `0x0001_2C05`,
cast to `ushort` keeps the low 16 bits = `0x2C05`. The caller asked for
landblock `0x012C_0005` (which doesn't exist in AC's 255×255 grid) and
got LB `0x2C05` — a real landblock, somewhere on the live map.

Worse: `LbKey(256, 0) == 0x0000` and `LbKey(0, 256) == 0x0000` — the
overflow wraps an out-of-bounds query into LB `0x0000` (Eastham, the
starter zone). `terrain-info` against `lbX: 1000, lbY: 1000` returns
data for whatever LB the truncated bits land on, and the caller gets
`{"success": true, "found": true, ...}` with no signal that the input
was nonsense. For object-mgmt commands the failure is worse: `add-object`
to `lbX: 300` writes a real object into a real (aliased) landblock.

`RenderPreview` already validates this at `CommandEngine.cs:674`
(`if (centerLbX > 255 || centerLbY > 255) throw`) — the rest of the
surface was just never updated to match.

Fix sketch:

```csharp
// In JsonCommandProcessor — the same shape as ByteInRange, scoped to lbX/lbY pairs.
private static (uint lbX, uint lbY) Lb(System.Text.Json.Nodes.JsonNode node) {
    uint lbX = U(node, "lbX"), lbY = U(node, "lbY");
    if (lbX > 254) throw new ArgumentException($"'lbX' must be 0..254; got {lbX}");
    if (lbY > 254) throw new ArgumentException($"'lbY' must be 0..254; got {lbY}");
    return (lbX, lbY);
}

// At every call site that currently does `uint lbX = U(...), lbY = U(...)`:
var (lbX, lbY) = Lb(node);
```

The 254 ceiling matches `TerrainAlgorithms.MapSize` (`= 254`) and the
existing `(int)Math.Min(254, ...)` clamp in `QueryRadius`
(`CommandEngine.cs:1258-1259`). A second-best alternative is to push the
check into `CommandEngine.LbKey` and throw there, but the JSON layer is
the natural place because the error message can name the field. Either
change is small and the bug is trivially reproducible.

---

#### B2 — `add-object` modelId parsing rejects valid hex prefixes and silently miscarves whitespace
`JsonCommandProcessor.cs:797-798`.

```csharp
var modelIdStr = node["modelId"]?.GetValue<string>() ?? throw new ArgumentException("Missing 'modelId'");
uint modelId = uint.Parse(modelIdStr.Replace("0x", ""), NumberStyles.HexNumber);
```

Three concrete failure modes: (1) `"0X12345678"` — `Replace("0x", "")`
is case-sensitive, the capital-X prefix survives, `uint.Parse` throws
opaque `FormatException`. (2) `" 0x12345678 "` — `NumberStyles.HexNumber`
does **not** include `AllowLeadingWhite | AllowTrailingWhite`; whitespace
tolerance is opt-in. Same opaque `FormatException`. (3) JSON number form
`{"modelId": 305419896}` — `GetValue<string>()` throws
`InvalidOperationException` because the JSON value is `Number`, not
`String`. The user has no way to know the field is string-only without
reading source.

`ByteInRange` (`JsonCommandProcessor.cs:1938`) is the existing model:
it names the field, names the valid range, and reports the input that
was rejected. modelId parsing should behave the same way. The pattern
is repeated in five other handlers (`get-object-detail:1145`,
`snap-portal:1183-1187`, etc.), so this is also a smell carrier — see
S2.

Fix sketch:

```csharp
// In JsonCommandProcessor helpers section, alongside F/U/ByteInRange:
private static uint Hex32(System.Text.Json.Nodes.JsonNode node, string field) {
    var jv = node[field] ?? throw new ArgumentException($"Missing '{field}' field");
    string raw;
    try { raw = jv.GetValue<string>(); }
    catch (InvalidOperationException) {
        throw new ArgumentException($"'{field}' must be a hex string like \"0x12345678\"; got a JSON number");
    }
    var trimmed = raw.Trim();
    if (trimmed.StartsWith("0x", StringComparison.OrdinalIgnoreCase))
        trimmed = trimmed.Substring(2);
    if (!uint.TryParse(trimmed, NumberStyles.HexNumber,
        System.Globalization.CultureInfo.InvariantCulture, out var v))
        throw new ArgumentException($"'{field}' is not a valid 32-bit hex value; got \"{raw}\"");
    return v;
}

// At call site:
uint modelId = Hex32(node, "modelId");
```

Apply the same helper to `get-object-detail` and `snap-portal` in the
same pass — the repetition is the actual cost.

---

#### B3 — `move-object` writes world coords without checking they belong to the LB the object is attached to
`CommandEngine.cs:1183`. `obj.Origin = new Vector3(x, y, z); lbDoc.UpdateStaticObject(index, obj);`
There is no check that `(x, y)` falls within the LB key the caller passed.

Failure scenario: caller invokes `{"command": "move-object", "lbX": 169,
"lbY": 180, "index": 0, "x": 32600, "y": 34900, "z": 80}` — meaning "move
the first object in 0xA9B4 to world position (32600, 34900)". World
coords (32600, 34900) belong to LB `0xA9B5` (lbX=169, lbY=181 — `34900/192
= 181.77`). The LandblockDocument for `0xA9B4` now contains a static
object whose world Origin is in `0xA9B5`'s footprint.

User-visible consequences: `list-objects` against `0xA9B4` returns the
object at its new world location (looks correct); `query-radius` centered
on the new position misses it because the LB-grid iteration
(`CommandEngine.cs:1256-1267`) only walks LBs whose key falls in the
radius range, and the phantom-resident object in `0xA9B4` is invisible
from a search at the actual location; `SaveToDatsInternal`
(`LandblockDocument.cs:112-128`) writes the object back into `0xA9B4`'s
`LandBlockInfo` with `Frame.Origin` re-localized against the wrong LB
corner — the AC client culls or renders at unexpected coords;
`transact-diff` describes the LB the object was moved *out of*, never
its true new home.

Fix sketch:

```csharp
public MoveObjectResult MoveObject(uint lbX, uint lbY, int index,
    float x, float y, float z) {
    RequireProject();
    ushort lbKey = LbKey(lbX, lbY);
    var lbDoc = GetLandblockDoc(lbKey);
    ValidateObjectIndex(lbDoc, index, "move-object");

    // Reject moves that cross the LB boundary. The user-intent for a
    // cross-LB move is a remove-object + add-object pair, not an in-place
    // mutation of the source LB's static-object list.
    float lbMinX = lbX * 192f, lbMinY = lbY * 192f;
    if (x < lbMinX || x >= lbMinX + 192f || y < lbMinY || y >= lbMinY + 192f)
        throw new ArgumentException(
            $"move-object target ({x:F1}, {y:F1}) is outside landblock 0x{lbKey:X4} " +
            $"footprint [{lbMinX:F0}..{lbMinX+192:F0}, {lbMinY:F0}..{lbMinY+192:F0}]. " +
            $"To move an object across LBs, remove and re-add it.");

    var obj = lbDoc.GetStaticObject(index);
    var oldPos = obj.Origin;
    obj.Origin = new Vector3(x, y, z);
    lbDoc.UpdateStaticObject(index, obj);
    return new MoveObjectResult(lbKey, index, obj.Id, oldPos, obj.Origin);
}
```

Same check should be applied to `add-object` (`CommandEngine.cs:1139`) —
it currently accepts any `(x, y, z)` and stuffs it into the supplied LB.
Doing this in one place — see §3 — is preferable to two near-identical
checks.

---

#### B4 — `add-object` and `move-object` accept world coords that are off the entire AC map
`JsonCommandProcessor.cs:799, 830` (which call `F` for x, y, z) and
`CommandEngine.cs:1149-1157, 1183`. `F` rejects NaN/Inf (good — the
Phase-1 fix), but accepts any finite value. Valid AC world is
`[0, 254*192) = [0, 48768)` on each of x and y; valid z is roughly
`[0, 1020]` (255 height-table indices × ~4 m max scale, but the
LandHeightTable maxes at ~510 m of relief in practice).

Send `{"command": "add-object", "lbX": 0, "lbY": 0, "modelId": "0x02000001",
"x": -50000, "y": 1e8, "z": 0}` and the engine happily creates the
object in LB 0x0000 with Origin (−50000, 1e8, 0). Combined with B3
(no LB-locality check), this means **arbitrary off-map coordinates are
silently accepted into any landblock**, propagating to export.

The coupling with B3 makes this less urgent than it looks — a tight
LB-locality check on `(x, y)` makes off-map detection a free corollary
because the LB-locality range is itself bounded to `[0, 48768)`. But
`add-object` does not currently get the LB-locality check (only
`move-object` does in the proposed B3 fix), and `z` has no bound at
all even with that.

Fix sketch (combine with B3):

```csharp
private static void ValidateLbLocalCoord(uint lbX, uint lbY, float x, float y, string command) {
    float lbMinX = lbX * 192f, lbMinY = lbY * 192f;
    if (x < lbMinX || x >= lbMinX + 192f || y < lbMinY || y >= lbMinY + 192f)
        throw new ArgumentException(
            $"{command}: ({x:F1}, {y:F1}) is outside landblock 0x{((lbX<<8)|lbY):X4} " +
            $"[{lbMinX:F0}..{lbMinX+192:F0}, {lbMinY:F0}..{lbMinY+192:F0}].");
}
private static void ValidateZ(float z, string command) {
    if (z < -1000f || z > 1500f)
        throw new ArgumentException($"{command}: z={z} is outside the AC world Z range.");
}
```

The Z bounds `[-1000, 1500]` are deliberately loose — AC's
`LandHeightTable` indexes max around 510 m above sea level, but
buildings can extend below; the goal is to catch `z = 1e8`, not to be
authoritative.

---

### 1.2 Risks

#### R1 — Lazy-create LB-doc semantics produce a phantom-write blast radius
`CommandEngine.cs:9951-9957`.
`GetLandblockDoc` always calls `DocumentManager.GetOrCreateDocumentAsync<LandblockDocument>(docId)`.
`DocumentManager.cs:122-127, 140-143` shows the **GetOrCreate** semantics
explicitly: when no doc exists in storage, it creates one and persists
it via `DocumentStorageService.UpdateDocumentAsync(documentId,
projection)` *before returning*. There is no read-only path.

Walk through `lbX: 0xA0, lbY: 0xB4` against an empty project: (1)
`list-objects 0xA0B4` → `GetLandblockDoc(0xA0B4)` lazy-creates *and
persists* an empty `LandblockDocument`, returns it, JSON response is
`{"success": true, "count": 0, "objects": []}` — same shape as a real
empty LB. **A phantom doc now exists in project storage.** (2)
`add-object` against the same key → `GetLandblockDoc` returns the
phantom doc from `_activeDocs` cache, `AddStaticObject` succeeds, the
object lives in a doc with no underlying `LandBlockInfo`. (3)
`remove-object index: 0` → `ValidateObjectIndex` passes, removal
returns true, all signals are happy. (4) `export` →
`SaveToDatsInternal` (`LandblockDocument.cs:121-129`) does `if
(!datwriter.TryGet<LandBlockInfo>(infoId, out var lbi)) { lbi = new
LandBlockInfo(); lbi.Id = infoId; }`, so phantom LBs *do* get exported
as new `LandBlockInfo` entries with no `NumCells` data — silent garbage
in the output DAT.

Three asymmetries make this hard to characterize: `list-objects` looks
correct from the JSON contract (empty list, success); `clear-objects`
single-LB (`CommandEngine.cs:1204-1211`) also lazy-creates then clears,
returning `removed=0, success=true`; `clear-objects all=true`
(`ClearAllObjects`, `:1217-1244`) is the only handler that does it
right — it filters by `dats.TryGet<LandBlockInfo>` *before* calling
`GetLandblockDoc`. That filter is the model.

User-visible consequence: a JSON agent issuing read-only-looking
commands (`list-objects`, `terrain-info`, even `describe-landblock`)
against a typo'd LB key silently litters the project storage with
empty docs. None of these mutate the world from the user's
perspective, but they all permanently change project state.

This is the largest unaudited blast radius on this surface (also
called out in the prompt's §Why §2). The fix shape is to add a
`GetLandblockDocReadOnly(lbKey)` that returns `null` when no
underlying `LandBlockInfo` exists in the DAT *and* no doc has been
explicitly created via add-object — and to route every query op
(`list-objects`, terrain-queries, `describe-landblock`) through it.
The `clear-objects all` filter is the prototype.

This is a Risk and not a Bug because (a) phantom-empty-doc artifacts
do not corrupt rendered output (they're filtered or skipped at most
read sites), and (b) no JSON op currently blocks on the phantom doc.
But it's the highest-leverage thing to fix on this surface and the
right one to upgrade to a Bug if the next month adds a command that
*does* break on phantom docs (e.g., a "validate landblock count"
report).

---

#### R2 — `terrain-info`/`get-heightmap`/`get-terrain-data` return `found=false` even after creating a phantom LandblockDocument
`JsonCommandProcessor.cs:644-672`, `CommandEngine.cs:594-657`.
The terrain-query trio uses `GetTerrainDoc().GetLandblockInternal(lbKey)` —
which is *not* lazy-create; it returns `null` for unrecognized LBs and
the result type's `Found = false` propagates correctly to the JSON
layer. Good.

The risk: these handlers do *not* call `GetLandblockDoc(lbKey)`, but
adjacent handlers *do* — so a typical query session that interleaves
(say) `terrain-info` and `list-objects` against the same typo will
see "no terrain data" *and* simultaneously create a phantom landblock
doc. The asymmetry is invisible to the caller.

Make this consistent: either all queries are lazy-create (loud
phantom-LB problem, see R1) or all queries are read-only (preferred —
they refuse to materialize a doc when the underlying DAT has no
`LandBlockInfo`). The right contract for *any* query op is "tell me
about the landblock as-it-is, don't construct a new one."

---

#### R3 — Quaternion piecemeal defaults turn `{"qx": 1}` into a 180° flip about X
`JsonCommandProcessor.cs:801-803` (add-object), `:872-874` (rotate-object).

```csharp
float qw = node["qw"]?.GetValue<float>() ?? 1f, qx = node["qx"]?.GetValue<float>() ?? 0f;
float qy = node["qy"]?.GetValue<float>() ?? 0f, qz = node["qz"]?.GetValue<float>() ?? 0f;
var orientation = Quaternion.Normalize(new Quaternion(qx, qy, qz, qw));
```

A caller intending "rotation about X = 1 (radian or degree, neither —
this is a quaternion component)" sends `{"qx": 1}`. The handler
fills in `qw = 1, qy = 0, qz = 0`, builds `Quaternion(1, 0, 0, 1)`,
and `Normalize` divides by `sqrt(2)` to give
`(W=0.707, X=0.707, Y=0, Z=0)` — a 180° rotation about the X axis,
not the identity-with-X-tweak the caller expected.

This is non-obvious because individually each default looks
defensible: `qw=1, qx=0, qy=0, qz=0` is the identity. The bug is
that *partial* specification changes the meaning of the rotation
silently. The semantic the user wanted is unclear, but the result they
got is **certainly wrong** — and there's no error.

`rotate-object` partially mitigates this with a guard at line 870
that requires *some* Q field (or `yaw`) to be present, but once
inside the branch the same piecemeal logic applies. `add-object`
has no guard at all — `{"command": "add-object", ...}` with no Q
fields gets identity (correct) but `{"qx": 1}` gets 180° X flip
(wrong).

Fix sketch:

```csharp
// Helper in JsonCommandProcessor:
private static Quaternion? ParseQuaternion(System.Text.Json.Nodes.JsonNode node) {
    bool any = node["qw"] != null || node["qx"] != null
            || node["qy"] != null || node["qz"] != null;
    if (!any) return null;
    bool all  = node["qw"] != null && node["qx"] != null
             && node["qy"] != null && node["qz"] != null;
    if (!all) throw new ArgumentException(
        "Quaternion requires all of qw, qx, qy, qz (or none for identity).");
    float qw = node["qw"]!.GetValue<float>(), qx = node["qx"]!.GetValue<float>();
    float qy = node["qy"]!.GetValue<float>(), qz = node["qz"]!.GetValue<float>();
    if (!float.IsFinite(qw) || !float.IsFinite(qx) || !float.IsFinite(qy) || !float.IsFinite(qz))
        throw new ArgumentException("Quaternion components must be finite.");
    return Quaternion.Normalize(new Quaternion(qx, qy, qz, qw));
}

// add-object: var orientation = ParseQuaternion(node) ?? Quaternion.Identity;
// rotate-object: keep yaw branch; the absolute-Q branch becomes:
//   var q = ParseQuaternion(node);
//   newQ = q ?? Quaternion.CreateFromAxisAngle(Vector3.UnitZ, yawDeg * MathF.PI / 180f);
```

The contract is "all-or-nothing" because partial Q is meaningless.
This also handles the NaN case for free.

---

#### R4 — `add-object`/`move-object`/`rotate-object` JSON layer hardcodes `success = true` despite the engine having no failure path
`JsonCommandProcessor.cs:812, 832, 885`. The serializers all start with
`new { success = true, ... }`. The corresponding result records
(`AddObjectResult`, `MoveObjectResult`, `RotateObjectResult`,
`CommandResults.cs:240, 250-252, 254-256`) lack a `Success` field —
they're "data only."

Because the engine throws on missing index, missing project, missing
LB doc (only via lazy-create — see R1), the only way this `success =
true` becomes false is via the dispatcher's catch. So today the field
is **always true on this code path** and conveys no information.

Compare the prior review's S1 (`code_review_project_terrain_20260429.md`
§1.3): the same pattern was called out for terrain-edit handlers and
the fix added `Success` as a computed property on `TerrainEditResult`.
The object-mgmt family escaped that pass because `RemoveObjectResult`
already has a real `Success` field, and the others "didn't seem to
need one." On second look they do — at minimum because asymmetric
honesty is its own confusion.

Honest definitions: `AddObjectResult.Success` = always `true` today,
but thread it from the record so future fail-able paths (R5) inherit the
contract; `MoveObjectResult.Success` = true if the new position passed
the LB-locality check (B3); `RotateObjectResult.Success` = true if the
input was a valid quaternion (R3). For the terrain-query trio, today's
`success = true` means "the dispatcher didn't throw"; the honest
meaning is "the LB exists," which is already encoded in `r.Found`.
Either thread `success = r.Found` or drop the redundant field. For
`get-height`, the equivalent existence signal is
`r.LandblockId.HasValue`.

This is a Risk because the consequences are not direct breakage —
they're contract drift that bites the next agent author who assumes
"success means the thing happened."

---

#### R5 — `add-object` modelId is not validated against the DAT before being stored
`CommandEngine.cs:1139-1162`. `modelId` flows directly into `obj.Id`
and `obj.IsSetup = (modelId & 0x02000000) != 0`. The engine never
asks the DAT whether `modelId` corresponds to a valid `Setup` (0x02)
or `GfxObj` (0x01) entry. A caller can `add-object` with
`modelId = 0xDEADBEEF` and the engine accepts it.

Downstream: `list-objects` returns it; render falls back to a default
glyph (ontology and pairings return null, neither throws);
`describe-landblock` tolerates the gap via `?` chains; `export` writes
the object id as-is into the `LandBlockInfo` / Building record, and the
AC client receives a reference to a model that doesn't exist in the
rebuilt DAT — invisible / fall-through-floor at runtime. The failure
is silent at the JSON layer, silent at every read site, and produces
broken DAT output.

The check is cheap: `_projectManager.CurrentProject!.DocumentManager.Dats.TryGet`
against the appropriate type. But it's not currently performed.

Fix sketch:

```csharp
// In CommandEngine.AddObject, after parsing modelId:
var dats = _projectManager.CurrentProject!.DocumentManager.Dats;
bool isSetup = (modelId & 0x02000000) != 0;
bool exists = isSetup
    ? dats.TryGet<DatReaderWriter.DBObjs.Setup>(modelId, out _)
    : dats.TryGet<DatReaderWriter.DBObjs.GfxObj>(modelId, out _);
if (!exists)
    throw new ArgumentException(
        $"add-object: modelId 0x{modelId:X8} is not a {(isSetup ? "Setup" : "GfxObj")} in the loaded DAT.");
```

The exception path is consistent with `ValidateObjectIndex`
(`CommandEngine.cs:9991`) — engine-thrown `ArgumentException` becomes
`{"success": false, "error": "..."}` at the dispatcher.

This becomes more important when `bulk-place-objects`, `auto-paint`,
and the population pipeline batch-ops land — they'll multiply any
invalid modelId by N. The brief's §Why §1 calls this out explicitly.

---

### 1.3 Smells

#### S1 — Query-engine prelude duplicated four times
`CommandEngine.cs:594-599, 619-624, 642-647, 786-790`.

```csharp
RequireProject();
ushort lbKey = LbKey(lbX, lbY);
var data = GetTerrainDoc().GetLandblockInternal(lbKey);
if (data == null) return new XxxResult(lbKey, lbX, lbY, false);
// ... read 81 vertices ...
```

Three of the four (terrain-info, get-heightmap, get-terrain-data) have
the same five-line prelude differing only in the "no data" return
shape. The fourth (`ListObjects`) has a different prelude because it
goes through `GetLandblockDoc` instead of `GetTerrainDoc().GetLandblockInternal`.

Suggested helper, in `CommandEngine.cs` near the other private helpers:

```csharp
/// <summary>
/// Resolves a landblock's TerrainEntry[] via the terrain doc. Returns
/// (lbKey, null) when the LB has no terrain data in the DAT — query
/// callers should propagate that as Found=false to the JSON layer.
/// </summary>
private (ushort LbKey, TerrainEntry[]? Data) TryGetLandblockTerrain(uint lbX, uint lbY) {
    RequireProject();
    var lbKey = LbKey(lbX, lbY);
    return (lbKey, GetTerrainDoc().GetLandblockInternal(lbKey));
}
```

Each of the three terrain-query methods becomes a 1-line prelude plus
the per-method aggregation. The duplication is small in volume but
high in symmetry — adding a fifth query method (e.g.
`get-vertex-detail`) would copy the same five lines a fourth time.
This refactor also pairs naturally with the §3 recommendation.

---

#### S2 — `index` extraction duplicated three times
`JsonCommandProcessor.cs:820, 829, 867`:

```csharp
int index = node["index"]?.GetValue<int>() ?? throw new ArgumentException("Missing 'index'");
```

Plus the engine-side `ValidateObjectIndex` (`CommandEngine.cs:9991`)
called in `RemoveObject`, `MoveObject`, `RotateObject`. The JSON-side
extraction is missing range checks (negative? >= count?) — those are
re-checked in `ValidateObjectIndex` at the engine layer, but the
"Missing 'index'" message is the only thing the JSON layer contributes.

Add a small helper:

```csharp
private static int RequiredInt(System.Text.Json.Nodes.JsonNode node, string field) =>
    node[field]?.GetValue<int>() ?? throw new ArgumentException($"Missing '{field}' field");
```

Three call sites collapse, and the message format matches the
existing `F` helper (`"Missing 'x' field"`, with the field name
quoted). Negative-index rejection stays in `ValidateObjectIndex`
where it has the count context.

This is a symmetry concern, not a correctness one — `OptionalInt`
already exists at `:1959` and `RequiredInt` is the natural sibling.

---

#### S3 — modelId / cellNumber / polygonId hex parsing repeats `Replace("0x", "")` six times
`JsonCommandProcessor.cs:798, 1077, 1145, 1183, 1185, 1187, 1658`. Each
site repeats:

```csharp
uint x = uint.Parse(s.Replace("0x", ""), NumberStyles.HexNumber);
```

Same correctness gap as B2 in every case (case-sensitive replace,
no whitespace tolerance, no JSON-number fallback). The
proposed `Hex32` helper from B2 fixes all six sites. The cost of not
unifying is that the next handler added to the family will copy the
seventh instance verbatim — and so will its bug.

---

#### S4 — `get-height` height value is `0.0` for off-map points and conflated with on-map sea level
`CommandEngine.cs:568-592`, `JsonCommandProcessor.cs:634-642`.
For an off-map `(x, y)`, `_terrainService.WorldToVertex` returns
`null` (`TerrainAlgorithms.cs:455`), so `lbId`, `vIdx`, `hIdx`,
`type`, `road`, `scenery` are all `null`. But the engine still
calls `hl(x, y)` first; `GetHeightAtWorldPosition`
(`TerrainAlgorithms.cs:382-398`) clamps off-map to `return 0f` —
the same value a real on-map sea-level point would return.

JSON response for off-map:
`{"x": 99999, "y": 99999, "height": 0.0, "landblock": null, ...}`.

Caller-detectable: yes, via `landblock == null`. So this is a Smell,
not a Bug — the contract isn't broken, but `height = 0.0` for
off-map is a misleading number that no caller should look at, and
the JSON layer doesn't wrap it in a "valid" flag. The honest
serialization would emit `height = null` when `lbId == null`. Since
`HeightQueryResult.Height` is `float` (not `float?`), that change
is record-shape-touching; flag for a future pass, not a fix-now.

---

#### S5 — `add-object` returns `scale = { x = sx, y = sy, z = sz }` from the request, not from the persisted object
`JsonCommandProcessor.cs:815`. Compare with the position fields at
`:814` (`Math.Round(r.Object.Origin.X, 2)`) which read from the
result record. `scale` is the only field served from the request
inputs.

Today this is fine because the engine writes scale verbatim — `obj.Scale = scale ?? Vector3.One`
(`CommandEngine.cs:1159`) — and so the request and the persisted value
agree by construction. But if a future engine pass clamps scale (e.g.,
`Vector3.Min(scale, Vector3.One * 1000)`) for sanity, the JSON
response will lie about what was stored. The fix is to read from
`r.Object.Scale.X` etc. like the position fields do; this also makes
the output uniform.

---

#### S6 — `list-objects` lacks a `success` field with honest semantics; relies on dispatcher non-throw
`JsonCommandProcessor.cs:682`. `success = true` is hardcoded. There's
no signal that distinguishes "real LB with no objects" from "phantom
LB just created" (R1). With R1's read-only fix, `success = false`
plus `error = "Landblock 0xA0B4 has no LandBlockInfo"` would be the
right thing for the phantom case; for now this is a smell because
the answer is symmetric to `terrain-info`'s `found` field but uses a
different name.

Suggestion: add a `found` field to `ListObjectsResult` and thread it
through the JSON layer, mirroring the terrain-query trio. After
R1's fix, `found` becomes meaningful.

---

## 2. Cross-cutting observations

**Validation strategy.** Phase-1 introduced `F`, `ByteInRange`,
`FloatInRange`. The Phase-2 surface (terrain-query + object-mgmt) only
adopted `F` and `U`. The remaining input shapes — Q components,
modelId hex strings, `index` ints, `lbX/lbY` ranges — all still parse
inline with `?.GetValue<T>() ?? throw`. The next pass should add at
least three sibling helpers — `Lb`, `Hex32`, `RequiredInt` — to the
existing four. Each helper has the same cost-shape (~5 lines, JSON
file scope), and each one removes ~3-5 inline patterns. The §3 refactor
proposal is essentially "do this."

**Doc-existence semantics.** The surface is split: the terrain-query
trio uses `GetTerrainDoc().GetLandblockInternal` (read-only, returns
null for missing) and serializes `found = false`; the object-mgmt
quartet plus `clear-objects` (single-LB) use `GetLandblockDoc` which
lazy-creates and returns `success = true` for everything. `clear-objects
all=true` is the only handler that filters by DAT presence before
loading the doc. **This is the largest unaudited blast radius on the
surface** (R1) and the convergence target is `clear-objects all=true`'s
filter pattern.

**Result-honesty drift.** Six in-scope handlers hardcode `success = true`
unconditionally:

| Command | Engine `Success` field? | JSON layer |
|---|---|---|
| `get-height` | n/a (no field) | hardcoded `success = true` (S4) |
| `terrain-info` | only `Found` | hardcoded `success = true` |
| `get-heightmap` | only `Found` | hardcoded `success = true` |
| `get-terrain-data` | only `Found` | hardcoded `success = true` |
| `list-objects` | none | hardcoded `success = true` (S6) |
| `add-object` | none | hardcoded `success = true` (R4) |
| `move-object` | none | hardcoded `success = true` (R4) |
| `rotate-object` | none | hardcoded `success = true` (R4) |
| `remove-object` | **`Success`** | threaded `r.Success` |
| `clear-objects` | `Success` | threaded `result.Success` |

Only two in-scope handlers thread an honest `Success`. The pattern
fix is the same shape as the prior review's TerrainEditResult
treatment: add `Success` to the result records (computed property
where it's derivable), thread it from the JSON layer.

**Test coverage gap (inferred).** Every in-scope command requires a
real project on disk to test, because `RequireProject` →
`_projectManager.CurrentProject!.DocumentManager` → `GetOrCreateDocumentAsync`
is not behind any of the six injected services. Cross-LB `move-object`
behavior (B3), phantom LB creation (R1), and modelId DAT validation (R5)
are all reachable only from integration tests against a real project.
Observation: there is no equivalent of `HeadlessProjectManager` mock
used in the existing test surface for these branches; they appear
untested.

**Side-effect channels.** Same as the prior review (`Console.Error`
escapes from `LandblockDescriber`'s validation overlay,
`CommandEngine.cs:858`). Not in this scope to fix but worth noting:
the engine's own XML doc still claims it "never touches Console or
JSON directly" while writing to stderr from validation paths.

---

## 3. Recommended refactor

Add a single small layer of input helpers in `JsonCommandProcessor.cs`
— `Lb(node)`, `Hex32(node, field)`, `RequiredInt(node, field)`,
`ParseQuaternion(node)` — and then push a *contract* change into
`CommandEngine.cs`: collapse `GetLandblockDoc(lbKey)` into two methods,
`GetLandblockDocOrCreate(lbKey)` (keeps current semantics, only used
by `add-object`) and `TryGetLandblockDoc(lbKey, out doc)` (read-only,
returns false when the underlying DAT has no `LandBlockInfo` and no
project-side doc has been explicitly created). Route every query op
(`list-objects`, `clear-objects` single-LB, `move-object`,
`remove-object`, `rotate-object`, and the terrain-query trio's
parallel terrain-doc read) through the read-only path. The phantom-LB
blast radius vanishes; `found = false` becomes the consistent signal
for "no such landblock," parallel to the terrain-query trio's
existing `Found` field. Adding a new query command (e.g.
`get-object-count-by-modelId`) inherits the read-only contract and the
phantom-LB fix for free, instead of having to re-derive it.

This is one change with two parts (helpers + LB-doc split) because
neither alone closes the loop: helpers without the LB-doc split leave
R1 open; LB-doc split without helpers leaves the validation gaps. The
file-shape is `JsonCommandProcessor.cs` adds ~20 lines of helpers and
the engine adds ~10 lines splitting `GetLandblockDoc`.

---

## 4. What was *not* a problem

- **`ValidateObjectIndex`** (`CommandEngine.cs:9991-10001`) is correct
  and honest: names the index, the count, throws `ArgumentException`
  for clean dispatcher conversion. The `ICollection / IReadOnlyCollection
  / fallback` switch avoids materializing the IEnumerable when the
  underlying type isn't opaque. Good.
- **`LbKey` math is correct *for valid input*.** `(ushort)((lbX << 8) | lbY)`
  matches the AC convention everywhere else (`TerrainAlgorithms.XYToLandblockKey`,
  `LandblockDescriber`, transact-diff). The bug (B1) is at the input
  boundary, not in `LbKey` itself.
- **`F` correctly rejects NaN/Inf** for x/y/z in `add-object`/`move-object`.
  The Phase-1 fix carried forward unchanged.
- **`GetTerrainDoc().GetLandblockInternal` is read-only-shaped.** The
  terrain-query trio gets `Found = false` semantics for free; threaded
  through to the JSON serializer at all three sites.
- **`RemoveObjectResult.Success`** is the right shape for the family
  — the rest of the object-mgmt result types should follow this lead (R4).
- **`clear-objects all=true`** correctly filters by `dats.TryGet<LandBlockInfo>`
  before calling `GetLandblockDoc` (`CommandEngine.cs:1230`). The model
  the rest of the object-mgmt surface should adopt — see §3.
- **`rotate-object`'s yaw-shorthand branch** (`JsonCommandProcessor.cs:875-878`)
  is small and correct: degree input, `MathF.PI / 180f` conversion,
  Z-axis rotation. The doc string explicitly notes "this SETS the
  orientation, it does not add to existing rotation" — right thing
  to say when the contract is non-obvious.
- **`get-height`'s off-map signal IS detectable** via `landblock == null`
  / `vertexIndex == null`. Less honest than it could be (S4) but not a
  contract violation.
- **Index range is centrally validated** via `ValidateObjectIndex`;
  remove/move/rotate all use it; add doesn't need it. Uniform where
  it matters.
- **`FmtQ`** (`JsonCommandProcessor.cs:2016`) is correct, allocation-aware,
  rounds to 6 decimals — sufficient precision for a normalized quaternion.
- **`AddObjectResult.Object.Origin` reflects the snap-to-cell-center result**
  when `snap=true`; the JSON layer serializes `r.Object.Origin.X/Y/Z`
  rather than the request inputs (good — except for `scale`, see S5).
- **The lazy-create path uses the `_activeDocs` cache correctly** —
  a phantom LB created by `list-objects` is the same in-memory instance
  returned to a subsequent `add-object`. The blast radius (R1) is real,
  but the docs aren't re-created on every call.
