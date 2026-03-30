# Component-Linked Training Flow

This flow upgrades the OutdoorML training data from disconnected landblock objects to a linked representation that preserves DAT surface anchors, EnvCell interior components, and ACE instance/link facts.

## What Changed

- `WorldBuilder.Terminal` gained two exports:
  - `export-raw-world-facts`
  - `export-envcell-components`
- `scripts/PopulationPipeline/OutdoorML/extract_component_linked_tensors.py` builds:
  - `pipeline_data/reference/component_linked_tensors.npz`
  - `pipeline_data/reference/component_linked_vocab.json`
- `scripts/PopulationPipeline/OutdoorML/train_scene_placer.py` now:
  - defaults to the component-linked dataset
  - appends per-object component features from the exported component tables
  - supports run-scoped output names
  - supports CLI overrides for tensor/vocab paths and checkpoint cadence

## Export Commands

JSON mode:

```json
{"command":"export-raw-world-facts","outputPath":"pipeline_data/reference/raw_world_facts_full_with_components_v2.jsonl","includeAceDb":true,"includeLinks":true}
{"command":"export-envcell-components","outputPath":"pipeline_data/reference/envcell_components_full.jsonl"}
```

Terminal mode:

```text
export-raw-world-facts raw_world_facts_full_with_components_v2.jsonl --ace-db --links
export-envcell-components envcell_components_full.jsonl
```

## Tensor Extraction

```bash
python3 -u scripts/PopulationPipeline/OutdoorML/extract_component_linked_tensors.py \
  --raw-jsonl pipeline_data/reference/raw_world_facts_full_with_components_v2.jsonl \
  --component-jsonl pipeline_data/reference/envcell_components_full.jsonl \
  --out-npz pipeline_data/reference/component_linked_tensors.npz \
  --out-vocab pipeline_data/reference/component_linked_vocab.json
```

The extractor is streaming and is intended for the full 255x255 world export without materializing all raw rows as Python dicts at once.

## Training

Default training now points at the component-linked dataset:

```bash
python3 -u scripts/PopulationPipeline/OutdoorML/train_scene_placer.py --epochs 100
```

Useful overrides:

```bash
python3 -u scripts/PopulationPipeline/OutdoorML/train_scene_placer.py \
  --epochs 250 \
  --run-name scene_placer_component_linked_overnight_YYYYMMDDTHHMMSSZ \
  --checkpoint-every 125 \
  --resume-checkpoint-every 50
```

Smoke run:

```bash
python3 -u scripts/PopulationPipeline/OutdoorML/train_scene_placer.py \
  --epochs 1 \
  --batch 8 \
  --max-train-batches 2 \
  --max-val-batches 1
```

## Notes

- The current trainer still uses the existing autoregressive architecture; this change upgrades the data path and per-object conditioning, not the underlying model family.
- Long runs should be launched detached with a run-specific log and PID file.
- Later checkpoints should be judged by validation and generation probes, not by assuming the final epoch is best.
