# Code Review Prompt — Terrain Queries & Object Management

> Use this prompt to brief a reviewer (human or agent) for a focused review of
> the `get-height` / `terrain-info` / `get-heightmap` / `get-terrain-data`
> terrain-query commands and the `list-objects` / `add-object` /
> `remove-object` / `move-object` / `rotate-object` object-management
> commands in WorldBuilder.Terminal.
> Structure: **Context → Intent → Objectives → Why**.

---

## Context

This is the second focused review on the WorldBuilder.Terminal JSON command
surface. The first review covered project + terrain-edit commands and the
findings were implemented in commit `ba7db8f`
(`docs/code_review_project_terrain_20260429.md`). The conventions established
there carry forward — a reviewer should treat them as the baseline and flag
divergence:

- `F(node, "x")` rejects NaN / ±Infinity at the JSON layer.
- `ByteInRange(node, "field")` reports the field name + valid range.
- `FloatInRange(node, "field", min, max, fallback)` for bounded floats.
- `TerrainEditResult.Success` is a computed property; serializers thread it
  rather than hardcoding `success = true`.
- `LoadAutoRestoreReport` carries per-loader status; the engine no longer
  writes to `Console.Error`.

### In-scope command surface

| Command | JSON handler | Engine method | Engine line |
|---|---|---|---|
| `get-height` | `CmdGetHeight` (JsonCommandProcessor.cs:634) | `GetHeight(x, y)` | CommandEngine.cs:568 |
| `terrain-info` | `CmdTerrainInfo` (:644) | `GetTerrainInfo(lbX, lbY)` | :594 |
| `get-heightmap` | `CmdGetHeightmap` (:654) | `GetHeightmap(lbX, lbY)` | :619 |
| `get-terrain-data` | `CmdGetTerrainData` (:663) | `GetTerrainData(lbX, lbY)` | :642 |
| `list-objects` | `CmdListObjects` (:679) | `ListObjects(lbX, lbY)` | :786 |
| `add-object` | `CmdAddObject` (:795) | `AddObject(lbX, lbY, modelId, x, y, z, q?, scale?, snap)` | :1139 |
| `remove-object` | `CmdRemoveObject` (:818) | `RemoveObject(lbX, lbY, index)` | :1165 |
| `move-object` | `CmdMoveObject` (:827) | `MoveObject(lbX, lbY, index, x, y, z)` | :1175 |
| `rotate-object` | `CmdRotateObject` (:865) | `RotateObject(lbX, lbY, index, q)` | :1188 |

Adjacent commands worth glancing at for cross-cutting symmetry: `clear-objects`,
`get-bulk-heightmap`, `query-radius`, `describe-landblock`, `get-object-detail`.
Out-of-scope for deep review but should be sampled if a pattern issue applies.

### Result types

`HeightQueryResult`, `TerrainInfoResult`, `HeightmapResult`,
`TerrainDataResult`, `TerrainVertexInfo`, `ListObjectsResult`,
`AddObjectResult`, `RemoveObjectResult`, `MoveObjectResult`,
`RotateObjectResult` live in `WorldBuilder.Terminal/CommandResults.cs`
(lines 200-256).

### Patterns the reviewer will see

- **Query engine ops** (terrain-info, get-heightmap, get-terrain-data) all
  start with the same prelude: `RequireProject()`, `LbKey(lbX, lbY)`,
  `GetTerrainDoc().GetLandblockInternal(lbKey)`, return-Found-false-if-null,
  then read 81 vertices. The duplication is a deliberate target.
- **Object engine ops** all use `GetLandblockDoc(lbKey)` which resolves via
  `DocumentManager.GetOrCreateDocumentAsync<LandblockDocument>(...)`. Note
  the **GetOrCreate** semantics — a query against a nonexistent landblock
  silently creates an empty document.
- **`ValidateObjectIndex`** (CommandEngine.cs:9991) is the only validator on
  the object surface. It throws `ArgumentException` with a count-aware
  message; called by remove/move/rotate but not add.
- **modelId** is parsed in exactly one place (`CmdAddObject`:797-798) using
  `uint.Parse(s.Replace("0x", ""), HexNumber)`. Other handlers receive
  modelId only as output.
- **Result honesty inheritance:** `RemoveObjectResult.Success` is real; every
  other in-scope result either lacks a `Success` field or has the JSON layer
  hardcode `success = true`.

---

## Intent

Conduct a tight code review focused on **correctness, contract honesty,
and review-able structural issues** across this command family. Stylistic
nits are out of scope unless they obscure a defect.

The reviewer should:

1. Read the JSON handler and the engine method together as one logical
   unit per command.
2. Cross-reference `CommandResults.cs` for caller contract.
3. Look for divergence from the conventions established in the project +
   terrain-edit review (commit `ba7db8f`); when a similar fix applies,
   call it out using the Phase-1 helper or pattern by name.
4. Sample one adjacent command (e.g. `query-radius` or `clear-objects`)
   to test cross-cutting reach.

Do **not** modify code as part of this pass. Output is a written review.

---

## Objectives

Deliver a markdown review document with these sections, in this order:

### 1. Findings, severity-ordered

