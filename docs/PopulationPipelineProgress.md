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

### Important March 24 follow-up: teacher-forcing fix and resumed training

A likely train/infer mismatch was identified in `train_scene_placer.py`:

- the dataset was effectively feeding the current token as both input and target
- that allowed validation loss to improve without requiring real next-token autoregressive behavior
- inference, however, starts from an empty prompt / zero token, so this mismatch could make training look healthier than generation

A patch was applied so teacher forcing now shifts the sequence right correctly.

Observed result after resuming training from `resume.pt` with the fix:

- resumed training ran from about epoch `600` into the `680s`
- training metrics improved materially during that run
- representative later validation points included:
  - epoch `649`: `val=2.9462`, `ent=3.0`
  - epoch `659`: `val=2.8176`, `ent=3.3`
  - epoch `679`: `val=2.7083`, `ent=3.4`

Important caveat:

- the resumed run stopped unexpectedly before reaching a normal final-save path
- `resume.pt` was saved at epoch `674`
- `training_history.json` recorded progress through about epoch `682`
- therefore the latest training history is newer than the latest saved resume checkpoint


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

### Small-region generation probe after instrumentation

A small-region probe was run on `lb_x=30..34`, `lb_y=120..124` after adding generation diagnostics.

#### Probe 1: old `scene_placer_best.pt`

Using the older best checkpoint already on disk:

- raw placements generated: `0`
- accepted after validation: `0`
- `PAD` samples: `3000`
- `STOP` samples: `0`

Interpretation:

- the old `scene_placer_best.pt` is a pure PAD-collapse inference checkpoint
- validation is not the reason output disappears for that checkpoint
- the model emits no real object tokens at all

#### Probe 2: exported EMA from post-fix `resume.pt`

The EMA weights from `resume.pt` were exported into a full inference-loadable checkpoint and tested on the same `5x5` region.

Observed result:

- raw placements generated: `0`
- accepted after validation: `0`
- `PAD` samples: `2846`
- `STOP` samples: `154`

Interpretation:

- the post-fix checkpoint is not identical to the old PAD-only collapse
- it now emits a mix of `PAD` and `STOP`
- however, it still emits zero real object tokens
- inference is therefore still non-viable in the current checkpoint state

This is a more precise diagnosis than the earlier whole-world `10% / 0 objects` finding:

- validation is not removing real placements
- the current checkpoint fails earlier, at token generation
- the model is still collapsing at first-token inference, even after the teacher-forcing fix


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
   - training metrics improved after the teacher-forcing fix
   - small-region inference still emits zero real placements
   - current failure mode is mostly `PAD`, with newer checkpoints showing some `STOP`


## Recommended Next Steps

1. Recover the local tarball from the repo root after the VM run or stop the VM and preserve current artifacts.
2. Treat the `10% / 0 objects / 0 LBs` full-world result and the `5x5` probe `PAD/STOP` collapse as the primary debugging signals.
3. Do not spend more time on full-world generation until the small-region probe produces nonzero raw placements.
4. Treat first-token / start-token inference behavior as the immediate debugging target.
5. Resume training again from `resume.pt` on the next VM session.
6. Every `25-50` epochs, export the current EMA weights to an inference checkpoint and rerun the same `5x5` probe region.
7. If probe output remains `PAD/STOP` only, inspect and redesign start-token handling at inference and/or training.
8. Clean up checkpoint/logging consistency in `train_scene_placer.py`.
9. If a meaningful SQL output is ever produced, then run:
   - `scripts/PopulationPipeline/OutdoorML/score_placement_quality.py`
10. Do not make strong quality claims about OutdoorML until inference produces nontrivial accepted output.


## Fast Handoff Summary

If a new agent picks this up, the key facts are:

- repo structure for population work has already been reorganized
- extractor is confirmed working on a real L4 VM
- training is confirmed working on a real L4 VM
- early overfit stopping was patched and is no longer the immediate blocker
- current best signal is that validation improved to about `2.5x` range while
  entropy recovered to about `2.8`
- after the teacher-forcing fix, resumed training improved into roughly `val=2.7`, `ent=3.4`
- full-world generation is slow enough that overnight execution is expensive
- first whole-world generation signal was `10%` progress after hours with zero accepted output
- old `scene_placer_best.pt` is PAD-only collapse at inference
- exported EMA from the newer resumed run emits some `STOP` plus lots of `PAD`, but still zero real objects
- no trustworthy claim about final world quality should be made until inference
  produces nontrivial accepted placements and scoring can run


