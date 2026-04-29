# Code Review Prompt — Project + Terrain Editing Commands

> Use this prompt to brief a reviewer (human or agent) for a focused review
> of the `load` / `export` / `info` and `smooth` / `raise` / `lower` /
> `set-height` (and adjacent) terrain commands in WorldBuilder.Terminal.
> The structure is **Context → Intent → Objectives → Why** so the reviewer
> understands the situation, what they're being asked to do, what they
> need to deliver, and what motivates the review.

---

## Context

WorldBuilder.Terminal is the headless command surface for the WorldBuilder
project — a desktop and CLI tool that loads Asheron's Call DAT/PortalDat
worlds (`.wbproj` projects), allows in-memory edits, and re-exports
modified DATs. Two C# files dominate the command surface:

- `WorldBuilder.Terminal/JsonCommandProcessor.cs` — JSON-RPC-style adapter.
  Maps command names to handlers (`Commands` dictionary at line ~150),
  parses the JSON payload, calls the engine, and serializes the result.
  Every `success = true` literal in this file is a result-shape contract,
  not a runtime check.
- `WorldBuilder.Terminal/CommandEngine.cs` — the actual engine. Holds
  `_projectManager`, `_terrainService`, ontology service, building
  pairings, etc. Public methods are the canonical API; the JSON layer
  is a thin envelope.

### In-scope command surface

| Command | JSON handler | Engine method | Engine line |
|---|---|---|---|
| `load` | `CmdLoad` (JsonCommandProcessor.cs:489) | `Load(string projectPath)` | CommandEngine.cs:106 |
| `export` | `CmdExport` (:497) | `Export(directory, iteration?)` | :228 |
| `export` (async with reposition) | — | `ExportWithRepositionAsync(...)` | :234 |
| `info` | `CmdInfo` (:505) | `GetInfo()` | :363 |
| `smooth` | `CmdSmooth` (:517) | `Smooth(x, y, radius, strength=0.5)` | :376 |
| `raise` | `CmdRaise` (:525) | `Raise(x, y, radius, delta=5)` | :384 |
| `lower` | `CmdLower` (:533) | `Lower(x, y, radius, delta=5)` | :392 |
| `set-height` | `CmdSetHeight` (:541) | `SetHeight(x, y, radius, byte targetHeight)` | :400 |
| `paint` (in scope as the same-shape neighbor) | `CmdPaint` | `Paint(x, y, radius, terrainType)` | :408 (~) |

Adjacent terrain commands worth glancing at for cross-cutting symmetry:
`fill`, `road`, `get-height`, `terrain-info`, `paste-stamp`,
`get-bulk-heightmap`, `diff-terrain`, `get-terrain-layers`. These are
out-of-scope for deep review but should be sampled if a reviewer suspects
a pattern issue applies to them too.

### Patterns the reviewer will see

- **JSON layer**: every handler pulls fields with `node["x"]?.GetValue<T>()`
  and either falls back to a default or throws `ArgumentException`.
  `F(node, "x")` (helper) extracts a required float. There is no
  schema-level validation — radius < 0, NaN, infinities all flow through.
- **Engine layer, project ops**: `Load` does several best-effort
  auto-restores (ontology cache, building pairings, town gazetteer) inside
  `try { } catch { }` blocks that log to stderr and continue. `InvalidateCaches`
  is called once at the top.
- **Engine layer, terrain ops**: every edit method follows an identical
  five-line pattern — `RequireProject()`, `GetTerrainHelpers()`,
  `_terrainService.GetAffectedVertices(...)`, `_terrainService.ComputeXxx(...)`,
  `ApplyHeightEdit(doc, changes)`. Differences are confined to which
  `ComputeXxx` runs and what the parameter clamp is. This DRY
  near-miss is a deliberate review target.
- **Result types**: `LoadResult`, `ExportResult`, `ProjectInfoResult`,
  `TerrainEditResult` live in `WorldBuilder.Terminal/CommandResults.cs`.
  Several handlers serialize `success = true` regardless of whether the
  underlying call signaled failure (e.g. `ExportResult.Success` is
  ignored in some serializations).

---

## Intent

Conduct a tight code review of the in-scope commands focused on
**correctness, contract honesty, and review-able structural issues**.
This is *not* a stylistic pass — naming nits, brace style, and trivial
refactors are out of scope unless they obscure a real defect.

