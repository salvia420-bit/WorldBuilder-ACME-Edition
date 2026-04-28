# Unified Scene Placer V5 — production-grade calibration

## Why this exists

Four unified-scene-placer training generations are in `pipeline_data/models/`. The
last (`unified_v4_clean_ctx_20260427T2315Z`, 35 epochs, 12 h on an L4) finished
this morning. It is **not production-grade** and resuming it is pointless: the
LR scheduler is at its floor (1e-6), the loss has plateaued (`train_total ≈
3.93`, `val_total ≈ 6.02`, gap ≈ 2.1 since epoch 25), and the model has settled
in the wrong attractor.

The real failure mode is **WCID diversity collapse**, *not* the headline
"ACE-emit fraction" the previous note focused on:

- Empirical retail in `component_linked_unified_v4_tensors.npz`: **61.3%
  ACE-abstract / 38.7% model_id (DAT)**. The "ideally 100% ACE-emit"
  framing in earlier notes is wrong — retail itself is ~61%, and a model
  that emits ACE 100% of the time would be over-correcting and produce a
  world without DAT scenery (no rocks, trees, walls, candles).
- Final greedy `ace_emit_frac` is 0.577 — about 4 percentage points
  *below* retail balance. Not catastrophic; calibration is mildly biased
  toward DAT.
- Final `unique_wcids` on val greedy decode is **1,560 / 4,572 actually-
  used in the dataset (34%)**. The model is functionally ignoring two
  thirds of the long tail.
- A single token (idx 2, `ace|encounter|type_1|none|surface`) is 38% of
  the training labels. The model is rational to over-rely on it, but
  validation `wcid_entropy` of ~5.48 (≈ 240 effective tokens) means the
  rest of the prediction mass is spread across a small handful of
  popular DAT tokens and a few ACE buckets. The world ends up
  monotonous.

V5 is the calibration pass that turns this from "an architecturally fine
model that under-uses its vocab" into something whose sampled output
matches retail's per-token distribution closely enough to ship.

## Context — what exists in the repo

Read these before touching anything.

### Trainer
- `scripts/PopulationPipeline/OutdoorML/train_scene_placer.py` (1671 lines).
  - **Model**: `ScenePlacerTransformer` (~37.7M params), autoregressive
    transformer over a tokenized object sequence conditioned on a 31-d
    landblock context vector.
  - **Vocab**: 4584 tokens = 4474 `model_id` (DAT) + 108 `ace_abstract`
    (ACE) + 2 special (PAD=0, STOP=1).
  - **Loss**: weighted CE on wcid + MSE on (pos, rot) + BCE on link +
    entropy regularizer + dense-repeat regularizer. The CE is multiplied
    by a per-vocab `class_space_weight` built by `build_class_space_weight`
    (line 253) — the lever that scales `ace_abstract` entries up to
    counter the 41:1 vocab imbalance against `model_id`.
  - **Existing knobs**: `--ace-abstract-weight` (default depends on
    config; v3 used 10.0 with `--focal-gamma 2.0`); `--focal-gamma`
    (default 0.0 in current `DEFAULT_CONFIG`); `label_smoothing=0.2`;
    `lambda_entropy=0.15`; `lambda_dense_repeat=0.35`; `entropy_collapse_threshold=2.0`
    with `min_entropy_check_epoch=60`.
  - **EMA** (line 610) and gradient clipping wired.
  - **Validation**: `val_split_mode="region"` (geographic holdout, honest);
    metrics include `wcid_entropy`, `unique_wcids`, `unique_ratio`,
    `pos_std`, `ace_emit_frac` (line 836).
  - **Auto-batch sizing** (line 876): does its own VRAM probing; don't
    hand-set `batch_size` in launches.

### Vocab + tensors
- `pipeline_data/reference/component_linked_unified_v4_vocab.json` —
  vocab metadata. `target_token_mode = "abstract_ace"`. `idx_to_class_key`
  maps each idx to `["model_id", id]` or `["ace_abstract", bucket_str]`.
- `pipeline_data/reference/component_linked_unified_v4_tensors.npz` —
  228,638 sequences × 256 max length × 14 features. `seq_lengths` mean
  12.5; `contexts` are 31-dim per sequence. The dataset shipped with v4
  is identical in shape to v3 but with a "cleaner" context representation
  (the meaning of `clean_ctx`).
- `pipeline_data/reference/component_linked_unified_v4_bucket_resolver.json`
  — bucket → wcid sampler used by `WcidResolver` at inference time. V5
  must remain compatible with this resolver: don't change vocab indices
  or bucket keys.

