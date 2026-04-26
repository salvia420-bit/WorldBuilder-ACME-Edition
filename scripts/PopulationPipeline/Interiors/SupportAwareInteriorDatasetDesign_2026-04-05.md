# Support-Aware Interior Dataset Design

Date: 2026-04-05

## Goal

Build a new interior dataset for retail-faithful micro-placement:

- bottle on table
- book on shelf
- candle on desk
- torch on wall
- hook / floor-hook / ceiling-hook aware placement

This is not the same task as broad world grammar or town shell grammar.

The target is closer to recovering local placement intent from human-authored
retail interiors than to generic world-coordinate prediction.

## Why A New Dataset Is Required

Current world-grammar / component-linked training data preserves useful
interior structure, but it is still too coarse for support-aware micro-placement.

Current strengths:

- precise EnvCell/static geometry exists in `export-envcell-components`
- `raw_world_facts` preserves `guid`, `parentGuids`, and `childGuids`
- component membership, bounds, anchor positions, and portal refs are available

Current gaps:

- no explicit support-parent label
- no explicit support-surface class
- no support-relative frame for child objects
- no room-local placement target
- no clear distinction between structural/support objects and micro props

Important clarification from investigation work after this note:

- interior support research must not treat "the building interior" and "the EnvCell component" as the same modeling object
- the anchored EnvCell component is the shell/container for the interior scene
- the strongest recoverable supervision inside many retail interiors is static-object-on-static-support placement within that component
- `parentGuids` are still useful when valid, but they are not the primary supervision source for table-top, shelf-top, or desk-top clutter

If we train directly on the current sequence tensors, the model is being asked to
infer retail GUI placement behavior from the wrong representation.

## Working Principle

Retail devs likely placed interior props in local editing frames:

- inside a room
- relative to a floor/wall/ceiling
- relative to a support object like a table, shelf, desk, altar, chest, or hook

The dataset should therefore predict placement in local frames:

1. room / cell frame
2. support-object frame
3. support-surface-relative offset

Global world coordinates should remain available for reconstruction and
validation, but should not be the primary learning target for micro-placement.

## Recommended Split

Do not train one monolithic interior model first.

Recommended split:

1. `InteriorStructure`
   - structural/support objects only
   - doors, chests, shelves, desks, beds, hooks, torches, furniture, support fixtures
2. `InteriorMicroPlacement`
   - small objects on supports
   - bottles, scrolls, books, gems, candles, bowls, food, clutter
3. `InteriorValidation`
   - bounds
   - collisions / suspicious overlap
   - unsupported floating props
   - wall/ceiling/floor mismatch

This note focuses on the dataset for stages 1 and 2.

## Source Of Truth

Primary:

- `WorldBuilder.Terminal export-envcell-components`
- `WorldBuilder.Terminal export-raw-world-facts --ace-db --links`

Secondary:

- `pipeline_data/reference/world_grammar_grounding_table.jsonl`
- `pipeline_data/reference/wcid_types_cache.json`
- `pipeline_data/enrichment/canonical_enrichment.json`

Useful but not sufficient alone:

- object names from grounding / LSD / ACE enum
- current world-grammar vocab abstractions

## Key Existing Signals

From `export-envcell-components`:

- per-cell static object local positions
- per-object world positions
- anchor-relative `relX/relY/relZ` for anchored components
- cell origin and orientation
- component bounds
- portal refs and visible-cell refs
- static-object conservative bounds (`aabbLocal`)
- support-surface hints (`supportSurfaceHints`) that already expose top-plane support classes such as `table_like` and `shelf_like`

From `export-raw-world-facts`:

- ACE `guid`
- `parentGuids`
- `childGuids`
- `weenieType`
- component membership
- object pose

These are strong enough to justify a support-aware attempt.

In practice, the priority order for supervision should be:

1. static prop vs static support geometry in the same cell/component
2. repeated semantic motifs over those static placements
3. direct ACE parent/child links only when they survive same-cell/same-component validation

For dataset assembly, the label tiers should map to evidence quality rather than to whether the source row happened to come from an ACE graph link:

1. gold
   - validated ACE graph links that survive same-cell/component checks
   - reviewed/bootstrap-promoted geometry matches
2. silver
   - strong static geometry matches on support surfaces in the same cell/component
   - tight footprint fit with plausible height above the support plane
3. bronze
   - top-ranked static geometry matches that are plausible but still ambiguous among nearby supports
   - useful as a larger weak-supervision pool for curriculum or confidence-weighted training

## Dataset Units

Two output datasets are recommended.

### 1. Support Object Dataset

Each row represents a candidate structural/support object inside an interior.

Example categories:

- table / desk / altar / counter
- shelf / bookcase
- chest / cabinet / container-like furniture
- bed / bench / chair / stool
- wall fixture / torch / sconce
- hook / floor hook / ceiling hook
- generic floor support only

Purpose:

- learn where support-capable objects belong in room context
- build a stable support graph for the micro-placement stage

### 2. Supported Prop Dataset

Each row represents one prop placed relative to a chosen support parent.

Purpose:

- learn the support-relative placement transform
- recover retail-like local intent

## Proposed JSONL Schema

### Support Object Row

