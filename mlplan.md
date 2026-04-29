# ML Plan — Final Push (30 GPU-hr budget)

Date: 2026-04-29. Author: Claude (collaborating with salvia420).

## Status

- Active training run **killed** at epoch 43/100 to preserve credits.
- Shipping checkpoint preserved: `pipeline_data/models/SHIPPING_unified_v6_atlas_ep41_20260429.safetensors` (v6 unified atlas, val_total 3.78, top1=0.911).
- v6 atlas checkpoint is **not loadable** by the current `generate_populated_world.py` — generator was written before atlas mode and lacks `AtlasContextEncoder` / atlas-tensor wiring.
- v4 (`unified_v4_clean_ctx_20260427T2315Z_best.safetensors`) is non-atlas and **does** load cleanly.

## Measured product score (v4, region LB 30..49 × 120..139)

```
QUALITY SCORE: 69.4/100  (grade C)
  Structural 18.0/40        ← gap
    vendor_presence       0.6/10
    essential_services    0.3/10
    cultural_coherence    7.0/10
    building_integrity   10.0/10
  Spatial    29.3/30  ✓
  Diversity  22.1/30
    clustering            2.1/10  ← gap
```

The 69.4 is **inflated** because `pipeline_data/enrichment/retail_baseline.json` is missing; the `density_appropriate` sub-score fell back to a default `density_mean=10.0`. Running with `--compare retail.sql` drops the score to 60.0, but the retail parser (`score_placement_quality.py`) also has a regex bug (rejects `'\0'` for `is_Link_Child`) so even that 60.0 is a lower bound, not honest.

## Root-cause findings

### 1. The model over-populates by ~30×

| Metric (LB 30..49 × 120..139) | v4 generated | Retail (truth) |
|---|---:|---:|
| total instances | 4,265 | 141 |
| LBs with content | 400 / 400 | 24 / 400 |
| town-like LBs (≥15 obj) | 60 | 3 |
| portal LBs | 8 | 7 |
| lifestone LBs | 4 | 2 |
| vendor LBs | 6 | 2 |

Absolute service counts roughly match retail; the structural sub-score is wrecked because the model inflates wilderness LBs past the 15-object "town-like" threshold, and the scorer expects services in those.

### 2. The corpus extractor never emitted empty LBs

`scripts/PopulationPipeline/OutdoorML/extract_component_linked_tensors.py:686-688`:

```python
outdoor_rows = [row for row in all_rows if row[11] < 0x0100]
if not outdoor_rows:
    continue
landblocks_emitted += 1
```

Compounded by `populated_lbs` being itself a filtered list of LBs that have any row at all. The model has never been trained on a `context → STOP-immediately` example, so it cannot represent "this LB is empty." Forcing the model to pick a min count is a symptom, not a cause.

### 3. Injection cascade is not the bottleneck

`maybe_add_town_lifestone` requires `has_portal AND not has_lifestone`. `maybe_add_town_vendor` requires `has_portal AND has_lifestone AND not has_vendor`. There is no portal injector. So a single missing portal short-circuits the whole chain. **But** retail itself only has 7 portal LBs in the test region, which roughly matches our 8 — so adding a portal injector would worsen fidelity, not improve it. The injection chain is fine; the *scorer's* "town-like LB" definition fires too often because the model over-populates.

## Plan

### Phase A — Corpus rebuild (1–2 hr, CPU)

Goal: teach the corpus to include empty/sparse LBs so the model learns that wilderness should produce immediate STOP.

1. Patch `extract_component_linked_tensors.py` around line 680–690:
   - Iterate over **all** outdoor LBs in the world-features dataset, not just `populated_lbs`.
   - For LBs with no outdoor rows, emit a single sequence whose first token is `STOP` (length-1).
   - Build the same 31-dim context block (terrain stats, biome, scene_kind=outdoor) so the model can learn "this terrain implies empty."
   - Sample empty LBs at retail's empirical rate. Don't 95%-empty the corpus; cap at ~50–60% empty so positive signal isn't drowned. Tune by counting retail's empty-LB share globally.