### Inference + comparator
- `scripts/PopulationPipeline/OutdoorML/generate_populated_world.py`
  (the inference loop). Currently iterates landblocks only — interior
  emission is still TODO (Tier 1 of the April 27 theory note). V5 doesn't
  need to fix that, but must not break it either.
- `scripts/PopulationPipeline/OutdoorML/compare_world_to_retail.py` (or
  similar) — world-level comparator. Per the April 27 note this exists
  and surfaces "wcid in wrong context", "density drift", "long-tail
  loss", "surface/interior shift". V5 should use it as the primary
  ground-truth metric, not just `val_total`.

### Prior-art reading
- `2026-04-27_pipeline_theory_overview.md` — full pipeline state, with
  "section 4: the class-imbalance trap" being the load-bearing
  background for this prompt.
- `pipeline_data/models/logs/unified_v4_clean_ctx_20260427T2315Z/training_history.json`
  — 35 epochs of full per-epoch metrics. Read it to confirm the
  trajectory before redesigning.
- `pipeline_data/models/logs/unified_classweighted_v3_20260427T1206Z/training_history.json`
  — v3's history (also 30 epochs). Compare v3-vs-v4 trajectory: same
  shape, same plateau, same diversity collapse. The shift in dataset
  context didn't help.

## Intent

Train a v5 checkpoint whose **sampled output distribution matches
retail's per-token distribution** to within tight tolerances. Not "improve
val loss." The model is converging to the wrong distribution; closing the
KL gap to retail is the primary objective. Val loss will follow.

The architecture is fine. The trainer is fine. **The fix lives in some
combination of:** (a) class-space weighting magnitude/shape, (b) sampling-
side priors, (c) one targeted architectural addition (e.g. a two-headed
output: ACE-vs-DAT gate × within-class softmax), and (d) a real eval
loop that measures per-token KL to retail rather than aggregate loss.

## Objectives

1. **Recover the long tail.** `unique_wcids` ≥ 3500 on validation greedy
   decode (76% of the 4572 vocab tokens that actually appear in the
   training data).
2. **Match retail's class-space balance within ±5 percentage points.**
   `ace_emit_frac` ∈ [0.56, 0.66]. Not 100%; not 0%. The retail
   empirical is 61.3% — that's the calibration target, full stop.
3. **Close the train/val gap to ≤ 1.0** (currently 2.1). A gap of 2.0+
   on a model with a heavy class imbalance is a calibration symptom, not
   pure overfitting; the trainer's class weighting interacts non-trivially
   with the validation loss measurement and the gap responds when class
   balance is correct.
4. **Reduce per-token KL to retail.** Compute the empirical token
   distribution over the training set and the model's argmax distribution
   over the validation set; the KL between them must be < 0.5 nats. This
   is the "did you actually learn the long tail" metric.
5. **Don't break the existing inference path.** `generate_populated_world.py`
   + `WcidResolver` + the v4 vocab + bucket resolver must continue to
   work against the v5 checkpoint. Output token vocab and indices are
   frozen.

## Specs

### 1. Diagnose before redesigning

Before touching the trainer, write a one-shot diagnostic script
(`scripts/PopulationPipeline/OutdoorML/diagnose_v4.py`) that loads
`unified_v4_clean_ctx_20260427T2315Z_best.safetensors` and reports:

- **Top-1 confusion**: of validation positions whose label is in the
  ACE-abstract range, what fraction of greedy predictions are ACE? In
  the DAT range? Per-bucket. The aggregate `ace_emit_frac=0.577` masks
  whether the bias is uniform or concentrated on specific token classes.
- **Top-5 / Top-10 accuracy on wcid**, broken down by ACE vs DAT.
  Hypothesis: top-5 ACE accuracy is high (the right token is in the
  candidate set) but top-1 falls off because adjacent DAT tokens win the
  tie-break. If so, the fix is sampling-side temperature on the class
  space, not (or not only) more training.
- **Per-context (scene_kind) breakdown**: does mode collapse correlate
  with one of the scene_kinds (`outdoor`, `interior_anchored`,
  `interior_unanchored`)? `scene_kinds` is in the tensor file.
- **Per-token frequency**: `model_predictions vs labels` for the top-50
  most-emitted-by-model tokens and the top-50 least-emitted-but-frequent-
  in-data tokens. The latter list is the long tail the model is
  ignoring.
