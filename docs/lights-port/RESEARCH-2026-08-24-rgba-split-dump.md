# RESEARCH 2026-08-24 — splitting the RGBA CPU-mirror population in the Yaraq dump

Continues: `HANDOFF-2026-08-24-rgba-mirror-diet.md` (the finding this answers),
`ANALYSIS-2026-08-23-familyB-yaraq-dump.md` (fragmentation verdict).
Dump: `/mnt/wbterminal2/crashdump-12356/acclient.exe.12356.dmp` (Yaraq crash, 2026-08-23).
Scripts (this session's scratchpad, `/tmp/claude-1000/-home-wbterminal/9c6dd5b7-…/scratchpad/`):
`rgba_split.py` (region census), `rgba_runs.py` (page-granularity run extraction — the
authoritative numbers), `rgba_eyeball.py` (duplicate hashing + PNG rendering),
`rgba_montage.py` (per-class contact sheets + arena headers), plus inline mip-partner and
stride tests. Contact sheets in `…/scratchpad/montage/`, samples in `…/scratchpad/shots/`.

Mid-flight input from the decomp forks (folded in below): world textures are created in
**D3DPOOL_DEFAULT** — there is **no D3DPOOL_MANAGED population**; the retained CPU hog per
texture is `ImgTex::m_pSystemMemTexture` (+276), a pinned D3DPOOL_SYSTEMMEM texture the
D3D runtime allocates (`m_AllowManagement=0`, acclient.c:366146); retail already frees the
client staging buffer post-upload (`PurgeResource()`, :366173); plus a never-freed
`temp_buffer_table` keyed (format,size) (:367485).

## Method

1. Coalesce adjacent committed-private MemoryInfo entries; classify EVERY 4KB page by
   alpha-byte test (`buf[3::4] == 0xFF` fraction ≥ 0.97); extract maximal page runs.
   Run lengths are true buffer sizes regardless of heap topology (`rgba_runs.py`).
2. Identify buffer dimensions from run sizes; verify width by stride test at full
   resolution (stride 1024 coherent, stride 512 interlaced → buffers really are
   1024-wide where claimed).
3. Render every run into per-size-class contact sheets and CLASSIFY BY LOOKING AT THEM
   (pixels are unambiguous: terrain merges vs hair/clothing/armor vs sky).
4. Duplicate detection: md5 over two 64KB probes per run.
5. Mip-chain detection: (a) adjacency of quarter-size runs, (b) cross-run image-signature
   match of each large run against a 4× downscale (16×16 RGB grid, L2).

## Headline numbers

- Coalesced committed-private ≥1MiB: **403 regions, 1,212 MiB**.
- True RGBA-opaque page content inside them: **568 MiB**; in runs ≥256KB: **556 MiB in
  352 runs**.
- ⚠ Census reconciliation: the handoff's "1,008 MiB in 412 regions" attributed WHOLE
  regions that passed a 3-point 16KB sample. Rerunning that method on per-entry regions
  gives 612 MiB/249 regions; page-truth is 568 MiB. The prior number over-attributes
  mixed regions (non-RGBA tails counted as RGBA) and its region totals (1,496 MiB) also
  don't reproduce (1,212 MiB here). The hog is real but it is **~570 MiB, not ~1 GiB**;
  the remaining ~650 MiB of committed-private ≥1MiB is other content (mostly-zero heap
  slack, mixed heap, non-opaque pixel data was not measured).

## Run-size histogram (top classes, of 556 MiB)

| run size | count | total | dimensions | content (contact sheets) |
|---|---|---|---|---|
| 4.00 MB | 51 | 204 MB | 1024×1024 | ~31 terrain merges (~124 MB), ~20 r9-upscaled object art — hair/creature (~80 MB) |
| 1.99 MB | 56 | 112 MB | 1024×512 | terrain merges, essentially all 56 |
| ~1.00 MB | 136 | 136 MB | 512×512 | ~104 clothing/armor/skin/face/dungeon-stone (~104 MB), ~22 pale near-uniform (~22 MB), ~10 terrain (~10 MB) |
| 7.91 MB | 2 | 15.8 MB | 1024×~2025 | identical pair; pale sky-gradient with cloud strip |
| 0.25–0.50 MB | 42 | 16 MB | 256²/512×256 | object/clothing art |
| other | 65 | ~73 MB | concatenated smaller buffers | mostly clothing/trim strips, some pale/terrain |

## The split (population attribution)

| population | MB | share | confidence |
|---|---|---|---|
| (a) TexMerge merged-terrain outputs | **~250 MB** | ~45% | HIGH — terrain-merge content (base tile + road/beach/rock overlay blends) is visually unmistakable; Yaraq desert palette throughout |
| (b) object/clothing/creature textures (incl. INDEX16→RGBA palette variants, r9-upscaled art) | **~240 MB** | ~43% | HIGH — armor plates, robes, hair, faces, dungeon stone |
| (c) sky/near-uniform | **~40 MB** | ~7% | MEDIUM — pale gradients + cloud strips; plausibly SkyDesc cloud/gradient textures |
| unclassified remainder | ~25 MB | ~5% | — |

There is **no separate "managed-pool mirror" population** — consistent with the decomp
finding (DEFAULT pool, no D3DPOOL_MANAGED). What the dump sees is ONE CPU-resident copy
per texture, and the structural findings below say which mechanism holds it.

## Structural findings

1. **Single-level, no mip chains.** Mip-partner match: 2/51 for the 4MB class, 0/56 for
   2MB, 0/136 for 1MB; only 11 adjacent quarter-size run pairs in the whole set. The
   retained CPU copies are 1-level images — the `m_pSystemMemTexture` textures are being
   created with 1 level here (AC DAT textures carry no mip chains), so budget math is
   w×h×4 flat, NOT ×4/3. No mip-chain-size allocations exist anywhere in the RGBA set.
2. **All heap-embedded.** Zero RGBA runs are standalone VirtualAllocs; every one lives
   inside multi-region reserved arenas whose base carries the NT heap segment signature
   (`FFEEFFEE` at +8) — consistent with the D3D9 runtime allocating SYSTEMMEM surface
   memory from its own growable NT heap. This is also why family B presents as
   FRAGMENTATION: 1–4MB buffers churn inside shared heap segments instead of returning
   whole regions to the OS.
3. **76.8 MB is byte-identical duplicate copies** (38 groups; hash over two 64KB probes).
   Star exhibit: TEN identical copies of one 2MB desert-transition merge (0x54734000,
   0x5C05D000, …) — TexMerge re-merges the same pcode composition per land cell and each
   cell keeps its own copy + its own sysmem mirror. No dedup anywhere.
4. **The 2MB terrain class is 1024×512** (stride-verified), i.e. half-height merges exist
   alongside 1024² ones; both are r9-inflated (retail-era merges would be 256²/512²).
5. The handoff's "TexMerge::tex_data static 16MB temp" was NOT found as a distinct 16MB
   RGBA run (the 15.75MB REGION from the coarse census decomposed into smaller runs of
   other content); the static temp either wasn't RGBA-opaque at crash time or is among
   the mixed regions. The `temp_buffer_table` population likewise did not show up as
   16MB-class RGBA runs — if present it is holding non-opaque or non-RGBA content.

## What this means for the fix

- The zero-quality-loss lever is confirmed and quantified: **~490 MB of the ~556 MB is
  regenerable texture pixel data** (terrain merges re-merge via `bNeedReloadTextures`;
  clothing/object RGBA re-expands from DAT + palette). Killing the pinned SYSTEMMEM copy
  (`m_pSystemMemTexture`) for these classes attacks (a)+(b) at once.
- Priority by mass: terrain merges (~250 MB, and the duplicate factor means towns are
  quadratically punished) ≥ clothing/object (~240 MB, palette-variant explosion) ≫ sky.
- The palette-recolor exemption (Palette::Modify re-reads source bits) applies to the
  INDEX16 SOURCE buffers, not to these RGBA expansions — the expansions in the dump are
  the post-recolor OUTPUTS; freeing their sysmem copies after upload does not break
  future recolors (those re-read the INDEX16 source, which is DAT-cached).
- Since everything sits in NT heap segments, freeing these buffers also directly repairs
  the largest-free-block canary only if whole segments empty — expect committed-private
  to fall ~500 MB but low-VA contiguity to improve more slowly; the governor's
  crit-hold should become rare either way.
