# OutdoorML Next Steps - 2026-03-27

## Objective

Improve full-world OutdoorML quality from the current March 27, 2026 baseline
without losing the working inference behavior.

Primary target:

- raise full-world score above `80/100`

Primary constraint:

- do not regress the fixed `5x5` probe baseline of:
  - `accepted_after_validation: 422`
  - `PAD: 11`
  - `STOP: 24`


## Current Baseline

Reference full-world run:

- `pipeline_data/population_output/fullworld_scene_placer_resume_ema_20260327T001000Z.sql`
- `pipeline_data/population_output/fullworld_scene_placer_resume_ema_20260327T001000Z_summary.json`
- `pipeline_data/population_output/quality_report.json`

Baseline facts:

- populated landblocks: `57,121`
- objects: `605,636`
- houses: `104`
- encounters: `120,727`
- quality score: `77.8/100`
- model line: safe `224`-dim context path

Current weak areas:

- `building_integrity: 3.4`
- `variety: 5.5`
- `clustering: 5.9`
- some dense landblocks still miss expected service semantics
- generation still relies on lifestone / vendor completion passes


## What To Keep

Keep active:

- improved slumlord housing-family labels
- housing fallback mapping
- training warmup / entropy-rail fixes
- fixed inference baseline settings
- safe `224`-dim feature width
- outdoor-only training-example filtering during extraction
- raw slumlord sample canonicalization back into the housing-token path

Do not reactivate by default:

- `227`-dim housing-prior context expansion


## Recommended Loop

1. Make one extraction or label-quality improvement.
2. Rebuild tensors.
3. Resume training for a short bounded slice.
4. Run the fixed `5x5` probe.
5. Run one representative scored region.
6. Compare against the current baseline.
7. Only after a bounded win, consider another full-world run.


## Priority Order

### 1. Dense-town service semantics

Goal:

- reduce the number of dense town-like landblocks that still need vendor or
  lifestone completion

Work:

- analyze generated dense landblocks without vendors
- compare them with retail service patterns
- improve extraction labels or training targets before adding more heuristics

Success signal:

- regional and full-world service metrics improve while completion counts do not
  rise

### 2. Housing-link fidelity

Goal:

- improve direct generation of correct slumlord-linked housing structure

Work:

- analyze partial slumlord-link coverage in generated outputs
- compare with retail link topology
- improve supervision in extraction labels

Success signal:

- building-integrity score rises
- linked slumlord coverage improves

### 3. Structure diversity and clustering

Goal:

- make settlement composition feel more retail-like

Work:

- analyze retail structure-family frequency and co-occurrence
- improve supervision for settlement-style object families

Success signal:

- variety and clustering scores rise without density blowup


## Hard Rules

- Do not judge candidates by validation loss alone.
- Do not widen context beyond `224` unless the current label path is exhausted.
- Do not run blind overnight full-world jobs for minor changes.
- If the fixed probe regresses, reject the candidate.
- If regional score regresses, reject the candidate even if the probe holds.


## Immediate Tasks

1. Update or add analysis tooling for:
   - dense towns missing services
   - slumlord link coverage
   - structure-family co-occurrence
   - current helper: `scripts/PopulationPipeline/OutdoorML/analyze_population_gaps.py`
2. Choose one label-quality improvement from that analysis.
3. Run one bounded training slice.
4. Re-evaluate with the fixed probe and a scored region.
   - helper script: `run_outdoorml_service_prior_cycle.sh`
   - detached helper: `run_outdoorml_detached.sh`
5. Prefer detached `tmux` launches for bounded runs on SSH sessions that may
   drop before the cycle completes.


## Disciplined Escalation

The current single-stage scene placer has now shown a stable `83.6/100` basin
across multiple materially different training and inference changes. The next
escalation path is therefore a parallel two-stage line, not more scalar tuning
inside the same formulation.

Stage 1 planner:

- predict landblock archetype
- predict coarse family-count bins
- artifacts:
  - `scripts/PopulationPipeline/OutdoorML/extract_settlement_planner_tensors.py`
  - `scripts/PopulationPipeline/OutdoorML/train_settlement_planner.py`

Stage 2 generator:

- keep the current scene placer as the realization model
- later condition it on planner outputs instead of asking it to infer town
  intent and exact object sequence in one step

Rule:

- keep the existing `83.6` line available as a safe baseline while the planner
  path is developed in parallel
