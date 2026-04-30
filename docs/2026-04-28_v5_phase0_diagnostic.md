# V5 Phase 0 Diagnostic — `unified_v4_clean_ctx_20260427T2315Z`

Date: 2026-04-28. Draft — do not commit until reviewed.

Source data: `pipeline_data/models/logs/unified_v4_clean_ctx_20260427T2315Z/diagnose_v4.json` (full numbers) + `diagnose_v4.log`. Script: `scripts/PopulationPipeline/OutdoorML/diagnose_v4.py`. Region-mode val split, seed 42, 34354 sequences / 412730 positions, 141 s wall-clock on the L4.

## TL;DR

The prompt's framing of the v4 failure (ACE-emit calibration drift, top-K-but-not-top-1 wins, "two-headed output likely needed") **is not what the data shows**. The class-space gate is essentially perfect, the headline `ace_emit_frac` "miss" was a measurement artifact, and the long-tail diversity gap is **bounded by retail data sparsity, not model capacity**. The acceptance bar of `unique_wcids ≥ 3500` may be structurally unreachable on this dataset.

The real failure mode is narrower than the prompt assumed: **the long tail of rare DAT (model_id) tokens has insufficient training signal**. V5 should target intra-DAT calibration with sqrt-inverse-frequency weighting + higher label smoothing, and re-examine the acceptance bar against retail-support reality.

## Findings

### 1. The class-space gate is already correct (Phase 3 unnecessary)

Top-1 confusion matrix at the ACE / DAT / SPECIAL granularity is essentially diagonal:

| label   | pred=SPC | pred=ACE | pred=DAT |
|---------|---------:|---------:|---------:|
| SPECIAL |   0.9998 |   0.0002 |   0.0000 |
| ACE     |   0.0000 |   1.0000 |   0.0000 |
| DAT     |   0.0000 |   0.0002 |   0.9998 |

The model never confuses class spaces. The "two-headed (gate × within-class softmax)" architectural fix proposed in the prompt would be a no-op — there is no gate to learn that hasn't already been learned. **Skip Phase 3.**

### 2. The `ace_emit_frac = 0.577` "calibration miss" is an apples-to-oranges measurement

The trainer's `ace_emit_frac` is `count(ACE preds) / count(all preds, including STOP)`. Retail's "61.3% ACE / 38.7% DAT" excludes STOP. Apples-to-apples:

|                                  | retail | model |
|----------------------------------|-------:|------:|
| ACE / (ACE+DAT)  (ex-specials)   |  0.613 | **0.6297** |
| ACE / (ACE+DAT+SPECIAL)          |  0.564 | 0.5771 |

The model is calibrated correctly — actually slightly *over* the ACE target by +1.7pp, not under by 4pp. **Don't change `--ace-abstract-weight`; the existing 10.0 from v3+v4 is right.** The prompt's planned reweighting sweep over `[5, 8, 10, 12, 15, 20, 25]` is solving a non-problem.

### 3. Top-K accuracy doesn't show "right token in candidate set" — Phase 1 won't work

| class space | top-1 | top-5 | top-10 |
|-------------|------:|------:|-------:|
| ACE         | 0.999 | 0.999 | 0.999  |
| DAT         | 0.828 | 0.860 | 0.885  |
| SPECIAL     | 1.000 | 1.000 | 1.000  |

DAT top-5 buys only +3.2pp over top-1, top-10 only +5.7pp. The hypothesis "top-5 ACE accuracy is high but top-1 fails because adjacent DAT tokens win the tie-break" is contradicted on both halves: ACE top-1 is already 99.9%, and the under-emitted DAT tokens are not in the top-K either. **Sampling-side temperature on the class space cannot recover diversity — the suppressed tokens have logits buried far below top-10. Skip Phase 1.**

### 4. The diversity gap is concentrated in the DAT long tail, and it's data-bound

Per-token retail support over the 2.85M training labels:

| class | total vocab | with 0 occ | 1-9 | 10-49 | 50-499 | 500+ |
|-------|-----------:|-----------:|----:|------:|-------:|-----:|
| DAT   |       4474 |          0 |1716 |  1201 |   1185 |  372 |
| ACE   |        108 |         10 |  *— see note* |  *—* |     24 |   38 |
| total |       4582 |         10 |  ~1750 |  ~1240 |   1209 |  410 |

(ACE 1-49 = 36 tokens.)

**Tokens with ≥ 50 training occurrences: 1621. With ≥ 20: 2226.** v4 currently emits **1560 unique tokens on val greedy**, almost exactly at the 1621 well-supported ceiling. To clear the 3500 acceptance bar the model would need to learn from tokens retail itself shows fewer than 10 times each. That's a data ceiling, not a training ceiling.

**Recommendation: re-discuss the acceptance bar.** A plausible re-cast:
- `unique_wcids ≥ 2200` (≈ all tokens with ≥ 20 train occurrences)
- `kl_retail_to_model ≤ 0.5 nats` (current: 0.99) — still the right metric, achievable
- The "long tail recall" framing should weight by retail mass, not raw vocab count.

### 5. Per-scene_kind: outdoor and interior are individually well-calibrated

| scene_kind            | positions | top-1 | ace_emit | label_ace | unique |
|-----------------------|----------:|------:|---------:|----------:|-------:|
| outdoor               |    264954 | 0.977 |    0.726 |     0.726 |    767 |
| interior_anchored     |     41562 | 0.888 |    0.555 |     0.555 |    400 |
| interior_unanchored   |    106214 | 0.874 |    0.215 |     0.215 |   1032 |