## March 27, 2026: Full-World Generation Milestone

The most important update after the earlier PAD/STOP debugging is that a full
OutdoorML world generation run completed successfully on March 27, 2026.

Reference artifacts:

- `pipeline_data/population_output/fullworld_scene_placer_resume_ema_20260327T001000Z.sql`
- `pipeline_data/population_output/fullworld_scene_placer_resume_ema_20260327T001000Z_summary.json`
- `pipeline_data/population_output/quality_report.json`

Observed full-world summary:

- model: `scene_placer_resume_ema.pt`
- generation time: `6657s`
- populated landblocks: `57,121`
- objects: `605,636`
- houses: `104`
- encounters: `120,727`
- raw generated: `602,215`
- accepted after validation: `602,215`
- `STOP` samples: `56,140`
- `PAD` samples: `18,653`
- collision rerolls: `145,979`
- injected lifestones: `3,095`
- injected vendors: `326`

Observed housing integrity:

- valid housing links written
- house mix:
  - `Cottage: 2`
  - `Villa: 47`
  - `Mansion: 55`

Observed score summary:

- total score: `77.8/100`
- grade: `B (Good)`
- strengths:
  - `no_collisions: 10.0`
  - `ground_snap: 10.0`
  - `density_appropriate: 9.4`
  - `vendor_presence: 9.7`
  - `essential_services: 9.3`
- weaknesses:
  - `building_integrity: 3.4`
  - `variety: 5.5`
  - `clustering: 5.9`
  - `cultural_coherence: 7.0`

Interpretation:

- inference viability is no longer the primary blocker
- OutdoorML now produces a usable full-world artifact
- the next phase is quality improvement, not first-token rescue
- quality claims should still stay disciplined because the system still leans on
  post-generation completion passes and some structure semantics remain weak


## Current OutdoorML Baseline

The current safe baseline is:

- model family: `scene_placer_resume_ema.pt`
- fixed `5x5` probe baseline:
  - `accepted_after_validation: 422`
  - `PAD: 11`
  - `STOP: 24`
- current safe feature width:
  - context dim `224`
- active keepers from March 26:
  - improved slumlord-to-housing family labels
  - name-based fallback housing mapping
  - warmup / entropy-rail training fixes
  - vendor and lifestone completion passes in generation

The following branch remains parked:

- `227`-dim housing-prior context expansion

Reason:

- it regressed the stable probe baseline and is not currently better than the
  safe `224`-dim line


## What The Bottleneck Is Now

The bottleneck is no longer:

- zero-output inference collapse

The bottleneck is now:

- getting better structure semantics and higher world-quality scores without
  losing the current density and stability baseline

Concretely, the next ML work should target:

1. better building integrity
2. better variety and clustering
3. more retail-like service semantics in dense towns
4. better slumlord / housing-link fidelity
5. less dependence on lifestone / vendor completion passes over time


## Recommended Next Work

The current highest-leverage plan is:

1. Freeze the March 27 full-world run as the reference baseline.
2. Keep using the fixed `5x5` probe as a regression guardrail, not as the sole success criterion.
3. Make label-quality and retail-supervision improvements that do not widen model input beyond `224`.
4. After each extractor change, run a bounded training slice rather than a long unattended training run.
5. After each bounded slice:
   - rerun the fixed `5x5` probe
   - rerun one representative scored region such as a validated `20x20`
6. Only schedule another full-world run after the bounded checks show a real quality improvement without probe regression.


## Specific Next ML Targets

Priority 1: Structure and service semantics

- analyze dense generated landblocks that still lack vendors, portals, or
  lifestones
- derive better retail supervision for when dense settlements should contain
  services
- try to teach more of that behavior in extraction labels before adding more
  heuristics

Priority 2: Housing-link quality

- analyze partial slumlord-link cases in the current full-world output
- compare them against retail slumlord / child-link patterns
- improve supervision so generated housing landblocks more often produce the
  right linked-object structure directly

Priority 3: Structure-family diversity

- analyze retail structure-family frequency and co-occurrence by settlement type
- improve label semantics so the model has a cleaner target for town-like
  diversity and clustering


