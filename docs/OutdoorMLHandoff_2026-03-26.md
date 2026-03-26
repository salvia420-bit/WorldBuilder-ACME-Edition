# OutdoorML Handoff - 2026-03-26

## Date
- March 26, 2026

## Objective
- Improve OutdoorML training quality without losing the now-working inference behavior.
- Prioritize housing supervision and bounded training over long analysis or blind full-world runs.

## Confirmed Starting Point
- Inference collapse was already fixed before this session.
- Known-good baseline fixed probe used:
  - model: `scene_placer_resume_ema.pt`
  - settings:
    - `--temperature 1.0`
    - `--top-k 0`
    - `--nucleus-p 1.0`
    - `--min-objects 5`
    - `--adaptive-min-objects-bonus 2`
    - `--pad-logit-bias 1.0`
    - `--stop-logit-bias 0.5`
- Known-good fixed 5x5 probe baseline:
  - `accepted_after_validation: 422`
  - `PAD samples: 11`
  - `STOP samples: 24`
- Prior large-region score remained weak:
  - `65.1/100`
  - sparse housing / structure / links

## What We Changed Successfully

### 1. Housing supervision labels improved
- File:
  - `scripts/PopulationPipeline/OutdoorML/extract_placement_tensors.py`
  - `scripts/PopulationPipeline/OutdoorML/housing_linker.py`
- Change:
  - slumlords no longer all collapse to cottage
  - extraction now maps retail slumlords into:
    - `HOUSING_COTTAGE`
    - `HOUSING_VILLA`
    - `HOUSING_MANSION`
  - added name-based fallback classification for slumlords not covered by explicit WCID family mapping
- Result after extraction on VM:
  - `Housing supervision tokens: 280`
  - `Breakdown: cottage=137, villa=63, mansion=80, fallback=0`
- This is good and should be kept.

### 2. Bounded post-label training slice succeeded safely
- Training run on `worldbuilder-l4`:
  - resumed from epoch `725`
  - trained to `750`
- Probe result after that bounded run:
  - baseline probe preserved exactly:
    - `accepted: 422`
    - `PAD: 11`
    - `STOP: 24`
- Aggressive housing diagnostic also still worked:
  - `Housing toks: 2`
  - `Houses placed: 2`
- Conclusion:
  - label fix was safe and worthwhile
  - it did not improve normal housing on the fixed probe by itself
  - but it preserved the working checkpoint quality

### 3. Retail housing analysis established an important fact
- New helper added:
  - `scripts/PopulationPipeline/OutdoorML/analyze_retail_housing.py`
- Retail SQL analysis on VM showed:
  - `Outdoor landblocks: 2681`
  - `Housing landblocks: 593`
  - `Total slumlords: 3250`
  - `Avg objects / housing LB: 49.7`
  - `Avg objects / non-housing LB: 7.3`
- Interpretation:
  - housing landblocks are a real and dense retail subset, not a fringe case

### 4. Training rails were improved and should be kept
- File:
  - `scripts/PopulationPipeline/OutdoorML/train_scene_placer.py`
- Fixes kept:
  - entropy-collapse LR halving is disabled until after warmup / `min_entropy_check_epoch`
  - low early validation entropy now logs a note instead of immediately halving LR
  - effective warmup is capped for short runs
    - new config fields:
      - `warmup_fraction_cap`
      - `warmup_min_epochs`
  - example:
    - `--epochs 100` now reports `Effective warmup epochs: 20`
    - previously the same run effectively stayed in `200`-epoch warmup the whole time
- These fixes reduced obviously broken scratch-training behavior and should remain.

## What We Tried And Rejected

### 227-dim housing-prior context expansion
- We temporarily added 3 new context features:
  - `is_housing_landblock`
  - normalized `slumlord_count`
  - neighboring housing-landblock ratio
- This widened context from `224` to `227`.
- We tested it two ways:

#### A. Partial resume after widening context
- Resume path loaded compatible weights and skipped mismatched input tensors.
- Result on fixed baseline probe:
  - only `236 accepted`
- This was a regression from `422`.

#### B. Fresh scratch training with widened context
- Before rail fixes:
  - wildly overshot density, including `1300+` accepted on the fixed probe