For each scene_kind, the model's `ace_emit_frac` matches the label distribution to ≤ 0.001. The class-space mix is conditional-on-context-correct, not just marginally correct. The diversity loss is on DAT and is heaviest where DAT is heaviest (interior_unanchored has 78% DAT labels and only 1032 unique preds out of ~3000 supported DAT tokens with non-trivial mass).

### 6. KL is 0.99 nats — twice the bar, dominated by under-emission of mid-frequency DAT

`KL(retail || model)` over the full vocab = **0.9951 nats** (acceptance: ≤ 0.5). `KL(model || retail)` = 0.1942 (model rarely emits anything retail doesn't). Asymmetry says the same thing the unique_wcids count says: the model under-emits, doesn't hallucinate.

The 20 most-emitted tokens look healthy (emit_ratio mostly in [0.8, 1.5]) — except one notable outlier:

- `idx 446` (`model_id 16780780`): pred 0.99% / train 0.021% → **48.2× over-emission**. Vacuum-sucker attractor where probability mass from rare DAT siblings is falling onto one popular alternative. There are likely a handful more like it; if reweighting fixes the long tail, these should self-correct.

The 20 most-under-emitted tokens are all DAT with train_frac in 0.001%-0.003% range (i.e. < ~80 training occurrences each).

## Recommendations for V5

### What to do (in order)

1. **Drop Phase 1 (sampling-side τ-on-class-space).** The hypothesis behind it (top-K-but-not-top-1) didn't hold up. No amount of cross-class temperature recovers the suppressed long-tail DAT tokens.

2. **Drop Phase 3 (two-headed output / gate × within-class softmax).** The gate is already perfect.

3. **Reframe Phase 2.** Instead of an `--ace-abstract-weight` sweep:
   - Add **sqrt-inverse-frequency intra-class weights** within DAT only. Token weight = `clip(sqrt(median_dat_freq / token_dat_freq), 0.5, 5.0)`. Don't touch ACE — it's already well-calibrated.
   - Sweep **`label_smoothing`** over `[0.2, 0.3, 0.4]`. Higher smoothing pushes mass onto rare tokens during gradient updates and is the cheapest move.
   - Drop **`--focal-gamma 2.0`** (or keep at 0). With top-1 already at 99.9% on ACE and 82.8% on DAT, focal-loss gradient down-weighting on confident predictions buys nothing on the failure mode (rare DAT tokens) — those positions are by definition unconfident already.
   - Keep the v3 `--ace-abstract-weight 10.0`. Don't sweep it; the data says it's right.

4. **Add a third loss term** (small, λ ≈ 0.02): `KL(model_token_marginal || retail_marginal)` computed once per batch. This is the "anti-collapse" term from the prompt — directly punishes the headline failure. Cheap; orthogonal to the per-token weights.

5. **Replace the val harness with the diagnose_v4 metrics** (already wired up — see `compute_diversity_metrics`). Add to `training_history.json`:
   - `kl_retail_to_model` (full and ex-specials)
   - `top5_wcid_acc` (overall + per-class-space)
   - `unique_pred / supported` (long-tail recall, not raw fraction)
   - `ace_emit_frac_ex_specials` (the apples-to-apples version of the existing `ace_emit_frac`)

6. **Acceptance bar discussion** (open question, not a code change):
   - Is `unique_wcids ≥ 3500` worth chasing if it requires learning tokens retail shows < 10 times? My read: no — the comparator (`compare_world_to_retail.py`) penalty on those tokens is small because retail itself barely uses them.
   - Suggest revising to: `unique_wcids ≥ 2200`, `kl_retail_to_model ≤ 0.5`, and *adding* `mass_weighted_recall ≥ 0.95` (= fraction of retail probability mass covered by emitted tokens). That last one is the metric that actually tracks "the world feels like retail."

### What not to do

- Resume v4 — confirmed pointless (LR floor, gap stuck at 2.1, basin wrong).
- Sweep `--ace-abstract-weight`. Already calibrated to within 1.7pp.
- Add a two-headed output / mixture of experts. The gate is solved.
- Chase `unique_wcids = 3500`. The data ceiling is ~2200-2500.

## Open questions

- Why does v4 (val_total ≈ 6.0) have a 2.1 train/val gap when v3 (val_total ≈ 2.6) had ~0.8? My read: v4's "clean_ctx" likely changed scaling or normalization of the context features, and the val_total absolute number isn't comparable across the two runs. The class weighting interacts with the loss measurement non-trivially — comparing val_totals across class-weight regimes is exactly the warning the prompt itself flags. The metric to compare is per-token KL, and on that v4 ≈ 0.99 isn't necessarily worse than v3 (we'd need to run diagnose_v3 to know).
- Should we run the same diagnostic against v3_best to confirm the v4-vs-v3 picture? It's another 3 min on the L4 and would settle whether the v4 plateau is a regression or a parallel basin.

## Files changed

- `scripts/PopulationPipeline/OutdoorML/diagnose_v4.py` (new, ~480 lines, read-only diagnostic)
- `pipeline_data/models/logs/unified_v4_clean_ctx_20260427T2315Z/diagnose_v4.json` (new, full numbers)
- `pipeline_data/models/logs/unified_v4_clean_ctx_20260427T2315Z/diagnose_v4.log` (new, console capture)
- `docs/2026-04-28_v5_phase0_diagnostic.md` (this file)

No code changes to the trainer or any production paths.