For each finding: file:line, one-sentence summary, then a paragraph that
explains the failure mode, the user-visible consequence, and a concrete
fix sketch. Severity buckets: **Bug** / **Risk** / **Smell** (same
definitions as the prior review).

Required coverage (call out explicitly even if "no issue found"):

- **`get-height` out-of-bounds**. `WorldToVertex` returns null for off-map
  positions but `hl(x, y)` still produces a height value. What does the
  serialized response look like? Can a JSON caller distinguish "valid
  position with height 0" from "off-map garbage"?
- **`lbX` / `lbY` bounds**. `U(node, "lbX")` accepts any `uint`; AC valid
  range is 0..254. What happens when `lbX = 300`? Trace the
  `LbKey((300 << 8) | lbY)` math.
- **Lazy-create LB docs**. `GetLandblockDoc` calls `GetOrCreateDocumentAsync`,
  meaning every object-mgmt command against a nonexistent landblock silently
  creates an empty doc. Walk through `list-objects 0x9999`, `add-object` to
  the same key, `remove-object` of index 0. What's the user-visible signal
  in each case?
- **`add-object` modelId parsing**. `uint.Parse(s.Replace("0x", ""),
  HexNumber)` — what happens with `"0X12345678"` (uppercase X), trailing
  whitespace, or a JSON number instead of a string? Compare to how
  `ByteInRange` handles its error path.
- **`add-object` modelId validation**. Is the parsed modelId checked
  against the loaded DAT (Setup or GfxObj) before being stored? What
  happens downstream when an invalid modelId is rendered or exported?
- **`move-object` landblock-locality**. Engine writes `obj.Origin = (x, y, z)`
  without checking that the new world position falls within the landblock
  the object is attached to. Construct the failure scenario and describe
  what render/export does with an "object in LB 0xA9B4 with world coords
  belonging to LB 0xA9B5".
- **Quaternion piecemeal defaults**. `add-object` and `rotate-object` default
  qw=1, qx=qy=qz=0 individually. What does `{"qx": 1}` produce after
  Quaternion.Normalize? Is "all-or-none" the better contract?
- **Result honesty**. Catalog every in-scope command: does the JSON layer
  hardcode `success = true`, or thread `r.Success`? For each query op,
  what should `success` mean — "the LB exists" or "the dispatcher didn't
  throw"?
- **Query-engine duplication**. The four terrain-query engine methods all
  begin with the same `RequireProject() → LbKey → GetTerrainDoc()
  .GetLandblockInternal(lbKey) → return-Found-false-if-null` prelude. Is
  this earning its keep, or is there a `TryGetLandblockTerrain(lbX, lbY,
  out data)` helper hiding behind it?
- **Index-extraction duplication**. `remove`, `move`, `rotate` all repeat
  `int index = node["index"]?.GetValue<int>() ?? throw ArgumentException("Missing 'index'")`.
  Worth a one-line helper?
- **World-coordinate validation**. `add-object` and `move-object` accept
  arbitrary `(x, y, z)` floats (post-Phase-3, finiteness is checked but
  range is not). AC world is 0..48768m on each axis. Does anything
  downstream catch out-of-range coords?

### 2. Cross-cutting observations

Patterns that span multiple commands. Examples (the actual list comes
from the review):

- Validation strategy gaps relative to the Phase-1 helpers
  (`ValidateBrush`, `ByteInRange`, `FloatInRange`).
- Doc-existence semantics: when does a "missing landblock" become a
  silent-empty result versus a clear error?
- Result-honesty drift: how many handlers still hardcode `success = true`?
- Test coverage gap inferred from reading the code (don't run the test
  suite — observe call shapes that look untestable).

### 3. Recommended refactor (one paragraph)

If the reviewer would propose a single change to make the next month
of changes easier on this surface, what is it? Just one. State it
concretely with a target file and the shape of the change. Preferred
shape: a helper or contract change that the *next* command added to
this family inherits for free.

### 4. What was *not* a problem

A short list of things the reviewer specifically checked and found
fine. This is the antidote to "every review finds problems": it
distinguishes what was looked at and approved from what wasn't looked at.

---

## Why

Three reasons the review matters now:

1. **Object commands are about to grow.** `bulk-place-objects`,
   `auto-paint`, and population-pipeline batch ops all funnel through the
   same `GetLandblockDoc` / `AddStaticObject` paths. Whatever validation
   gap exists in `add-object` today is a multiplier for those commands.

2. **The lazy-create-LB-doc behavior is the largest unaudited blast
   radius on this surface.** Phantom landblocks accept writes; the user
   has no signal that nothing was actually saved (until export, possibly
   later). This needs to be characterized before more commands are
   layered on top.

3. **Phase-1 established conventions that are not yet uniform.** The
   terrain-query and object-mgmt families predate the validation helpers
   and the `Success`-on-result contract. Catching the divergence now —
   while the helper set is small and the change pattern is fresh — is
   cheaper than rolling each command into the convention later.

---

## Deliverable

A single markdown file, ~300–700 lines, written to
`docs/code_review_terrain_query_object_mgmt_<YYYYMMDD>.md`. Paste-ready.
Bug-class findings should include a literal "fix sketch" code block
(not a full patch — just enough that an implementer can act on it
without further context-gathering). Reference the helpers introduced
in commit `ba7db8f` by name when proposing fixes — don't re-derive
them.