- After entropy-rail and warmup fixes:
  - fixed probe settled to:
    - `accepted: 571`
    - `PAD: 10`
    - `STOP: 24`
  - score:
    - `74.5/100`
    - `density_appropriate: 0/10`
- This was still worse than the known-good stable probe:
  - stable probe score: `79.5/100`
  - stable accepted count: `422`
- Conclusion:
  - the widened-context experiment is not currently better
  - it should be parked for now

## Current Recommended Safe State
- Keep:
  - improved slumlord housing label extraction
  - name-based fallback label mapping
  - training warmup / entropy-rail fixes
- Do not keep active:
  - the `227`-dim context expansion
  - housing-landblock priors as active model inputs

## Local Repo State At Handoff
- The repo was patched back to the safer `224`-dim path while preserving:
  - improved housing labels
  - training rail fixes
- Files touched in the safe rollback:
  - `scripts/PopulationPipeline/OutdoorML/extract_placement_tensors.py`
  - `scripts/PopulationPipeline/OutdoorML/generate_populated_world.py`
  - `scripts/PopulationPipeline/OutdoorML/debug_first_token_logits.py`
  - `scripts/PopulationPipeline/OutdoorML/train_scene_placer.py`

## VM Commands To Resume Safely

### 1. Sync latest repo on the VM
```bash
cd ~/WorldBuilder-ACME-Edition

git stash push -m "vm sql path tweak before 224 rollback sync" -- scripts/PopulationPipeline/OutdoorML/extract_placement_tensors.py
git pull --ff-only origin master
```

### 2. Reapply VM SQL path
```bash
python3 - <<'PY'
from pathlib import Path
p = Path("scripts/PopulationPipeline/OutdoorML/extract_placement_tensors.py")
text = p.read_text()
old = r'RETAIL_SQL = r"D:\ACE\world-db\ACE-World-Database-v0.9.292.sql"'
new = r'RETAIL_SQL = r"/home/salvia420/WorldBuilder-ACME-Edition/ace_world_release/ACE-World-Database-v0.9.292.sql"'
if old not in text:
    raise SystemExit("Expected Windows RETAIL_SQL line not found")
p.write_text(text.replace(old, new, 1))
print("updated RETAIL_SQL path for VM")
PY

grep -n "RETAIL_SQL" scripts/PopulationPipeline/OutdoorML/extract_placement_tensors.py
git stash drop stash@{0}
```

### 3. Rebuild safe tensors
```bash
python3 scripts/PopulationPipeline/OutdoorML/extract_placement_tensors.py
```

Expected extractor signs:
- `Context dim: 224`
- housing breakdown still present
- no `Housing landblock priors` line

### 4. Resume the safe checkpoint line
```bash
python3 scripts/PopulationPipeline/OutdoorML/train_scene_placer.py \
  --resume pipeline_data/models/resume_baseline_2026-03-26_epoch750.pt \
  --epochs 775
```

### 5. Re-run the fixed baseline probe
```bash
python3 scripts/PopulationPipeline/OutdoorML/run_small_region_probe.py \
  --model resume.pt \
  --temperature 1.0 \
  --top-k 0 \
  --nucleus-p 1.0 \
  --min-objects 5 \
  --adaptive-min-objects-bonus 2 \
  --pad-logit-bias 1.0 \
  --stop-logit-bias 0.5
```

Target result to regain confidence:
- around `422 accepted`
- `PAD` around `11`
- `STOP` around `24`

## Recommended Next Work
- First priority:
  - confirm the safe `224` path is restored on VM with the fixed probe
- Then:
  - focus on training-data / label quality improvements that do not widen model input
- Good next candidates:
  - improve settlement / structure semantics without changing context width
  - investigate better structure / link supervision from retail data
  - preserve the safer fixed-probe baseline while testing bounded changes

## Notes For Next Agent
- Do not spend time on blind overnight full-world runs.
- Do not assume lower val loss means better world quality.
- Judge every bounded training slice against the fixed 5x5 probe baseline of:
  - `422 accepted`
  - `PAD 11`
  - `STOP 24`
- The slumlord label fix is a keeper.
- The `227`-context housing-prior experiment is currently a failed branch and should stay parked unless redesigned.