```json
{
  "sceneId": "0x0708:0x0104",
  "landblockId": "0x0708",
  "cellId": "0x0104",
  "componentId": "4294967552",
  "componentKind": "unanchored_envcell_component",
  "roomFrame": {
    "origin": {"x": 40.0, "y": 52.0, "z": -90.0},
    "rotation": {"qw": -0.707107, "qx": 0.0, "qy": 0.0, "qz": -0.707107}
  },
  "object": {
    "guid": 1879052289,
    "classIdSpace": "wcid",
    "classId": 5085,
    "weenieType": 1,
    "positionLocal": {"x": 74.295, "y": 0.335, "z": 0.005},
    "rotation": {"qw": 1.0, "qx": 0.0, "qy": 0.0, "qz": 0.0}
  },
  "supportClass": "table_like",
  "supportConfidence": 0.82,
  "geometry": {
    "aabbLocal": {"minX": 73.8, "minY": -0.8, "minZ": -0.1, "maxX": 75.0, "maxY": 1.2, "maxZ": 1.1}
  },
  "context": {
    "portalCountInComponent": 12,
    "staticObjectCountInCell": 9,
    "staticObjectCountInComponent": 57
  }
}
```

### Supported Prop Row

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
  "supportParent": {
    "guid": 1879052289,
    "classIdSpace": "wcid",
    "classId": 5085,
    "weenieType": 1,
    "supportClass": "table_like"
  },
  "supportRelation": {
    "kind": "on_top_of",
    "confidence": 0.74,
    "relativePosition": {"x": -0.12, "y": 0.31, "z": 0.86},
    "relativeYawDeg": 4.2,
    "heightAboveSupportPlane": 0.03,
    "radialDistanceFromSupportCenter": 0.33
  },
  "roomContext": {
    "portalCountInComponent": 12,
    "componentKind": "unanchored_envcell_component"
  }
}
```

## Support Class Taxonomy

Start with a small controlled vocabulary:

- `floor`
- `wall`
- `ceiling`
- `hook_floor`
- `hook_wall`
- `hook_ceiling`
- `table_like`
- `shelf_like`
- `desk_like`
- `bed_like`
- `container_top`
- `altar_like`
- `unknown_support`

Do not start with too many classes.

The first pass should favor robustness over taxonomy purity.

## Candidate Support Parent Inference

The extractor should not rely on names alone.

Use a scored heuristic combining:

1. `weenieType`
2. grounding-table name hints
3. component context
4. local geometry
5. parent/child links
6. relative position

### High-confidence direct relations

Use direct graph links first:

- if a prop has exactly one plausible support-capable `parentGuid`
- if parent/child relation is consistent with support semantics

These are the best labels available in current exports.

### Geometric fallback

If there is no useful parent link:

- search for candidate support objects in the same cell
- rank by:
  - horizontal containment or proximity
  - positive but small vertical offset
  - plausible support class
  - similar room/local frame
  - no closer competing parent

### Hook-specific rules

Hooks should be treated as first-class supports, not generic clutter.

Special cases:

- `Hook`
- `Hook Floor`
- `Hook Ceiling`

These likely provide the cleanest support labels in retail data.

## Precision Strategy

Avoid learning only raw world-space `x/y/z`.

Preferred targets for the prop dataset:

- support-relative `dx/dy/dz`
- support-relative yaw
- height-above-support-plane
- normalized placement within support AABB or projected top plane

Optional derived features:

- support footprint dimensions
- distance to support edges
- snapped support plane normal

This mirrors how human placement intent is likely to have been authored.

## What Counts As Success

Early success criteria should be modest and measurable:

1. Can we recover stable support-parent labels for a useful subset of interior props?
2. Can we separate:
   - floor objects
   - wall fixtures
   - support-mounted props
3. Can we reconstruct support-relative placements with low error in local space?
4. Can we identify a clean high-confidence training subset before generalizing?

Do not require full coverage on day one.

## Recommended First High-Confidence Subset

Start with support patterns that are likely to be clean:

- hook-attached placements
- shelf/bookcase-contained book-like placements
- table/desk + small prop placements
- wall torch / sconce placements

Delay harder categories:

- ambiguous clutter piles
- heavily irregular cave rooms
- noisy loot scatter around chests
- mixed combat/trigger/prop clusters

## Validation Requirements

The new dataset should emit validation metadata so bad labels can be filtered.

Per row:

- `supportConfidence`
- `supportInferenceMode`
  - `graph_link`
  - `geometry_nearest`
  - `hook_rule`
  - `floor_fallback`
- `sameCell`
- `withinSupportBounds`
- `verticalOffsetOk`
- `competingParentCount`

Dataset-level validation:

- class distribution
- support class distribution
- confidence histogram
- per-class median relative offset
- suspicious outliers

## Recommended Implementation Order

1. Build support-object classifier heuristics from grounding + type + names.
2. Build high-confidence support-parent inference.
3. Emit a micro-placement JSONL with confidence fields.
4. Inspect samples manually.
5. Only then decide the model family.

## Model Family Guidance

Do not assume the current autoregressive landblock sequence model is the right
architecture for this stage.

A better first model may be:

- support-parent selection model
- support-relative offset regressor
- small local-context transformer over room/support neighborhoods

This should be decided after label quality is measured.

## Terminal Follow-Up

If this line proves viable, `WorldBuilder.Terminal` likely deserves a dedicated
export later for support-aware supervision:

- support-parent candidates
- support plane estimates
- support-relative transforms
- room-local frames
- static object inspection with richer semantics

That should be a later program improvement, not a blocker for the first
extractor attempt.
