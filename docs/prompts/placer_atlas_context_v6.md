# Unified Scene Placer V6 — atlas-derived semantic context

## Why this exists

Through V5 the placer's *context vector* has been 31 floats of aggregate
landblock statistics: object counts, ratios, scene-kind one-hot, density,
span. There is **no semantic signal** in it — no notion of *which region*,
*which town*, *what culture*, *what biome*, *whether this is a roadside
hamlet vs. a deep-dungeon-adjacent plateau*. The model has been learning
placement preferences from raw geometry alone, which is why every V5
attempt ceilings at a similar `unique_wcids` count and a similar
`long_tail_recall` no matter how the loss is reweighted.

The V5 calibration run on 2026-04-28 (`unified_v5_calibrated_20260428T170737Z`)
made this explicit. It plateaued at `val_total ≈ 23.75` for 14 epochs, then
suffered a numerical spike in the position head at epoch 17 and was killed.
Pre-spike, the metrics that matter were inching up but glacial:
`top1_wcid_acc_dat` 0.822 → 0.909, `long_tail_recall` 0.366 → 0.423,
`unique_wcids` 1552 → 1795. **The model is learning what it can from
geometry — there is nothing more to extract from a 31-d aggregate context.**

We have a "living atlas" already: WB.Terminal's `describe-landblock` command
composes ontology + region/town gazetteer + Acpedia + LSD spawnMap + biome
inference + validation diagnostics into a per-LB structured object. The
gazetteer alone resolves things the placer has no other access to:
`regionName`, `townName`, `culture`, `settlementHint`, `dominantArchitecture`,
`knownPois` (Acpedia titles + categories), `gazetteerNotes`. None of this
reaches the tensor pipeline today.

