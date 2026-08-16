# mip-cap-16 far-pan QA — REJECTED (2026-08-16 evening)

The phase-2 plan's step-1 rider ("decide mip-cap-16 separately after far-pan
QA") is decided: **mip-cap-16 fails QA catastrophically and must not ship.**

## The A/B (1070, terrain-fixed r6 dats, VeryHigh / 1920×1080)

Two box-build exes differing ONLY in the mip-cap byte (verified per-patch by
`patch_client.py verify`):

- **Arm A** `acclient.box-NOMIP-TEST.exe` = palette-leak ×2 + dat-decompress
- **Arm B** `acclient.box-PHASE2-TEST.exe` = the same + mip-cap-16

Same kit, same INI, same account/char, same 5-stop `acdtshots` tour
(Holtburg, Alabree, Yaraq, Braid, Muggy Guruk). Frames:
`/mnt/wbterminal2/ac-eor-patch/mipqa/armA-nomip/` vs `armB-mip16/`.

## Result

- **Arm A: clean** — everything textured, matches the 17:14 r6 gate.
- **Arm B: every large upscaled DXT world texture is WHITE/untextured at ALL
  distances** — dungeon walls+floors in all three dungeons, Holtburg building
  walls, props (barrel, portal-backing quad). What survives on those surfaces
  is only the detail-texture noise + vertex lighting (magenta/cyan light bleed
  visible in Muggy Guruk). Characters, clothing, UI, particles, and the
  terrain composite (MergeTexture path) are unaffected. No crash.

So this is not the hoped-for "full mip chain, less shimmer" — the clamp byte
alone breaks texture creation/fill for the big textures. Working hypothesis:
the fill path only ever populates the retail 4-level chain, so the deeper
chain the raised clamp requests comes up empty; the diffuse stage then samples
blank levels. A real fix needs its own RE of `ImgTex::CreateD3DTexture`'s
level-fill loop. Until then the registry keeps `mip-cap-16` enabled=False with
the rejection recorded.

## Fallout 1: gate-shot13 compression evidence is tainted

The 16:12 "compression validated in-client" run used the PHASE2 exe — which
included mip-cap-16 — and its one frame (`gate-shot13.png`) is a degenerate
close-up (camera inside geometry, heavy blur) that can't prove texture
correctness either way. The DECOMPRESS-ONLY re-validation is being run with
arm A's exe + a freshly compressed terrain-FIXED r6 portal (DatCompress
--verify, realCorruption=0) against the same tour, judged against arm A's
uncompressed frames. Result recorded below when done.

## Fallout 2: phase-2 step 2 ("TRUE 4x") loses its mip rider

Without mip-cap-16, a 2048² texture's smallest mip stays 256² — 4x-everywhere
still works and still looks right at near/mid range, but distance shimmer on
upscaled art remains (the same tradeoff every shipped tier already makes).
The "mip-cap patch makes 4x correct" line in the phase-2 plan is void; 4x
re-encode + compression can proceed regardless, and a properly-RE'd mip fix
can land later as a pure quality patch.

## RESULT OF THE DECOMPRESS-ONLY RE-VALIDATION — CLEAN (same evening)

**Arm C**: NOMIP exe (leak ×2 + dat-decompress, NO mip16) + a freshly
DatCompress'd **terrain-FIXED** r6 portal (20,662 records compressed,
1290.7→708.6 MiB texture bulk = 45% off, realCorruption=0), same 5-stop tour:

- Entered world, **zero crashes including Holtburg outdoor at VeryHigh**
  (terrain MergeTexture path exercised over compressed textures).
- Frames visually identical to arm A (uncompressed baseline). Mean |pixel
  diff| vs arm A on the deterministic dungeon stops: alabree 5.2, braid 5.5
  (pose drift only) — versus 108.7 / 117.2 for the mip16 arm. Outdoor stops
  13.9–23.5, all sky/time-of-day + pose drift.
- Frames: `/mnt/wbterminal2/ac-eor-patch/mipqa/armC-decompress/`; the
  compressed fixed portal is kept at
  `/mnt/wbterminal2/ac-eor-patch/portal-r6fixed-compressed.dat` and on the box
  as `D:\ac-dat-test\client_portal.dat.r6-compressed-bak`.

**The `dat-decompress` patch is therefore validated on its own, untainted** —
the earlier gate-shot13 concern is closed. The shipped EoR patch set
(palette-leak ×2 + dat-decompress) stands.