- **Vocab utilization heatmap**: `unique_wcids` over training time
  (already in `training_history.json`); plus a per-token heatmap of
  emit-frequency vs train-frequency.

This is a 1-2 hour write, and its output decides whether V5 is a
reweighting problem (small fix) or an architectural problem (larger
fix). Do NOT skip this step.

### 2. Reweighting / loss shape (low-risk, try first)

Based on what the diagnostic surfaces:

- **`--ace-abstract-weight` sweep**. v3 used 10.0; the empirical-vs-emit
  gap suggests we may be slightly under-weighting the long tail. Run a
  short (10-epoch) sweep over `[5, 8, 10, 12, 15, 20, 25]` from the v2
  init weights. **Critical**: do *not* resume from v4 — start fresh from
  v2 best, since v4 is in the wrong basin.
- **`--focal-gamma`**. v3 used 2.0; v4 default is 0.0. A focal-loss
  γ=2.0 down-weights gradient from already-confident classes — exactly
  what's needed to break "the model is too confident on token #2." Try
  `γ ∈ [1.0, 2.0, 3.0]`.
- **Inverse-frequency soft weighting per token**: extend
  `build_class_space_weight` so that within each class space (ACE / DAT)
  weights are also inversely proportional to per-token frequency, not
  uniform. Token #2 (38% of data) gets weight 1/0.38; rare tokens get
  more. Scale gently (use sqrt of inverse frequency, or clamp to
  [0.1, 10.0]) — pure inverse weights blow up training.
- **Label smoothing sweep**: `[0.1, 0.2, 0.3]`. Higher smoothing
  encourages mass on long-tail tokens. Currently 0.2.

Each of these is a 1-2 hour run. Pick the best by per-token KL on
validation, not by `val_total`.

### 3. Architectural escape (if reweighting alone caps below the
acceptance bar)

If the best reweighting result still has `unique_wcids < 3000` or KL
> 0.5 nats:

- **Two-headed output**: split the wcid head into (a) a binary `is_ace`
  gate and (b) two within-class softmaxes (one over the 108 ACE tokens,
  one over the 4474 DAT tokens). Route through the gate at inference.
  This mechanically guarantees the gate's output frequency is exactly
  the empirical retail fraction (training the gate on the binary label
  gives ~61% directly), and the within-class softmax doesn't have to
  learn a 4582-way distribution dominated by one token.
- **Anti-collapse loss term**: add a per-batch term `λ * KL(model_token_marginal,
  empirical_token_marginal)` where the empirical marginal is computed
  once over the training set. λ should be small (~0.01-0.05). This
  directly punishes the failure mode without training-distribution
  changes.
- **Mixture of (ACE expert, DAT expert)** with a shared encoder: each
  expert's softmax is over its own class space; the mixture weight is
  the gate from the previous bullet.

The two-headed output is by far the cheapest move and most directly
addresses the failure mode. Try it first if reweighting caps out.

### 4. Sampling-side temperature (cheap; complement to training fixes)

At inference time `WcidResolver` could apply a class-space temperature.
At greedy decode time the model already commits to one class space; an
`τ_class > 1` would soften the cross-class softmax so ACE tokens win
more often when their logits are close. This is purely an inference-side
change in `generate_populated_world.py` and doesn't require retraining.

If the diagnostic shows top-5 ACE accuracy is high but top-1 fails,
class-space temperature alone may close the gap. Investigate this *before*
launching long training runs.

### 5. Validation harness

The v5 run must, on each validation pass, write a per-token KL report
alongside the existing `wcid_entropy` and `unique_wcids` metrics. The
empirical retail distribution should be precomputed once at startup
from the training tensors (cheap — a few seconds for 2.6M tokens).

Add to `training_history.json`:

```json
{
  "epoch": N,
  ...
  "kl_token_to_retail": 0.42,
  "ace_emit_frac": 0.61,
  "ace_emit_frac_when_label_is_ace": 0.94,
  "ace_emit_frac_when_label_is_dat": 0.06,
  "top5_wcid_acc": 0.71,
  "long_tail_recall": 0.78  // fraction of vocab tokens that appear at least once in val greedy
}
```

These are the metrics V5 must publish. They are also the gate for the
acceptance criteria.

### 6. Run plan

Execute, in order:

1. Write `diagnose_v4.py` and run it. Capture output. (1 day)
2. Based on diagnostic: pick reweighting sweep range. Launch the
   sweep against v2 init weights, 10 epochs each, batch on a single
   L4. (Half a day for 5-7 short runs in series.)