V6 wires the atlas into the training tensors as a categorical-embedding
feature block. Goal: lift `long_tail_recall` from ~0.42 to **≥0.60**, lift
`unique_wcids` from ~1795 to **≥2400**, and finally produce a placer that
emits region-conditioned distributions (Yaraq has caravan props, Rithwic
doesn't; Aluvian towns get half-timber, Sho towns get pagoda detail).

---

## Context — what exists in the repo

Read these before touching anything.

### The atlas surface (data source)

- **`WorldBuilder.Terminal/LandblockDescriber.cs:18`** — `LandblockDescriber.Describe(...)` returns a `LandblockDescriptionResult` with the rich semantic block. The fields V6 cares about are nested under `.Context` (`LandblockContextInfo`) and `.Body.Structures[*]`.
- **`WorldBuilder.Terminal/CommandEngine.cs:665`** — `CommandEngine.DescribeLandblock(lbX, lbY)` is the C# entry point.
- **`WorldBuilder.Terminal/JsonCommandProcessor.cs:159`** maps `"describe-landblock"` to `CmdDescribeLandblock`. Exact stdin protocol:
  ```json
  {"command":"describe-landblock","lbX":228,"lbY":124,"includeFootprints":false}
  ```
  Output schema (truncated to the fields V6 ingests) — confirmed against `JsonCommandProcessor.cs:619-720`:
  ```json
  {
    "success": true,
    "context": {
      "regionName": "Yaraq Hinterlands",
      "regionDescription": "...",
      "townName": "Yaraq",
      "culture": "Aluvian",
      "gazetteerNotes": "...",
      "knownPoiCount": 3,
      "knownPois": [{"title":"...","categories":["Town","Outpost"],"description":"..."}],
      "biome": "Desert",
      "biomeConfidence": 0.812,
      "hasRoad": true,
      "settlementHint": "town",
      "dominantArchitecture": "Aluvian",
      "structureCount": 17,
      "dominantTerrainTypes": [{"type":1,"name":"Desert","vertexCount":228,"share":0.78}, ...]
    },
    "body": { "structures": [{ "architecture": "Aluvian", "stories": 2, "roofShape": "Gable", "materialTags": ["wood","stone"], "tags": ["dwelling"], ... }, ...] }
  }
  ```
- **`list-landblocks`** at `JsonCommandProcessor.cs:947` enumerates loaded LBs (no args required).
- **Don't** assume `describe-landblock` is fast. Empirically it is **~150-400 ms per LB** on a warm world (gazetteer + ontology lookups dominate). All ~64K LBs ≈ 4-6 hours single-threaded. **Cache to JSONL once.**

### The current tensor pipeline

- **`scripts/PopulationPipeline/OutdoorML/extract_component_linked_tensors.py`** — the producer.
  - `_build_base_context_block` (line 539) — first 16 dims (counts, ratios, terrain-delta, slope, parent/child/building/encounter/instance counts, view ordinal/strategy/chunk).
  - Extended block (line 609) — 11 dims for scene_kind one-hot + interior context (last is `reserved`).
  - **Total `EXTENDED_CONTEXT_DIM = 31`**.
  - The vocab JSON's `context_feature_names` list (`extract_component_linked_tensors.py:894-925`) is the source of truth for what each slot means; **V6 must extend this list, never reorder.**
  - Output: `pipeline_data/reference/component_linked_unified_v4_tensors.npz` (228,638 sequences, contexts shape `(228638, 31)`) and the matching vocab. **V6 produces a v5-named pair — don't overwrite v4.**

### The trainer

- **`scripts/PopulationPipeline/OutdoorML/train_scene_placer.py`** (1931 lines).
  - **Model**: `ScenePlacerTransformer` ~37.7M params, autoregressive transformer over a 14-d tokenized object sequence conditioned on a context vector.
  - **Context ingestion** is at `ContextEncoder` (line 484): a single `Linear(context_dim → d_model)`. **This is the only model surface V6 has to change** — the encoder consumes a flat float vector. Increasing `context_dim` only changes that one Linear's input shape.
  - **Resume path**: `load_compatible_state_dict` (line 1206) already handles tensor-shape mismatch by skipping the incompatible slot. The `ContextEncoder.linear.weight` will be skipped when context_dim grows; everything else (transformer blocks, output heads) loads cleanly. **This is the lever that lets V6 resume from V5's epoch-14 checkpoint without re-pretraining the body.**
  - **Auto-batch sizing** (line 1078). Don't hand-set `batch_size`.

### The last known-good checkpoint

- **`pipeline_data/models/unified_v5_calibrated_20260428T170737Z_resume.pt`** (full state, epoch 14, val_total 23.7503, pre-spike). All transformer body weights, all heads except the context Linear, are reusable.
- Training history at `pipeline_data/models/logs/unified_v5_calibrated_20260428T170737Z/training_history.json` — read this if you want to see exactly where V5 was when V6 takes over.

---

## Intent

Make the model see *where* it is in the world, semantically. Concretely:
add a **categorical semantic block** to the per-LB context vector, sourced
from `describe-landblock`, encoded as embeddings (categorical fields) +
small float scalars (counts, confidences). Resume V5's epoch-14
transformer body and only relearn the context-ingestion + a thin top-of-stack
adapter. Train within a 35-hour budget.

This is **not** a re-architecture. The model stays a 37.7M-param transformer.
The vocab stays compatible with the V4 bucket resolver. The token sequence
stays untouched. The only thing that changes is the conditioning input.

---

## Objectives

### O1. Bulk-cache `describe-landblock` for every training LB

- Enumerate the LBs present in `component_linked_unified_v4_tensors.npz`'s
  `lb_coords` array (deduplicated → expect ~5K-10K unique LBs).
- Spin up `WorldBuilder.Terminal` in JSON-stdin mode against the same world
  load V4 was extracted against (raw_facts and components must match — read
  `extract_component_linked_tensors.py` for the canonical paths).
- For each unique LB, issue `{"command":"describe-landblock","lbX":X,"lbY":Y,"includeFootprints":false}` and append the response to a JSONL.
- **Output**: `pipeline_data/reference/atlas_describe_v1.jsonl` — one line per LB. Include `lbX`, `lbY`, the full `context` block, and a *minimal* `body.structures` slice (architecture, stories, roofShape, materialTags) for top-3 structures by `attributedCellCount`. Strip the verbose verbal/relations/validation blocks — V6 doesn't ingest them and they bloat the file by ~5×.
- **Idempotency**: support `--resume` so a second pass only fills in missing LB keys (this run will sometimes get interrupted).
- **Sanity**: log a per-field null-rate. If `regionName` is null on >5% of LBs, the gazetteer didn't load — abort and check the world load before training.

### O2. Define the V6 categorical feature schema

For each ingested field, the schema specifies: type, encoding, embedding dim
(if applicable), and the fallback for missing values. Use this exact schema
— it is what the trainer will rebuild against.

| Field source                       | Type        | Encoding             | Vocab cap | Embed dim | Missing |
|------------------------------------|-------------|----------------------|-----------|-----------|---------|
| `context.regionName`               | categorical | id-table → embedding | 80        | 16        | id 0    |
| `context.townName`                 | categorical | id-table → embedding | 256       | 16        | id 0    |
| `context.culture`                  | categorical | id-table → embedding | 16        | 8         | id 0    |
| `context.biome`                    | categorical | id-table → embedding | 24        | 8         | id 0    |
| `context.settlementHint`           | categorical | id-table → embedding | 12        | 4         | id 0    |
| `context.dominantArchitecture`     | categorical | id-table → embedding | 24        | 8         | id 0    |
| `context.hasRoad`                  | bool        | float {0,1}          | —         | —         | 0.0     |
| `context.biomeConfidence`          | float       | clipped [0,1]        | —         | —         | 0.0     |
| `context.structureCount`           | int         | `log1p`-scaled       | —         | —         | 0.0     |
| `context.knownPoiCount`            | int         | `log1p`-scaled       | —         | —         | 0.0     |
| `context.gazetteerNotes`           | bool        | `1.0 if non-null`    | —         | —         | 0.0     |
| `context.knownPois[*].categories`  | multi-hot   | bag over top-32 cats | 32        | —         | zeros   |
| `body.structures[*].architecture`  | mode-cat    | id-table → embedding | 24        | 8         | id 0    |
| `body.structures[*].roofShape`     | mode-cat    | id-table → embedding | 16        | 4         | id 0    |
| `body.structures[*].materialTags`  | multi-hot   | bag over top-16 mats | 16        | —         | zeros   |

**Total added context width**:
- Scalar/bool/multi-hot block: `1 + 1 + 1 + 1 + 1 + 32 + 16 = 53` floats
- Embedding block (concatenated post-embedding): `16+16+8+8+4+8+8+4 = 72` floats
- **New `EXTENDED_CONTEXT_DIM = 31 + 53 + 72 = 156`**

Resolve embeddings inside the trainer, not the extractor — keep the NPZ
storing only ids + scalars so the embedding tables can be retrained without
re-extracting.

**Vocab build**: do this in the extractor as a first pass over the JSONL.
Take the top-N most frequent values per field, reserve `id 0 = <UNK/missing>`,
emit `pipeline_data/reference/atlas_feature_vocabs_v1.json`:
```json
{
  "regionName": {"unk_id": 0, "values": ["<UNK>", "Yaraq Hinterlands", "Rithwic", ...]},
  "townName":   {"unk_id": 0, "values": ["<UNK>", "Yaraq", "Rithwic", ...]},
  ...
  "poi_categories": {"values": ["Town", "Outpost", "Dungeon", ...]},
  "material_tags": {"values": ["wood", "stone", "metal", ...]}
}
```

### O3. Extend the tensor extractor

- New script: `scripts/PopulationPipeline/OutdoorML/build_atlas_context.py`. **Don't** mutate `extract_component_linked_tensors.py` — V6 *augments* a V4 NPZ rather than re-extracting from raw facts (the raw-facts pass is slow and we don't need to repeat it).
- Inputs: existing `component_linked_unified_v4_tensors.npz` + `atlas_describe_v1.jsonl` + `atlas_feature_vocabs_v1.json`.
- For each row, look up by `lb_coords[i]` and produce:
  - `atlas_ids[i, 8]` int32 — the eight categorical ids in this order: `regionName, townName, culture, biome, settlementHint, dominantArchitecture, struct_architecture, struct_roofShape`.
  - `atlas_scalars[i, 5]` float32 — `[hasRoad, biomeConfidence, log1p(structureCount), log1p(knownPoiCount), gazetteerNotes_present]`.
  - `atlas_poi_categories[i, 32]` float32 — multi-hot over poi categories.
  - `atlas_material_tags[i, 16]` float32 — multi-hot over the union of top-3 structures' `materialTags`.
