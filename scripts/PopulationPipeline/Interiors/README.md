# Interiors

This stage is reserved for interior placement and linked object reconstruction.

Planned responsibilities:

- room-aware placement
- portal reciprocity
- floor-aware placement
- object-on-object relationships
- interior graph reconstruction

Current research entrypoints:

- `extract_support_aware_interior_dataset.py`
  - first-pass high-confidence extractor for support objects and linked supported props
  - uses retail `raw_world_facts`, `envcell_components`, and the world-grammar grounding table
- `SupportAwareInteriorDatasetDesign_2026-04-05.md`
  - dataset/schema design note for support-aware interior modeling
