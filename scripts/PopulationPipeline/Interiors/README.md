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
  - now also emits:
    - `interior_supported_prop_review_packets.jsonl`
    - `interior_supported_props_bootstrap.jsonl`
  - accepts optional `--review-decisions-jsonl` to promote reviewed candidates into bootstrap labels
- `extract_town_support_aware_interior_dataset.py`
  - curated town-interior wrapper around the support-aware extractor
  - reuses `town_kits/index.json` via `extract_town_world_data.py --include-interiors`
  - writes town-only support / silver / review outputs under `pipeline_data/reference/`
- `SupportAwareInteriorDatasetDesign_2026-04-05.md`
  - dataset/schema design note for support-aware interior modeling
- `InteriorSupportExporterPlan_2026-04-05.md`
  - concrete `WorldBuilder.Terminal` export upgrade plan for support-surface metadata and interior support candidates

## Review Bootstrap

The geometry-aware extractor is intentionally conservative. The practical next step is a human-in-the-loop bootstrap lane:

- inspect `pipeline_data/reference/interior_supported_prop_review_packets.jsonl`
- accept or reject top candidates using stable `reviewKey` or `reviewGroupKey`
- rerun `extract_support_aware_interior_dataset.py --review-decisions-jsonl ...`
- consume the resulting `pipeline_data/reference/interior_supported_props_bootstrap.jsonl`

Decision rows are JSONL and intentionally simple. Example:

```json
{"reviewKey":"0x02C4:0x0191|1881948240|1|model_id:33554819","decision":"accept","reviewer":"human","notes":"confirmed prop on bookcase"}
{"reviewGroupKey":"0x01FA:0x0242|1881120834","decision":"reject","reviewer":"human","notes":"chest false positive"}
```
