# Corpus repair — Remacri alpha-edge background contamination ("green fringe"), 2026-08-09

Owner-reported (redmi, from the E4 sheets + in-game): `0x06003789` (birch-class tree)
— source art hides a GREEN background under its binary alpha; the Remacri x4 output
shows a black background but green contamination on leaf edges. Same defect on
tropical/palm foliage. Orchestrator investigation, repair, and promotion; corpus work
lives at `/mnt/wbterminal2/reeng/texfix-2026-08-09/` (scan/repair/verdict JSONL,
scripts, originals backup).

## Mechanism (measured)

Retail alpha-tested art stores a colored background under transparency (0x06003789:
under-transparency RGB mean [67.5, 89.6, 43.9] = green; only 1 partial-alpha texel in
512² = binary mask). Remacri upscales straight (non-premultiplied) RGBA: the output
grew 1,530,723 partial-alpha texels (37% of 2048²) whose RGB mean equals the source
background — the upscaler smeared the hidden background into a wide soft-alpha band.
Alpha-tested in engine, band texels above the test threshold render with contaminated
RGB (colored fringes); at mip levels the dissolved alpha can pass the test across the
whole tile (worst cases render as a solid colored block at distance: the palm
`0x060037B3` = cyan slab, `0x060037BF` swamp root = mustard slab).

## Extent (full-corpus scan, 3,985 sources vs Remacri outputs — scan.jsonl)

- 3,349 textures have no binary transparency → unaffected.
- 636 alpha-edged textures affected to some degree; 217 severe / 82 moderate by a
  contamination score (band fraction × band-leans-bg fraction × bg/fg color
  separation). 22 have distinctly GREEN backgrounds (the owner-visible foliage class).
- Class split: 538 essentially-binary source alpha, 98 with partial-alpha content.
  Visual audit showed most "partial" ones are foliage with AA/dithered edges (the palm
  class included); true volume-gradient art (energy-sphere effect family, dithered pine
  canopies) is the only class the repair must not touch.

## Repair (repair_fringe.py; validated visually at texel/alpha-test/mip scales)

Per texture: output alpha = bicubic x4 of the SOURCE alpha (crisp, true-to-source
coverage — replaces the hallucinated band); output RGB = verbatim where the upscaler's
own alpha ≥ 0.85 (pure foreground), else the pyramid-filled (push-pull dilated) color
of the nearest stable foreground texel — so no texel anywhere carries background color,
and bilinear/mip sampling can never reconstruct it. Two rejected earlier designs are
recorded in the script header (inverse un-mixing amplifies noise into white speckle;
a low-confidence fill normalization bug did the same).

Verification gates per file (repair-verdicts.jsonl): v1 interior byte-verbatim where
upscaler alpha ≥ 0.85; v2 no bright-texel injection (≤ +2%+8); v4 alpha coverage
within 20% of source. A chroma-based "band leans bg" gate was measured and DROPPED as
confounded — for foliage the legitimate leaf color IS the background color's hue; the
construction (band RGB sourced only from stable foreground texels) plus visual audit
is the guarantee. Sample audit of the six worst metric-"regressions" confirmed all six
are large visual improvements.

## Promoted

- Repair set: binary + AA-edge classes (source partial-alpha fraction < 0.30),
  score > 0 → 595 candidates → **593 promoted** (2 rejected on the bright-injection
  gate: 0x06006992, 0x06007537 — glow-class art, joined the follow-up list).
- Promotion (promote_repairs.sh + q75_pass.sh): originals backed up → repaired PNGs
  into `upscale-corpus/out/<set>-remacri/` (canonical source) → lossless XUBC7
  re-encode into `xubc7-corpus/<set>-lossless/` (NOTE learned during promotion:
  `xu7-ingest/*.ktx2` are SYMLINKS into the lossless corpus, so the ingest updates
  with it — the first promote pass's per-file "FAIL" lines were a harmless
  cp-onto-its-own-symlink error AFTER the encode+mv had succeeded) → q75 re-encode
  into `xubc7-corpus-q75/<set>-q75/` → q75-corpus.sha256 rows refreshed post-encode.

## Propagation debts (recorded, NOT yet executed)

1. **Pack layer**: the deployed full-world packs embed PVW previews sliced at bake
   time — previews of repaired ids still carry the fringe. Re-bake packs against the
   fixed ingest (run-world-bake-2.sh; ~2.5 h verified) and re-deploy additively.
   Preview-tier prerequisite DISCHARGED 2026-08-09 ~23:20: bake priority read-verified
   pre>full>extra (pack_bake.rs:850-874); all 593 re-derived from the FIXED ingest via
   derive-pvw-xu7.mjs (593/593, 0 failed) and swapped in place — 511 tex-bc7-pre/pre
   entries replaced, 7 pvw-extra replaced, 75 added to pvw-extra (stale originals in
   texfix-2026-08-09/{pre,extra}-stale-backup/). The overnight bake slices clean.
2. **Dist full tier**: in-game full-res 0x06 records ship inside the dist shards —
   the shard texture layer needs a re-bake for the fix to reach the live client.
3. **E4 sheets**: 4 of the 36 taildropped sheets show affected ids
   (0x06003789, 0x0600387E, 0x060038BB, 0x06004573) — regenerate before redmi's eye
   pass, and note the q75 corpus bytes changed for 593 ids (B4a ratio to re-check:
   expected second-order).
4. **Follow-up class (NOT repaired)**: 21 volume-dither/gradient sources (tpFrac ≥
   0.30: dithered pine canopies incl. 0x0600387E, the 0x0600576x energy-effect family,
   3 of the top-scoring trees 0x06003A31/0x06003AB4/0x060046CF) + the 2 v2-rejects.
   These need an alpha-aware repair that preserves volume dither/gradients (e.g.
   nearest-neighbor alpha upscale + tight-radius dilation), owner-eye gated.
5. **Root cause for future upscales**: pre-bleed sources before ESRGAN-class upscaling
   (dilate foreground under the mask) or upscale premultiplied — record in the
   upscale-corpus BRIEF for the next tranche.
