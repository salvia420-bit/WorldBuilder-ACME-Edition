# Population Pipeline Progress

## Purpose

This document is a running handoff log for population-pipeline work.

It exists so a future agent or collaborator can quickly answer:

- what changed in repo structure
- what has been verified on a real GPU VM
- what is still blocked or uncertain
- what should happen next


## Current Repo Structure

Population work has been reorganized under:

- `scripts/PopulationPipeline/`

Current stage folders:

- `scripts/PopulationPipeline/Planning/`
- `scripts/PopulationPipeline/MacroPlacement/`
- `scripts/PopulationPipeline/OutdoorML/`
- `scripts/PopulationPipeline/Scatter/`
- `scripts/PopulationPipeline/Encounters/`
- `scripts/PopulationPipeline/Interiors/`
- `scripts/PopulationPipeline/Validation/`

Compatibility wrappers still exist at:

- `scripts/*.py`
- `scripts/PopulationPipeline/*.py`

Those wrappers forward to the staged implementations so old command habits do
not break while the layout settles.


## VM Environment Notes

Testing was performed on a Google Cloud VM with:

- NVIDIA L4 GPU
- Ubuntu 22.04 family image
- Python venv
- CUDA-capable PyTorch working on GPU

Important environment outcomes:

- PyTorch initially failed due to an incompatible CUDA build
- installing the `cu128` PyTorch build fixed GPU availability
- Spot instances were preempted at least once, so non-Spot or persistent
  storage is safer for long runs


## Data Availability Notes

The ACE world SQL was successfully downloaded directly on the VM from:

- `ACEmulator/ACE-World-16PY-Patches` GitHub release assets

The following repo-tracked files were discovered to be Git LFS pointer stubs on
the VM rather than real payloads:

- `pipeline_data/heightmaps/retail_heightmaps.jsonl`
- `pipeline_data/reference/retail_dungeon_topology.json`
- several terrain model weights under `pipeline_data/models/`

This matters because some pipeline stages may silently degrade or fail if they
expect the full payloads rather than pointer files.


## Extractor Status

Script:

- `scripts/PopulationPipeline/OutdoorML/extract_placement_tensors.py`

VM result:

- extractor ran successfully after patching `RETAIL_SQL` to the downloaded SQL path
- MariaDB was not available, but the script successfully fell back to parsing
  weenie types from the SQL dump

Observed output summary:

- `326,618` instances parsed
- `304,351` links parsed
- `165,465` encounters parsed across `35,634` landblocks
- `3,603` populated landblocks used for training examples
- context dimension `224`
- max sequence length `128`
- vocabulary size `12,653`
- average objects per landblock `50.8`
- total training tokens `183,101`

Important warning during extraction:

- `pipeline_data/population_output/vanquish_heights.json` was missing
- extractor used zero heights as fallback

Interpretation:

- the extraction path is operational on the VM
- the generated tensors are usable for experimentation
- the data quality is not ideal because terrain-height context was degraded


## Training Status

Script:

- `scripts/PopulationPipeline/OutdoorML/train_scene_placer.py`

### Initial training result

The first real VM run showed:

- training started successfully on the L4
- validation first occurred at epoch `9`
- early stopping triggered immediately due to the overfit-gap rule
- summary reported `Best validation loss: inf`

Interpretation:

- training execution itself worked
- the overfit rail was too aggressive early in training

### Patch applied

The training script was adjusted so overfit early stopping does not activate
until later in training.

Patch summary:

- added `min_overfit_epoch` to config
- gated overfit stopping behind `epoch >= min_overfit_epoch`

Current local setting:

- `min_overfit_epoch = 200`

### Post-patch training behavior

After the patch, training no longer stopped at the first validation pass.

Observed progression:

- validation loss improved steadily instead of stopping immediately
- entropy collapsed badly early, then gradually recovered
- by roughly epochs `170-300`, training looked materially healthier

Representative validation snapshots:

- epoch `9`: `val_total ≈ 85.58`, `wcid_entropy ≈ 3.1`
- epoch `19`: `val_total ≈ 21.15`, `wcid_entropy ≈ 0.0`
- epoch `99`: `val_total ≈ 3.70`, `wcid_entropy ≈ 0.2`
- epoch `169`: `val_total ≈ 3.17`, `wcid_entropy ≈ 2.11`
- epoch `199`: `val_total ≈ 2.84`, `wcid_entropy ≈ 2.63`
- epoch `249`: `val_total ≈ 2.60`, `wcid_entropy ≈ 2.82`
- epoch `299`: `val_total ≈ 2.53`, `wcid_entropy ≈ 2.8`

Interpretation:

- the model is learning a real signal
- the training loop is stable enough to continue on GPU
- early mode collapse appears to partially recover over time
- this is promising for experimentation, but not proof of retail-dev-quality output


## Checkpoint / Save Behavior

Observed mismatch:

- log messages referenced `.safetensors` outputs
- actual saved files on disk were `.pt`

Files confirmed on the VM:

- `pipeline_data/models/scene_placer_best.pt`
- `pipeline_data/models/scene_placer_final.pt`
- `pipeline_data/models/resume.pt`
- `pipeline_data/models/resume_epoch_50.pt`
- `pipeline_data/models/resume_epoch_100.pt`
- `pipeline_data/models/resume_epoch_150.pt`
- `pipeline_data/models/resume_epoch_200.pt`
- `pipeline_data/models/resume_epoch_250.pt`

Interpretation:

- checkpoints are being saved successfully
- the code/logging around output format is inconsistent and should be cleaned up


