# Interior Support Exporter Plan

Date: 2026-04-05

## Why This Exists

The current interior weak-supervision pipeline has reached the practical limit of
what can be recovered from:

- `export-raw-world-facts --ace-db --links`
- `export-envcell-components`

Current status from the extractor line:

- full-world interior pass: `7` silver labels
- curated town-interior pass: `0` silver labels

This is not a threshold problem anymore. It is an export-representation problem.

## Current Export Ownership

The relevant code is already in this repo:

- [`BuildEnvCellComponentJson(...)`](/home/salvia420/WorldBuilder-ACME-Edition/WorldBuilder.Terminal/CommandEngine.cs#L3883)
- [`ExportEnvCellComponents(...)`](/home/salvia420/WorldBuilder-ACME-Edition/WorldBuilder.Terminal/CommandEngine.cs#L3977)
- [`ExportRawWorldFacts(...)`](/home/salvia420/WorldBuilder-ACME-Edition/WorldBuilder.Terminal/CommandEngine.cs#L4170)
- JSON command wiring in [`JsonCommandProcessor.cs`](/home/salvia420/WorldBuilder-ACME-Edition/WorldBuilder.Terminal/JsonCommandProcessor.cs#L1260)
- REPL help wiring in [`TerminalRepl.cs`](/home/salvia420/WorldBuilder-ACME-Edition/WorldBuilder.Terminal/TerminalRepl.cs#L1473)

That means the next move should be implemented in `WorldBuilder.Terminal`, not in
another downstream Python heuristic.

## What The Current Exports Already Give Us

`export-envcell-components` already emits useful geometry:

- per-cell origins and orientations
- per-cell static objects
- local and world positions for static objects
- component bounds
- anchor-relative offsets for anchored components
- portal refs and visible-cell refs

`export-raw-world-facts` already emits useful instance facts:

- ACE instance pose
- `parentGuids` / `childGuids`
- `weenieType`
- component membership for interior ACE instances

## What Is Still Missing

The current exports do not give the interior pipeline the fields it actually
needs for support-aware micro-placement:

1. static object orientation
2. static object support-plane candidates
3. stable support-surface dimensions
4. instance-to-static support candidate lists
5. explicit object-on-object candidate evidence

Without those, the Python layer is forced to guess from nearest-neighbor
geometry and names.

## Recommended Split

Two changes are worth making.

### 1. Extend `export-envcell-components`

This is the minimum useful exporter upgrade.

Add per-static-object fields inside each cell's `staticObjects[]` entry:

- `qw`, `qx`, `qy`, `qz`
- `yawDeg`
- `componentLocalIndex`
- `cellLocalIndex`
- `aabbLocal`
- `supportSurfaceHints`

`aabbLocal` should be conservative, not perfect:

```json
{
  "minX": -0.75,
  "minY": -0.35,
  "minZ": 0.0,
  "maxX": 0.75,
  "maxY": 0.35,
  "maxZ": 1.25
}
```

`supportSurfaceHints` should be optional and multi-valued:

```json
[
  {
    "surfaceClass": "top_plane",
    "supportClass": "table_like",
    "originLocal": {"x": 0.0, "y": 0.0, "z": 0.82},
    "normalLocal": {"x": 0.0, "y": 0.0, "z": 1.0},
    "extentLocal": {"x": 0.65, "y": 0.3},
    "confidence": 0.72,
    "inferenceMode": "model_bounds"
  }
]
```

The first implementation does not need perfect mesh analysis. A conservative
model-bounds approximation is enough to break the current supervision bottleneck.

### 2. Add A New Terminal Export

Add a dedicated command:

- `export-interior-support-candidates`

Purpose:

- join ACE instances with EnvCell static geometry inside the terminal
- emit ranked support-parent candidates per prop
- write deterministic evidence rows for downstream training and review

This should live next to the existing exports in `CommandEngine`.

## Proposed `export-interior-support-candidates` Row

Each row should represent one prop with top-k candidate supports.

```json
{
  "sceneId": "0x0708:0x0104",
  "landblockId": "0x0708",
  "cellId": "0x0104",
  "componentId": "4294967552",
  "prop": {
    "guid": 1879052295,
    "classIdSpace": "wcid",
    "classId": 29205,
    "weenieType": 44,
    "positionLocal": {"x": 60.25, "y": -67.891, "z": -23.995},
    "rotation": {"qw": 1.0, "qx": 0.0, "qy": 0.0, "qz": 0.0}
  },
  "candidates": [
    {
      "rank": 1,
      "supportKind": "static",
      "classIdSpace": "model_id",
      "classId": 33558527,
      "supportClass": "table_like",
      "positionLocal": {"x": 60.89, "y": -67.77, "z": -24.24},
      "supportSurface": {
        "surfaceClass": "top_plane",
        "originLocal": {"x": 60.89, "y": -67.77, "z": -23.75},
        "normalLocal": {"x": 0.0, "y": 0.0, "z": 1.0},
        "extentLocal": {"x": 0.65, "y": 0.3}
      },
      "relativePosition": {"x": -0.12, "y": 0.31, "z": 0.03},
      "horizontalDistance": 0.33,
      "heightAboveSupportPlane": 0.03,
      "sameCell": true,
      "sameComponent": true,
      "score": 0.86,
      "scoreBreakdown": {
        "surfaceFit": 0.35,
        "heightFit": 0.24,
        "distanceFit": 0.18,
        "semanticFit": 0.09
      }
    }
  ]
}
```

## Minimum CLI Surface

JSON mode:

```json
{
  "command": "export-interior-support-candidates",
  "outputPath": "pipeline_data/reference/interior_support_candidates.jsonl",
  "includeAceDb": true,
  "topK": 3,
  "interiorsOnly": true
}
```

REPL mode:

```text
export-interior-support-candidates interior_support_candidates.jsonl --ace-db --top-k 3 --interiors-only
```

## Why This Is Better Than More Python Heuristics

The terminal already has access to the actual DAT-side EnvCell structures and
the component-building logic. That is the right layer to compute:

- stable static-object frames
- per-model support planes
- support-surface extents
- candidate lists that are geometry-aware before data leaves the exporter

Trying to reconstruct all of that later from flattened JSON rows is the wrong
abstraction boundary.

## Minimum Implementation Order

1. Extend `BuildEnvCellComponentJson(...)` to export static object orientation.
2. Add conservative per-static-object `aabbLocal`.
3. Add optional `supportSurfaceHints` for obvious top-plane furniture.
4. Add `export-interior-support-candidates`.
5. Update the Python extractor to consume terminal-emitted candidates first and
   only fall back to local heuristics when terminal support metadata is absent.

## Acceptance Criteria

The exporter change is successful if a rerun produces at least one of:

- hundreds of ranked support candidates with explicit surface geometry
- dozens of promotion-eligible silver labels without loosening the Python rules
- repeated support-relative motifs from terminal-side candidate rows

If none of those happen, the next step should be to enrich DAT-side model
metadata, not to relax extractor thresholds again.