3. Pick the best by per-token KL. If acceptance bar reached, train
   the winner to convergence (40-60 epochs, ~12-18 h). Done.
4. If acceptance bar NOT reached: implement the two-headed output (or
   mixture). Train 10 epochs from v2 init. Compare KL.
5. Final long run with the best architecture + best reweighting.

Total wall-clock budget: **3-5 days**, mostly waiting on training.

## Non-goals — do not do these

- **Do not change vocab indices, the bucket resolver, or the
  `target_token_mode`**. The inference path depends on stable token
  IDs. V5 is a calibration problem, not a vocab problem.
- **Do not change the model architecture except for the wcid head**.
  The 37.7M-param transformer encoder + decoder are working; the issue
  is the output projection.
- **Do not chase `val_total` as the headline metric**. It's confounded
  by the class weighting and doesn't reflect the actual distribution
  match. Per-token KL is the headline.
- **Do not attempt 100% ACE-emit**. That's a misread of the metric.
  The retail target is 61% and overshooting it produces a creature-soup
  world.
- **Do not fix interior-emission inference in this session**. That's
  the April 27 Tier 1 #1 work and is its own scope. V5 is just the
  trainer-side calibration.
- **Do not resume v4**. The optimizer state is at the wrong scheduler
  endpoint. Start runs from v2_best (`unified_overnight_v2_20260426T210549Z_best.safetensors`)
  with `--resume` *and* explicitly drop optimizer/scheduler state in the
  resume code path so warmup re-engages.
- **Do not train without the validation harness from §5**. Adding
  per-token KL to `training_history.json` is a load-bearing prerequisite,
  not a nice-to-have.

## Acceptance criteria

The V5 run is "production-grade" iff, on the held-out (region-mode) val
set with greedy decoding:

| Metric | Bar |
|---|---|
| `unique_wcids` | ≥ 3,500 |
| `kl_token_to_retail` | ≤ 0.5 nats |
| `ace_emit_frac` | ∈ [0.56, 0.66] |
| `top5_wcid_acc` | ≥ 0.70 |
| `overfit_gap` (val − train total) | ≤ 1.0 |
| `pos` val MSE | ≤ 0.0015 (no regression from v4) |
| `rot` val MSE | ≤ 0.005 (no regression from v4) |

Plus a manual smoke check via `compare_world_to_retail.py` on a known
populated region (Holtburg + neighbors): the comparator's
"long-tail loss" and "wcid in wrong context" signals must trend down
versus v4's output on the same region.

## Style notes

- Match the verbosity and tone of `train_scene_placer.py`'s existing
  comments: short, blunt, specific numbers, *Why:* lines for non-obvious
  choices.
- Per-class-space weights are a tensor multiply at the loss site — keep
  it that way. Don't refactor the loss function for v5.
- The CLI flag conventions (`--focal-gamma`, `--ace-abstract-weight`)
  carry across the whole pipeline; preserve them. New flags can be
  added; existing ones must keep their semantics.
- No emoji in code or generated files.

## Recommended phasing

- **Phase 0** — diagnostic. Read `training_history.json` for v3 + v4;
  write and run `diagnose_v4.py`. Output a short markdown report saying
  "the bias is X, the diversity gap is Y, here's what's likely to
  work." Do not commit until reviewed.
- **Phase 1** — sampling-side temperature investigation. Patch
  `generate_populated_world.py` to expose a class-space temperature
  knob. Run `compare_world_to_retail.py` against the v4 checkpoint
  with `τ ∈ [1, 1.5, 2, 3]`. If KL drops sufficiently *without
  retraining*, ship τ-on-class-space and stop.
- **Phase 2** — reweighting sweep (only if Phase 1 didn't close the
  gap). Best run wins; train to convergence.
- **Phase 3** — architectural escape (two-headed output). Only if
  Phase 2 capped below the acceptance bar.

Each phase is reviewable in isolation. Phase 0 is mandatory; Phases 1-3
are conditional on prior results.

---

Two notes on using this prompt:

- The agent must read `2026-04-27_pipeline_theory_overview.md` and the
  April 27 note's "section 4: the class-imbalance trap" before drafting
  any plan. That section is the prior art that explains why the obvious
  "just resume training" answer is wrong.
- The headline metric is *per-token KL to retail*, not val loss. Any
  decision the agent makes that sacrifices KL to improve val loss is
  going the wrong direction. If the agent's plan reads as "tune val
  loss down," redirect them to the calibration framing.