## Current Decision Rules

- If the fixed probe regresses materially from `422 / PAD 11 / STOP 24`, stop.
- If the probe holds but regional scoring gets worse, stop.
- If a candidate only looks better because heuristic completion passes are doing
  more work, treat it as suspect.
- If a label change improves regional scores while preserving probe behavior,
  keep it and continue bounded training.
- Do not widen context or restart architecture exploration until the current
  label-quality path is clearly exhausted.


## Recommended Immediate Repo Tasks

1. Update stale docs that still describe full-world generation as blocked.
2. Add a retail-analysis workflow focused on:
   - dense towns missing services
   - slumlord link coverage
   - structure-family co-occurrence
3. Keep the March 27 summary and quality report paths visible in future handoff notes.
4. Prefer bounded, scored experiments over blind overnight full-world runs.


## March 26, 2026: Housing-Label Refresh + Bounded Retraining

The next focused training-quality step was completed on March 26, 2026 with a
small extraction change rather than another blind epoch sweep.

### What changed

`scripts/PopulationPipeline/OutdoorML/extract_placement_tensors.py` was updated
to classify retail slumlord WCIDs into coarse housing families using the shared
slumlord taxonomy in `scripts/PopulationPipeline/OutdoorML/housing_linker.py`.

Before this change:

- all `WT_SLUMLORD` instances collapsed to `HOUSING_COTTAGE_TOKEN`

After this change:

- cottage / villa / mansion are extracted separately
- unknown slumlord WCIDs fall back to cottage instead of losing housing signal
- the extractor prints the housing-token breakdown in its summary

Observed extractor summary on the VM:

- `Housing supervision tokens: 280`
- `cottage=137`
- `villa=63`
- `mansion=70`
- `fallback=10`

### Bounded training slice

Training resumed from `pipeline_data/models/resume.pt` and ran from epoch
`725` through `750` on `worldbuilder-l4` (NVIDIA L4).

Observed end-of-slice state:

- resumed at epoch `725`
- completed through epoch `749`
- wrote updated `resume.pt` and `resume_epoch_750.pt`
- best validation loss remained `2.4673`
- final validation at epoch `749`: `val=2.6074`
- final diversity:
  - `wcid_entropy: 3.3908`
  - `unique_wcids: 819`
  - `pos_std: 0.2734`

Interpretation:

- the slice was intentionally short and safe
- this was a data-quality verification run, not an attempt to chase val-loss gains
- the important question was whether inference quality held after the label fix

### Fixed-probe result after retraining

The standard fixed `5x5` probe was rerun with the known-good baseline settings:

- `--temperature 1.0`
- `--top-k 0`
- `--nucleus-p 1.0`
- `--min-objects 5`
- `--adaptive-min-objects-bonus 2`
- `--pad-logit-bias 1.0`
- `--stop-logit-bias 0.5`

Observed result:

- `Raw generated: 422`
- `Accepted: 422`
- `PAD samples: 11`
- `STOP samples: 24`
- `Housing toks: 0`

Interpretation:

- the post-label-fix checkpoint preserved the known-good density baseline exactly
- no regression was observed on the reference probe
- the housing-label change did not damage inference viability

### Aggressive housing stress probe after retraining

The explicit housing-path validation probe was rerun with aggressive housing
forcing:

- `--housing-logit-bias 4.0`
- `--housing-min-placements 0`
- `--housing-flatness-threshold 0.0`
- `--housing-difficulty-ceiling 1.0`
- `--max-housing-per-lb 2`

Observed result:

- `Raw generated: 422`
- `Accepted: 422`
- `Housing toks: 2`
- `Houses placed: 2`
- housing integrity valid
- both sampled houses were `Villa`

Interpretation:

- the housing path remained fully functional after retraining
- the new multi-family supervision is active enough to surface non-cottage
  housing under stress settings
- mild baseline housing remains a training/data-quality challenge, but the
  change was still worth keeping because it improved labels without harming the
  stable probe baseline

### Current conclusion

This was a successful bounded iteration.

- The training-data improvement was plausible and high-value.
- The VM returned to bounded training quickly.
- The reference probe baseline was maintained exactly.
- Housing stress behavior remained valid.

The next best step is likely another small semantic training-data improvement or
a targeted quality evaluation, not an open-ended epoch run.

