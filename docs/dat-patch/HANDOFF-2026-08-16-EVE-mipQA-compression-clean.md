# HANDOFF — 2026-08-16 EVE: mip-cap-16 REJECTED, compression re-proven clean, dat-decompress SHIPPED

Continues HANDOFF-2026-08-16-PM-phase2-ready.md. Branch integ/all-20260813.

## What happened this session
1. **Followup #1 closed**: `release-r6-fixed.log` verified — fixed-r6 repackage
   landed clean (both dats CLEAN, tgz+sha at 17:32).
2. **Phase-2 step 1 DONE — `dat-decompress` promoted to the shipped set.**
   `patch_client.py` registry enabled=True; `acclient.eor.patched.exe` rebuilt
   from pristine = palette-leak ×2 + dat-decompress (md5 cb58167177e4…,
   checksum 0x004A19DA). Prior artifact kept as
   `acclient.eor.patched.pre-decompress-20260816.bak`.
3. **mip-cap-16 far-pan QA RUN AND FAILED — REJECTED.** 1070 A/B, only the
   clamp byte differing: with mip16 all large upscaled DXT world textures
   (dungeons, buildings, props) render WHITE at every distance. No crash.
   Full writeup: `docs/dat-patch/mip-cap-16-farpan-QA-2026-08-16.md`; frames
   `/mnt/wbterminal2/ac-eor-patch/mipqa/armA-nomip|armB-mip16/`. Registry keeps
   it enabled=False with the rejection recorded. **Phase-2 step 2's "TRUE 4x"
   no longer has the mip rider** — 4x + compression proceed; distance mips stay
   retail-capped (same tradeoff all shipped tiers already make). A proper fix
   needs RE of the ImgTex::CreateD3DTexture level-fill path (white surfaces =
   likely unfilled deeper chain), candidate for a later session.
4. **Compression evidence un-tainted**: gate-shot13's exe had included mip16, so
   compression was re-validated DECOMPRESS-ONLY (arm C): fresh DatCompress of
   the terrain-FIXED r6 portal (45% off texture bulk, realCorruption=0),
   full 5-stop tour crash-free **including Holtburg VeryHigh terrain**, frames
   pixel-equivalent to the uncompressed baseline (dungeon mean diff ~5 vs ~110
   for mip16). Artifacts: `portal-r6fixed-compressed.dat` (laptop ac-eor-patch/
   + box `D:\ac-dat-test\client_portal.dat.r6-compressed-bak`).
5. **Followup #5 progressed**: DRW `Decompress` under-read fixed in the vendored
   sparse checkout (local commit `7436a17`, NOT pushed) + ready-to-post PR body
   in `docs/dat-patch/upstream-drw-decompress-fix.md`. Posting the upstream
   PR/issue = owner action (needs a fork; not done autonomously).
6. **1070 kit restored**: stock exe + terrain-fixed uncompressed r6 active;
   ops learnings (idle-guard self-reset, 25s account gap, y=230 slot) added to
   `1070-acclient-driving.md`. Box saw zero user activity all evening.

## Owner decisions now teed up
- **Merge to master**: r6 gate passed + repackage clean → only final sign-off
  gates the ff-merge (MERGE-STATUS.md has the commands).
- **Phase-2 step 2 scope**: proceed with 4x-everywhere + texture-only
  compression WITHOUT the mip patch (recommended — it's the same mip tradeoff
  every shipped tier makes), or first invest in RE'ing the texture fill path
  to make deep mip chains real.
- Ship vehicle for the patched client: `acclient.eor.patched.exe` is the
  shipped artifact; distribution packaging untouched this session.

## Still open (unchanged from PM handoff)
- Buildbox `batch4-in` (16 scenery textures) upscale + wrap-padded corpus
  re-upscale — both wait on the next buildbox session (also needed for the
  true-4x re-encode corpus).
- Full-frequency dungeon relief rebuild (area-based budget) once the 4x tier
  plan is settled; judge under a torch-model rig, not the daylight board.
- r5-relief ON vs OFF A/B at VeryHigh (geometry-artist flag) — needs a
  no-relief dat set baked; not attempted this session.