The reviewer should:

1. Read the JSON handler and the engine method together as one logical
   unit per command. Treat `JsonCommandProcessor.cs` as the public API
   surface (it's what every external caller sees) and `CommandEngine.cs`
   as the implementation that has to match the contract.
2. Cross-reference `CommandResults.cs` to see what shape callers depend on.
3. Sample one adjacent terrain command (e.g. `paint`) to test whether
   issues found in the in-scope four also apply to the wider family.

Do **not** modify code as part of this pass. Output is a written review.

---

## Objectives

Deliver a markdown review document with these sections, in this order:

### 1. Findings, severity-ordered

For each finding: file:line, one-sentence summary, then a paragraph that
explains the failure mode, the user-visible consequence, and a concrete
fix sketch. Severity buckets:

- **Bug** — wrong output, data loss, crash, or contract violation.
- **Risk** — works today but a foreseeable input or sequencing breaks it
  (e.g. unvalidated NaN radius, race during async export, swallowed
  exception that silently corrupts state).
- **Smell** — duplicated logic, dishonest result fields (`success = true`
  hardcoded), missing back-pressure, etc. — costs maintenance even if
  not actively broken.

Required coverage (call out explicitly even if "no issue found"):

- `Load`'s three best-effort auto-loaders. Do they leave the engine in a
  consistent state if one partially fails? Is logging to `Console.Error`
  the right channel for a JSON-RPC server?
- `Export` and `ExportWithRepositionAsync` divergence — same command name
  in CLI but two distinct engine methods with different semantics. When
  does the JSON layer pick which? What's the failure-mode contract for
  each?
- The terrain-edit five-line pattern. Is the duplication earning its
  keep, or is there a `TerrainEdit(op, x, y, radius, params)` shape
  hiding behind it?
- `set-height` takes `byte` for `targetHeight` but `JsonNode.GetValue<byte>()`
  on a JSON number > 255 — what happens? Is that the right contract for
  an edit-the-world command?
- `raise` / `lower` accept signed `int` delta then take `Math.Abs(delta)`.
  What does negative delta mean to a caller, and is the silent-positive
  the right behavior?
- Result honesty — every `CmdSmooth`/`CmdRaise`/etc. serializes
  `success = true` unconditionally. Is the underlying `TerrainEditResult`
  always successful by construction, or is the JSON layer hiding errors?

### 2. Cross-cutting observations

Patterns that span multiple commands. Examples (the actual list comes
from the review):

- Validation strategy across the JSON layer.
- Side-effect channels (stderr logs, in-memory mutation, no transactional
  rollback on partial failure).
- Test coverage gap inferred from reading the code (don't run the test
  suite — observe call shapes that look untestable).

### 3. Recommended refactor (one paragraph)

If the reviewer would propose a single change to make the next
month of changes easier on this surface, what is it? Just one. State
it concretely with a target file and the shape of the change.

### 4. What was *not* a problem

A short list of things the reviewer specifically checked and found
fine. This is the antidote to "every review finds problems": it
distinguishes what was looked at and approved from what wasn't looked at.

---

## Why

Three reasons the review matters now:

1. **The terrain-edit family is about to grow.** Ridge / erode / slope-tool
   commands are being scoped. Adding three more commands to a 5-line
   copy-paste pattern bakes the duplication in deeper. A clean spine now
   pays off across the next year of the tool.

2. **`Export` is the only command in this group with side effects on the
   user's filesystem and (optionally) their ACE database.** A silent
   failure here costs a user real work — uncommitted DAT changes that
   they thought shipped. Result-honesty in the JSON layer is a
   user-trust property, not a stylistic preference.

3. **`Load` is the funnel through which every other command becomes
   meaningful.** A partial-load (e.g. project loads but ontology cache
   restore throws and gets swallowed) leaves the engine with mixed
   state where some downstream commands silently degrade. We want to
   know whether the catch-and-continue policy is sound or just
   convenient.

---

## Deliverable

A single markdown file, ~400–800 lines, written to
`docs/code_review_project_terrain_<YYYYMMDD>.md`. Paste-ready. Bug-class
findings should include a literal "fix sketch" code block (not a full
patch — just enough that an implementer can act on it without further
context-gathering).
