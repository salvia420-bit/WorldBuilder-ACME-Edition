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
    - `interior_supported_props_bronze.jsonl`
    - `interior_supported_prop_review_packets.jsonl`
    - `interior_supported_props_bootstrap.jsonl`
  - accepts optional `--review-decisions-jsonl` to promote reviewed candidates into bootstrap labels
- `extract_town_support_aware_interior_dataset.py`
  - curated town-interior wrapper around the support-aware extractor
  - reuses `town_kits/index.json` via `extract_town_world_data.py --include-interiors`
  - writes town-only support / silver / bronze / review outputs under `pipeline_data/reference/`
- `build_interior_microplacement_training_set.py`
  - merges gold / bootstrap / silver / bronze labels into one weighted training corpus
  - flattens support-relative placement targets for model consumption
  - can emit a stricter silver-only set or a larger bronze-inclusive curriculum set
- `build_interior_support_arrangement_dataset.py`
  - groups micro-placement rows by support surface
  - emits positive placements plus grounded negatives such as off-edge perturbations, sibling collisions, and borrowed nearby-support props
  - intended as the second-stage arrangement/ranking corpus above the per-object regressor
- `build_interior_object_semantics_table.py`
  - merges interior object identities with grounded repo metadata from the world-grammar grounding table, canonical enrichment, WCID type cache, and `LSD-Partial`
  - preserves raw semantic signals plus observed interior support affinities instead of forcing guessed family labels
  - writes `pipeline_data/reference/interior_object_semantics_v1.jsonl` for later support-pattern and object-selection stages
- `train_interior_micro_placer.py`
  - trains a first-pass interior support-relative regressor directly from the weighted JSONL corpus
  - uses categorical embeddings plus compact room/support context
  - predicts support-relative placement targets instead of outdoor next-token sequences
- `train_interior_arrangement_ranker.py`
  - trains a support-level compatibility ranker over positive and negative placement candidates
  - scores whether a candidate prop placement fits the support surface and surrounding arrangement
- `build_interior_support_object_selection_dataset.py`
  - builds support-level positive and negative object-identity candidates from arrangement rows
  - intended for the object-compatibility stage above micro-placement
- `build_interior_support_object_pairwise_dataset.py`
  - converts support/object selection rows into pairwise ranking comparisons between the observed object and a confuser
  - intended for unseen-object generalization experiments where plain classification is too easy
- `train_interior_object_selector.py`
  - trains a support/object compatibility classifier
  - useful for baseline/easy-split sanity checks, but not sufficient by itself for unseen-object generalization
- `train_interior_object_pair_ranker.py`
  - trains a support-conditioned pairwise ranker that should score the observed object above a hard confuser on the same support
  - intended as the more honest object-selection stage for interior semantics work
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

For model training, the pragmatic path is:

- build a silver-first corpus with `build_interior_microplacement_training_set.py`
- optionally include bronze rows as lower-weight weak supervision
- let reviewed/bootstrap rows override weaker labels when they exist
- train a first baseline with `train_interior_micro_placer.py` on the strict HQ corpus before widening to bronze

Decision rows are JSONL and intentionally simple. Example:

```json
{"reviewKey":"0x02C4:0x0191|1881948240|1|model_id:33554819","decision":"accept","reviewer":"human","notes":"confirmed prop on bookcase"}
{"reviewGroupKey":"0x01FA:0x0242|1881120834","decision":"reject","reviewer":"human","notes":"chest false positive"}
```