## March 26, 2026: GPU Validation, CPU/CUDA Divergence, and Service Completion

Follow-up validation on the same VM showed an important environment-specific
behavior that affected inference conclusions.

### CPU vs CUDA divergence

The same validated checkpoint and fixed `5x5` probe settings produced materially
different outputs depending on whether inference ran on CPU or the NVIDIA L4:

- CUDA run: `422` accepted, `PAD=11`, `STOP=24`
- CPU fallback run: `320` accepted, `PAD=10`, `STOP=24`

Interpretation:

- the checkpoint was not regressing
- the apparent density drop came from CPU fallback
- OutdoorML validation on this VM should be treated as CUDA-required

Code changes were made so:

- `run_small_region_probe.py` now requires CUDA by default
- `generate_populated_world.py` supports `--require-cuda`
- `debug_first_token_logits.py` supports `--require-cuda`
- CPU fallback now warns explicitly instead of silently looking authoritative

### Revalidated fixed-probe baseline on GPU

Rerunning the standard fixed `5x5` probe on the L4 reproduced the known-good
reference exactly:

- `Raw generated: 422`
- `Accepted: 422`
- `PAD samples: 11`
- `STOP samples: 24`
- quality score: `79.5/100`

This re-established the working inference baseline.

### Revalidated housing stress path on GPU

The explicit housing stress settings were rerun on the L4 and again matched the
earlier reference:

- `Raw generated: 422`
- `Accepted: 422`
- `Housing toks: 2`
- `Houses placed: 2`
- both houses were `Villa`
- quality score: `74.1/100`

Interpretation:

- housing generation remains functional
- the aggressive housing settings are still proof-of-path settings, not quality-balanced defaults

### Medium and intermediate region validation

Two larger bounded CUDA-backed runs were completed.

`10x10` region:

- `989` accepted placements across `100` landblocks
- `0` empty landblocks
- quality score: `83.8/100`

`20x20` region, raw baseline:

- `4,498` accepted placements across `400` landblocks
- `0` empty landblocks
- `4` houses
- `294` encounters
- corrected quality score after fixing a scorer bug: `76.7/100`

Important scorer fix:

- `score_placement_quality.py` was incorrectly treating some housing child WCIDs
  as slumlords via `weenie type 55`
- this understated `building_integrity`
- the scorer now classifies real slumlords using `housing_linker.classify_slumlord_house_type`

### Structural diagnosis at scale

The large-region structural weakness was not collapse, density, or collision.
It was missing settlement services:

- vendor coverage in dense town-like landblocks: `10/16`
- portal coverage in town-like landblocks: `40/42`
- lifestone coverage in town-like landblocks: `0/42`
- slumlord link coverage after scorer fix: `4/4`

Interpretation:

- housing integrity is acceptable
- the main missing semantic at scale was lifestone presence
- vendor presence was secondary but still incomplete

### Inference-side service completion passes

Two narrow inference-side completion passes were added in
`generate_populated_world.py`.

1. Town lifestone completion

- enabled by default
- injects retail `lifestone` `wcid 509`
- only for dense, portal-bearing, town-like landblocks that generated no lifestone

Effect on the same `20x20` region:

- injected lifestones: `38`
- quality score improved from `76.7` to `80.8`
- `essential_services` improved from `4.8` to `9.3`
- lifestone coverage improved from `0/42` to `38/42`

2. Town vendor completion

- injects a retail vendor only for dense portal+lifestone town-like landblocks
  that still have no vendor
- uses a small culture-aware WCID mapping where available and a neutral fallback otherwise

Effect on the first `20x20` region when combined with lifestone completion:

- injected vendors: `4`
- quality score improved from `80.8` to `83.1`
- vendor coverage improved from `10/17` to `14/17`

Second-region validation (`x=50..69`, `y=120..139`):

- lifestone-only path scored `81.7/100`
- vendor-completion path scored `83.6/100`
- vendor coverage improved from `15/21` to `19/21`
- injected vendors: `4`

Current recommendation:

- keep the lifestone completion pass in the validated default path
- keep the vendor completion pass in the validated default path as well
- use `--no-inject-town-vendors` only for explicit ablation / debugging
- full-world generation should use CUDA and the current validated inference path, not CPU fallback