- Output: `pipeline_data/reference/component_linked_unified_v5_atlas_tensors.npz` — copies all V4 keys + adds the four new arrays. Keeps the same row order so existing `seq_lengths`, `sequences`, `sample_weights`, `lb_coords` align without re-shuffling.
- Vocab JSON copy: `pipeline_data/reference/component_linked_unified_v5_atlas_vocab.json` — V4 vocab + new top-level key `"atlas"` containing `feature_dims`, `embedding_dims`, `vocab_caps`, and a copy of `atlas_feature_vocabs_v1.json` for self-containedness.

### O4. Wire the atlas block into the model

- Add `AtlasContextEncoder` near `ContextEncoder` (line 484). Single forward:
  ```python
  # ids: (B, 8)  scalars: (B, 5)  poi: (B, 32)  mats: (B, 16)
  embed_concat = torch.cat([self.embed_region(ids[:,0]), self.embed_town(ids[:,1]), ...], dim=-1)  # (B, 72)
  flat = torch.cat([embed_concat, scalars, poi, mats], dim=-1)                                     # (B, 72+53)
  return self.proj(flat)  # Linear(125 → d_model//2)
  ```
- `ScenePlacerTransformer.__init__` (line 552): split `ContextEncoder` output and `AtlasContextEncoder` output (`d_model//2` each), concat, project to `d_model` for the transformer's first token. Old context still flows through the existing path — V6 is *additive*, not *replacing*.
- New constructor kwargs: `atlas_vocab_caps: dict[str,int]`, `atlas_embedding_dims: dict[str,int]`. Both come from the V5 atlas vocab JSON.
- All new params (the embedding tables + the projection Linears) initialize fresh; the rest of the model loads from the V5 epoch-14 checkpoint via `load_compatible_state_dict`.

