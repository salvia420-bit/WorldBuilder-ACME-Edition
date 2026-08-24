# REPORT 2026-08-25 — INDEX16 repallet re-verification against the FIXED r10 highres

Supersedes the conclusions of `REPORT-2026-08-24-repallet-verification.md`, which
unknowingly sampled the **corrupted** `client_highres.r10work.dat`: its probe record
`0x06005747` is one of the 3,414 records the INDEX16 repair
(`/mnt/wbterminal2/dat-patch-creature-fix/idx16_scan_fix.py`) rewrites — the old
report's "3.8% index match / 2× new content" finding **was the corruption signature**
(an RGBA-resample+requantize pass that invented indices), not evidence of a real
upscale.

## Method

Identical to the old report: record `0x06005747` (RenderSurface, PFID_INDEX16,
defaultPaletteId `0x0400007E`) sampled from retail `~/ac_base_dats/client_portal.dat`
and from the repaired `/mnt/wbterminal2/dat-patch-r10-highres/client_highres.r10.dat`
(and, for contrast, the corrupted `client_highres.r10work.dat`); index maps compared
at matching positions and per 2×2 block.

## Findings

| file | dims | palette | downsampled idx match | pure-replication 2×2 blocks | distinct indices (retail 904) |
|---|---|---|---|---|---|
| **fixed r10** (`client_highres.r10.dat`) | 512×512 | 0x0400007E | **100.0%** | **100.0%** | **904** |
| corrupted r10work | 512×512 | 0x0400007E | 3.8% | 0.3% | 415 |

1. **The repaired record is exact index-preserving 2× nearest replication of the
   retail record** — every retail palette row survives (904/904 distinct), every 2×2
   block is uniform, RGB delta vs nearest-2×-retail is exactly 0. This is the
   *intended* ship state for paletted content: the repair deliberately trades the
   (broken) requantized "upscale" for palette correctness, because ClothingTable
   subpalette recolors address palette **rows** — the requantize path collapsed
   904 → 415 rows here, which is what landed recolors on wrong rows in-game.
2. **The old report's numbers are fully explained**: 3.8% match / 0.3–10.5%
   replication / "new content" / the white-speckle QA note were all measurements of
   the corruption. Its distance-vs-mips reviewer guidance (§3) remains valid, but its
   headline ("the upscale is REAL") should not be quoted for INDEX16 content.
3. Scope: **all 4,335 paletted records** in the fixed r10 highres are now pure
   replication (3,414 repaired + 921 that already matched). Remacri-upscaled content
   ships exclusively in the non-paletted (DXT) records, where no palette semantics
   exist to corrupt.

## Verification context

The fixed file passed the full lane verify (`idx16_verify.py` port: readback
3414/3414, distinct-set == base 3414/3414, sentinel == base 3414/3414, dims/fmt/
palette unchanged 3414/3414; spotlight records restored to base metrics exactly),
plus census 9,085 records with the three 4.H2 detail textures byte-identical to
r10work, untouched-record sampling, and a full-file read walk. Full provenance:
`/mnt/wbterminal2/dat-patch-r10-highres/PROVENANCE.txt`.