2. Output to a fresh path so v4/v5 corpora are preserved:
   - `pipeline_data/reference/component_linked_unified_v7_tensors.npz`
   - `pipeline_data/reference/component_linked_unified_v7_vocab.json`
   - Vocab can be reused from v4 (4,584 entries) — empty examples don't add WCIDs.

3. Sanity check the new corpus: load the npz, verify `seq_lengths` distribution shows a real peak at 1 (the STOP-only sequences) plus the existing distribution.

### Phase B — Train v7 non-atlas (~25–28 hr, GPU)

Reasons for non-atlas:
- Existing `generate_populated_world.py` loads non-atlas checkpoints natively.
- Avoids the 1–2 hr atlas-generator extension and the unknown atlas lift.
- v6's atlas warmup gave a ~0.5pp DAT bump in training metrics — not enough to bet the budget on.

Hyperparameters (refinements over v4):

```
--tensor-path  pipeline_data/reference/component_linked_unified_v7_tensors.npz
--vocab-path   pipeline_data/reference/component_linked_unified_v7_vocab.json
--epochs 60 --batch 128 --patience 8 --validation-every 3
--val-split-mode region
--lr-schedule cosine --lr 5e-5 --lr-min 1e-6
--warmup-epochs 5 --warmup-min-epochs 5 --warmup-fraction-cap 0.10
--ace-abstract-weight 4.0
--dat-inv-freq --dat-clamp-max 3.0
--label-smoothing 0.15           # +0.05 vs v6: counter overfit gap
--lambda-marginal-kl 0.12        # +0.09 vs v6: push tail coverage
--focal-gamma 0.0
--resume-checkpoint-every 5
```

Runtime estimate at v6's pace (~21 min/epoch): 60 epochs × 21 min ≈ 21 hr. With patience=8 and validation-every=3, expected actual stop at 30–40 epochs. Reserve ~5 hr buffer.

### Phase C — Score and ship (1 hr)

1. Generate the canonical region with v7 (same `--lb-x-min 30 --lb-x-max 49 --lb-y-min 120 --lb-y-max 139` box).
2. Score with `score_placement_quality.py`. Target: 80–85, matching the legacy outdoor-only baseline.
3. Compare via `--compare ace_world_release/ACE-World-Database-v0.9.292.sql ...` once the regex below is patched.
4. Save the SHIPPING checkpoint with name `SHIPPING_unified_v7_<date>.safetensors`.

### Side patch — Score harness retail parser (10 min)

`scripts/PopulationPipeline/OutdoorML/score_placement_quality.py:65` — current regex:

```python
r"(\d+),'([^']*)'\)"   # last (\d+) is is_Link_Child as int
```

Retail uses `'\0'` or `''` for `is_Link_Child`, so the regex matches **zero** retail rows. Patch to accept either form (capture group can be `(\d+|'[^']*')` then post-process), so `--compare` mode actually works. Otherwise the scorer's retail-baseline path is silently dead.

## Decision points

- **If Phase A reveals a deeper issue** (e.g., world-features doesn't enumerate empty LBs cleanly), fall back to: keep v4 as ship checkpoint, accept ~70 score, redirect remaining budget to interior pipeline or planner work.
- **If Phase B at epoch 15–20 isn't beating v4 val_total** (6.02 at ep34): kill the run, ship v4, save the rest of the budget.
- **If v7 scores ≥ 80 with empty-LB awareness:** ship as SHIPPING_unified_v7. Atlas mode and 30hr-resume become future-iteration questions, not blockers.

## Out of scope (this push)

- Atlas-aware generator extension. Re-evaluate after v7.
- Interior placement pipeline. The unified extractor patch should still preserve interior-component sequence emission unchanged.
- Settlement planner / world-grammar models.