### O5. Trainer wiring

- New CLI flags on `train_scene_placer.py`:
  ```
  --atlas-tensor-path pipeline_data/reference/component_linked_unified_v5_atlas_tensors.npz
  --atlas-vocab-path  pipeline_data/reference/component_linked_unified_v5_atlas_vocab.json
  --atlas-warmup-epochs 3
  --atlas-context-dropout 0.1
  ```
- `--atlas-warmup-epochs N`: for the first `N` epochs, **mask the atlas block to zeros** (multiplicative mask on the projected output) so the model adjusts to the resumed body's representations before the new conditioning kicks in. Without this, the new ContextEncoder Linear sees a body that's already converged to the V5 distribution and produces destabilizing gradients.
- `--atlas-context-dropout 0.1`: per-field dropout applied to ids (drop to UNK id) and scalars (drop to 0) during training. Forces the model to not over-rely on any single semantic field — important because `regionName` correlates strongly with placement and the model will collapse onto it otherwise.
- `Dataset.__getitem__` (line 428): extend to return `(context, atlas_ids, atlas_scalars, atlas_poi, atlas_mats, sequence, ...)`. Keep collation deterministic.

### O6. Run config

Resume the V5 epoch-14 checkpoint with V5's calibration knobs (these were
fine — the failure was instability in the position head, not the loss
shape). Add the V6-specific atlas block. Hardware: NVIDIA L4, 22 GB.

```
python3 -u scripts/PopulationPipeline/OutdoorML/train_scene_placer.py \
  --resume pipeline_data/models/unified_v5_calibrated_20260428T170737Z_resume.pt \
  --tensor-path pipeline_data/reference/component_linked_unified_v5_atlas_tensors.npz \
  --vocab-path  pipeline_data/reference/component_linked_unified_v5_atlas_vocab.json \
  --atlas-tensor-path pipeline_data/reference/component_linked_unified_v5_atlas_tensors.npz \
  --atlas-vocab-path  pipeline_data/reference/component_linked_unified_v5_atlas_vocab.json \
  --atlas-warmup-epochs 3 \
  --atlas-context-dropout 0.1 \
  --run-name unified_v6_atlas_$(date -u +%Y%m%dT%H%M%SZ) \
  --epochs 80 \
  --validation-every 3 \
  --val-split-mode region \
  --lr-schedule cosine \
  --lr 5e-5 \
  --lr-min 1e-6 \
  --warmup-epochs 5 \
  --warmup-min-epochs 5 \
  --warmup-fraction-cap 0.10 \
  --ace-abstract-weight 4.0 \
  --dat-inv-freq \
  --dat-clamp-max 3.0 \
  --label-smoothing 0.1 \
  --lambda-marginal-kl 0.03 \
  --focal-gamma 0.0 \
  --resume-checkpoint-every 5
```

Expected wall-clock: ~22 min/epoch × 80 epochs ≈ **29 hours**. Within the
35-hour budget. Patience is 15 epochs — early-stop should kick in around
epoch 55-65 if the run is healthy. If it doesn't, the cosine ride to
`lr_min` will resolve gracefully.

The post-V5 stability fixes are *also* in this config (`label_smoothing 0.1`,
`ace_abstract_weight 4.0`, `dat_clamp_max 3.0`, `lr_max 5e-5`) — V6 is the
right time to land them.

### O7. Verification before declaring done

**Pre-flight** (run before kicking off training):
- Atlas JSONL line count == unique-LB count from `lb_coords`. ±0 tolerance.
- `regionName` null rate < 5%, `townName` null rate < 60% (most LBs are
  wilderness, no town).
- V5 atlas tensor row count == V4 row count (228,638). Lookup by lb_coords
  must hit on every row (use a deterministic unknown-LB → all-zeros policy
  if any miss; log the count).
- Smoke run: 1 epoch with `--epochs 1 --max-train-batches 50 --max-val-batches 20`. Verify the new `AtlasContextEncoder` weights actually receive gradient (print grad norms for the embedding tables).

