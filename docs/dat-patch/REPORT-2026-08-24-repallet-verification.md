# REPORT 2026-08-24 — INDEX16 repallet verification: the upscale is REAL

Owner concern: reviewers of the creature/player repallet screenshots reported "no
visible difference", with no way to know whether the repallet silently no-opped.

## Method (data-level, no eyeballs needed)

Sampled record `0x06005747` (RenderSurface, PFID_INDEX16, defaultPaletteId
0x0400007E) from BOTH retail `~/ac_base_dats/client_portal.dat` and the shipping
`/mnt/wbterminal2/fill-2026-08-20/r9/client_highres.r10work.dat` via
`chorizite-parse-dat-record`, decoded both index maps through the shared palette.

## Findings

1. **The highres record is a genuine 2× upscale with NEW content** — 256²→512², same
   palette id, and only **3.8%** of downsampled indices match retail / **10.5%** of 2×2
   blocks are pure replication. This is the Remacri-upscale→requantize-to-own-palette
   path (highres_lane.py), NOT a nearest-replication no-op.
2. **Visibly sharper at close range**: decoded crops (archived at
   `/mnt/wbterminal2/crashdump-12356/analysis-0824/repal_crop_*.png`) show crisply
   resolved scrollwork/rivets vs blurry retail. RGB mean abs diff vs nearest-2×-retail
   = 18.65.
3. **Why reviewers saw "no difference": distance + mips.** At gameplay range the mip
   chain samples the texture back to ≤retail resolution — a 2× texel bump is only
   visible in close-ups. The screenshots were presumably not close-ups. This is
   expected behavior, not a failed patch.
4. QA note: the upscaler amplified white speckle in dark regions of this record
   (sharpening halos). Worth one in-client close-range pass on a dark-textured
   creature before calling the whole tranche clean.

## Recommended eye-test protocol for palette content

Close-range shots only (camera zoomed to fill the frame with the creature), A/B
retail-dat vs shipping-dat client, same pose (spawn + @attackable off). Distance
shots CANNOT distinguish a 2× texel upscale and will always read "no difference".