## Generation Status

Script:

- `scripts/PopulationPipeline/OutdoorML/generate_populated_world.py`

Observed runtime behavior on the VM:

- generation successfully loaded the trained `.pt` checkpoint
- generation successfully loaded the copied `pipeline_data/population_output/vanquish_heights.json`
- step `[4/6] Generating placements` is extremely slow for a full-world run
- progress logging only occurs every 25 outer `lb_x` rows
- there may be long periods with no log-file updates even while the process is still alive

Observed operational signals:

- process stayed alive with high CPU usage
- GPU usage was modest but nonzero during generation
- no SQL output file was written early, implying the script accumulates work in
  memory and writes later in the run

Interpretation:

- whole-world generation is likely a multi-hour run, not a short test pass
- this is too slow for quick iteration without a smaller-region generation mode

### Critical later finding

During a longer whole-world generation run, the first visible progress report was:

- `10% (0 LBs, 0 objects, 0 houses, 0 encounters, 6674s)`

Interpretation of that line:

- the generator spent roughly `6674s` (`~1.85` hours) reaching the first 10% progress mark
- zero landblocks produced accepted placements
- zero objects survived into output
- zero housing placements and zero encounters were emitted

This is currently the most important generation result in the project.

Practical meaning:

- full-world generation should **not** be trusted as productive in its current state
- training may be numerically improving while inference still produces no usable world output
- the next step is not "run longer and hope"
- the next step is to instrument and debug the generation pipeline

Most likely causes to investigate next:

1. raw placements are being generated but all are removed by `validate_placements`
2. the model is emitting mostly unusable or special-token outputs at inference
3. context mismatch between training and inference is severe enough that outputs collapse
4. ocean-mask / difficulty / culture / terrain conditioning is causing systematic rejection
5. current trained model is simply not inference-viable for this whole-world pass


## Overnight Run / Tarball Plan

Because the VM service account could not create or write to a GCS bucket, the
current overnight plan is:

1. let generation continue
2. when generation finishes, bundle local artifacts into a tarball in the repo root
3. shut the VM down automatically

Expected local artifact name pattern:

- `artifacts_YYYYMMDDTHHMMSSZ.tar.gz`

Files expected inside the tarball:

- `generate.log`
- `training.log`
- `pipeline_data/models/scene_placer_best.pt`
- `pipeline_data/models/scene_placer_final.pt`
- `pipeline_data/models/resume.pt`
- `pipeline_data/models/logs/training_history.json`
- `docs/PopulationPipelineProgress.md`
- `docs/PopulationPipelineStrategy.md`
- `pipeline_data/population_output/vanquish_ml_populated.sql` if generation completes

Important consequence for the next agent:

- do **not** assume results were uploaded anywhere
- the first recovery step should be to restart the VM if needed and check for the
  tarball in the repo root
- because the generation run showed `10%` progress with zero accepted placements,
  the next agent should strongly consider stopping the overnight whole-world run
  and preserving logs/checkpoints rather than paying for many more hours blindly


## What OutdoorML Currently Means

The current `OutdoorML` stage should be interpreted as:

- a workable outdoor placement model
- useful for local retail-style object sequencing and broad outdoor texture
- not a complete authored-world replacement

It does **not** currently demonstrate:

- full AC-developer-quality town authoring
- strong multi-landblock planning
- interior fidelity
- rich linked-object reconstruction
- full semantic world design

This aligns with the strategy in `docs/PopulationPipelineStrategy.md`:

- `OutdoorML` is one stage of a hybrid population pipeline
- it should not be expected to solve the whole world alone


## Current Risks / Open Issues

1. Missing non-pointer LFS assets
   - some referenced files on the VM are only LFS stubs
   - this may affect later steps or silently degrade results

2. Missing `vanquish_heights.json`
   - extractor fell back to zero heights
   - training quality may be materially worse because of this

3. Entropy-collapse handling is still rough
   - it repeatedly halves learning rate during early collapse phases
   - scheduler behavior and manual LR edits may be fighting each other

4. Output-format mismatch
   - logs mention `.safetensors`
   - actual files are `.pt`

5. No generation-quality verdict yet
   - training metrics improved
   - generated world quality has not yet been evaluated in practice


## Recommended Next Steps

1. Recover the local tarball from the repo root after the VM run or stop the VM and preserve current artifacts.
2. Treat the `10% / 0 objects / 0 LBs` generation result as a primary debugging signal.
3. Patch `generate_populated_world.py` to log:
   - raw placements produced per landblock
   - accepted placements after validation
   - skip counts by reason where possible
4. Add a small-region generation mode before attempting another full-world run.
5. Clean up checkpoint/logging consistency in `train_scene_placer.py`.
6. If a meaningful SQL output is ever produced, then run:
   - `scripts/PopulationPipeline/OutdoorML/score_placement_quality.py`
7. Do not make strong quality claims about OutdoorML until inference produces nontrivial accepted output.


## Fast Handoff Summary

If a new agent picks this up, the key facts are:

- repo structure for population work has already been reorganized
- extractor is confirmed working on a real L4 VM
- training is confirmed working on a real L4 VM
- early overfit stopping was patched and is no longer the immediate blocker
- current best signal is that validation improved to about `2.5x` range while
  entropy recovered to about `2.8`
- full-world generation is slow enough that overnight execution is expensive
- first whole-world generation signal was `10%` progress after hours with zero accepted output
- no trustworthy claim about final world quality should be made until inference
  produces nontrivial accepted placements and scoring can run