**During training**: watch `wcid_entropy`, `unique_wcids`, and `long_tail_recall` at every val. The V5 ceiling was `unique_wcids ≈ 1795`. By epoch 30 of V6 we should see `≥ 2100` or the atlas block isn't carrying its weight.

**Post-training success criteria**:
- `long_tail_recall ≥ 0.60` (V5: 0.42)
- `unique_wcids ≥ 2400` on val greedy decode (V5: 1795)
- `top1_wcid_acc_dat ≥ 0.93` (V5: 0.91)
- `ace_emit_frac ∈ [0.55, 0.65]` (retail: 0.613)
- A spot-check: compare placer output for `(228, 124)` (Yaraq) and
  `(54, 110)` (Rithwic). Yaraq should produce more desert-coded DATs and
  the same culture's architecture; Rithwic should produce temperate /
  Aluvian coded DATs. If the two LBs produce visually-indistinguishable
  output, the atlas conditioning is being ignored.

---

## Notes on what *not* to do

- **Don't change vocab indices or bucket keys**. The V4 bucket resolver
  (`pipeline_data/reference/component_linked_unified_v4_bucket_resolver.json`)
  must still work for inference — V6 keeps the token vocab byte-identical
  and only extends the context.
- **Don't ingest the verbal text**. It's downstream of the structured
  fields V6 ingests, and ingesting both leaks structure into the embedding
  layer in a way that resists ablation.
- **Don't pretrain the atlas embeddings separately**. The transformer body
  already encodes most of what those embeddings need to learn. Joint
  training with `--atlas-warmup-epochs 3` is sufficient.
- **Don't expand `context_dim` to 156 floats by flattening one-hots**. The
  embedding-table approach is the production-grade form; one-hot
  concatenation works at this small scale but fights you when you want to
  add cross-region transfer (knowing that Yaraq and Zaikhal are both
  "desert" cultures requires the embedding to learn the similarity).
- **Don't run extraction and training in the same shell session.** The
  WB.Terminal world-load eats ~12 GB RAM; the training job uses GPU but
  also wants headroom. Sequential, not parallel.
- **Don't skip the `--atlas-warmup-epochs 3` masking.** Without it, the
  resumed body sees a different conditioning distribution from epoch 0 and
  the position head can spike again the same way V5 did at epoch 17.

---

## Sequence of work (clean dependency order)

1. **Build atlas JSONL** (O1) — ~6 hours wall-clock, mostly idle on Terminal stdin loop. Produces `atlas_describe_v1.jsonl`.
2. **Build feature vocabs** (O2) — minutes. Produces `atlas_feature_vocabs_v1.json`.
3. **Augment tensors** (O3) — minutes. Produces `component_linked_unified_v5_atlas_tensors.npz` + matching vocab.
4. **Trainer wiring** (O4 + O5) — incremental code change. Smoke test with `--epochs 1 --max-train-batches 50`.
5. **Run config** (O6) — ~29 hours.
6. **Verification** (O7) — 1 hour: greedy decode + region spot-check + metric audit.

Total: **~36 hours wall-clock** end-to-end, of which ~29 are GPU-bound
training and the rest is data engineering. The 35-hour training budget
holds.

---

## Files this work will create

- `pipeline_data/reference/atlas_describe_v1.jsonl` (~200 MB, gzip optional)
- `pipeline_data/reference/atlas_feature_vocabs_v1.json` (~10 KB)
- `pipeline_data/reference/component_linked_unified_v5_atlas_tensors.npz` (V4 size + ~80 MB)
- `pipeline_data/reference/component_linked_unified_v5_atlas_vocab.json` (~50 KB)
- `scripts/PopulationPipeline/OutdoorML/build_atlas_context.py` (new, ~300 LOC)
- `scripts/PopulationPipeline/OutdoorML/dump_atlas_jsonl.py` (new, ~150 LOC — drives WB.Terminal stdin)
- Edits to `scripts/PopulationPipeline/OutdoorML/train_scene_placer.py` (`AtlasContextEncoder`, dataset extension, CLI flags)
- New checkpoint family `pipeline_data/models/unified_v6_atlas_*` and matching log dir under `pipeline_data/models/logs/`

## Files this work will *not* touch

- `extract_component_linked_tensors.py` — frozen at V4 schema.
- `component_linked_unified_v4_*` — read-only from now on.
- `generate_populated_world.py` — V6's checkpoint loads the same way as V5's; inference doesn't need the atlas if the model was trained with `--atlas-context-dropout` high enough that it tolerates UNK at inference. (It will be — that's part of why dropout is in the recipe.)
- The `WcidResolver` and bucket resolver — vocab compat is preserved.
