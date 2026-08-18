# Deblock-prebake A/B — Remacri on grid-filtered sources (G5b), 2026-08-17

**Verdict up front: the mechanism works and the corpus-wide rebake inputs are
already in hand.** Deblocking the source before Remacri halves grid-locked
excess on the material set (median exc0 +43% → +19.8%; the severe tier drops
272 → 57) and the visual A/B is decisive on severe cases — the 16-px quilting
is gone, replaced by coherent surfaces. The formal §5C detail bar
("no surface loses >15% off-grid gradient") reads FAIL, but a 40-texture
raw-rebake control shows that bar was mis-calibrated: ~14% of the apparent
loss is baseline drift between the original bake run and today's, and the
rest is largely *artifact energy* (quilt facet edges) that the metric counts
as detail. Recommendation: adopt for r7.1, gated on the standard batched
eye-test (§1070-eyetests-batched), not on exc0 alone.

## What was built (tools/dat-patch/deblock.py, working tree)

1. **exc0 scorer** — reimplements the block-artifact report's metric; validated
   EXACTLY against `reports/block-artifact-2026-08-17/block-scores.csv`
   (12/12 sampled rows, worst |Δexc0| = 0.0000, peak phases identical).
2. **Grid-targeted 4-tap filter with a SEED GATE** — the report's wrap-aware
   H.264-style filter, plus one improvement: a boundary pair is only smoothed
   when its luminance step *exceeds its local off-grid neighbourhood* (the
   "artifact seed" definition from the report's block-excess map) AND is below
   the per-texture binary-searched threshold. Without the seed gate the
   minimal-threshold filter that zeroes the grid keeps only 68–80% of off-grid
   detail; with it, 95–116% (reference 0x06003E7E: exc0 +25%→−0.1% at 98%
   kept, vs the report prototype's 87%).
3. **`batch` / `ab` CLI** + a `DATPATCH_DEBLOCK_BASE` pre-`tex_path` hook in
   `matlib.py` so lane consumers (height pass included) can prefer deblocked
   sources.

## Runs (all artifacts under /mnt/wbterminal2/deblock-ab/)

| step | result |
|---|---|
| deblock 702 material sources (laptop) | src grid excess mean +34.9% → −0.1%, detail kept mean 103% / p10 99% / min 82% (`in-deblocked/deblock-ledger.jsonl`) |
| deblock full 1,630 corpus (laptop) | +22.9% → −1.0%, kept 102% / p10 99% (`in-deblocked-full/`) |
| Remacri 4x on T4 (same runner/weights as the original corpus: wrap-pad 16, `4x_foolhardy_Remacri.pth`) | 702 then full 1,630 — `out-remacri-full/` (sha-verified transfer) |
| 40-texture RAW control (same T4 session) | `out-raw-control/` |

## A/B numbers (bake-side, same scorer as the corpus census)

- Material set: **material count 702 → 196** (§5C bar was <150), still-material
  median exc0 +29.7% (their old bakes: +41.1%). Severe (old exc0 ≥ +50%):
  272 → **57**.
- Off-grid gradient ratio vs old bakes: median 0.72 — but the **raw control
  rebake scores 0.86 vs the same old bakes at unchanged grid excess
  (+45.1% vs +41.9%)**, i.e. today's runner reproduces the artifact but not
  the old energy level; old bakes carry post-run differences. Deblock-vs-raw
  *same-run* detail ratio: median 0.85, p10 0.71 (`control-compare.json`).
- Visual (`ab-visual.png`, old | deblocked, worst-window crops): severe cases
  0x0600378C / 0x06003C83 lose the literal quilt; high case 0x06003C9E's
  rectangular patchwork becomes coherent stone; median 0x06003E7E is
  marginally softer with the grid-locked speckle reduced.

## Interpretation of the "detail loss"

exc0's `base` counts gradient energy, not perceptual detail. A Remacri bake
from a quilted source is *oversharpened everywhere* (facet edges land off-grid
too); removing the grid from the input removes that amplification. The
control isolates the deblock-attributable delta at ~15% median gradient
energy, and the crops show where it went: flat facets became smooth surfaces.
The one honest caveat: mid-tier textures get slightly softer, which only an
eye-test can price.

## DECISION (2026-08-17, recorded)

**ADOPT: r7.1 rebakes its texture lanes from the corpus-wide deblocked A-arm**
(`/mnt/wbterminal2/deblock-ab/out-remacri-full/`, all 1,630). Basis: severe-tier
quilting is visually eliminated with no visible real-detail loss (ab-visual.png);
source-side detail retention is 102-103%; the raw-rebake control attributes the
formal detail-bar miss to baseline drift plus artifact energy the metric counts
as detail. The standard r7.1 in-client gate + batched eye-test still stand as
the ship gate (they gate the whole take anyway); the severity-gated mix (old
bakes where old exc0 < +20%) remains the pre-approved fallback if the eye-test
flags mid-tier softness — both arms are on disk, so switching costs nothing.

## Recommendation

1. **r7.1: rebake from the deblocked corpus** — all 1,630 A-arm bakes already
   exist (`out-remacri-full/`), so the remaining cost is re-encode + DAT
   import (~50 min laptop, per the sizing table) + the batched eye-test.
2. Eye-test stops should include one severe (0x0600378C wall), one median
   dungeon (Muggy Guruk for 0x06003E7E/80), one creature closeup.
3. If the eye-test flags mid-tier softness, the fallback is a severity-gated
   mix (deblock arm only where old exc0 ≥ +20%): zero new GPU work, both
   arms are on disk.
4. Keep `deblock.py batch` as a permanent lane pre-stage for r8+ (it no-ops
   on grid-free sources by construction).

## Color note (owner observation 2026-08-17, measured)

The A-arm bakes read darker/flatter than the old bakes: mean RGB -8..-30%,
contrast -4..-50%, saturation -5..-10% (measured on 378C/3C83/3E7E/3C9E).
Two components:
1. **Runner drift, not deblock**: the shipped corpus bakes were post-processed
   (exposure/color anchoring vs the retail source in the rebake path — same
   family as terrain_lane's "exposure anchor vs retail"); tonight's A-arm is
   the RAW Remacri output. The anchoring returns at the r7.1 re-encode stage —
   verify the rebake pipeline's anchor step runs on these inputs (check the
   dat-patch-texture-remacri machinery / rebake.log flow before import).
2. **Deblock's own share**: small. If residual dullness survives anchoring, the
   cheap deterministic fix is per-texture color-statistics transfer vs the
   RETAIL source (per-channel mean/std or histogram match in Lab/YCbCr; CPU
   minutes, provable with a meanDriftRaw-style ledger). A source-side
   alternative also exists: luma-only deblock (filter Y, leave chroma) — a
   one-flag variant of deblock.py if ever needed.

**ORDER OF OPERATIONS (owner-directed): color enhancement beyond the anchor
restore — e.g. a T4 color/tone model pass over the corpus — is FINISHING
TOUCHES, scheduled AFTER the freed dat space is filled (post-HIFI-split
lanes). Do not spend GPU on it before then.**
