# dat-patch — branch & merge status (keep current; the "don't forget" doc)

## Where the work lives
**All** ACME dat-patch work is on ONE branch: **`integ/all-20260813`**.
As of 2026-08-16 it is **42 commits ahead of `origin/master`, ZERO divergence**
→ a clean `git merge --ff-only`. Pushed to origin (backed up).

The other branches — `integ/lanes-20260814`, `lane/oracle-20260814`,
`lane/portal-gate-20260814`, `lane/portal-pass2-20260814`, the `parity-*`
set — are all **0 commits ahead of master**. Nothing unique is stranded on
them; they are stale/absorbed. Ignore them for the merge.

## Merge is OWED (deferred by owner: "when it makes sense, after the agents")
Do NOT merge to master until the tail of this branch passes its **1070
in-client gate**. Everything through r5 is gated; the pending-proof part is:
- commit `1ee63103` — the Opus-artist audit fixes (dead `normal_gain`,
  texture alpha/tileability/anchor/dither, pallib color-bleed, C# BestQuality)
  — **tooling-validated only**.
- the **r6 scenery tier** (dat-patch-scenery/) — built with those fixes,
  gate pending.

## The merge, once the gate is green
```
git rev-list --left-right --count origin/master...integ/all-20260813   # expect "0 N"
git checkout master
git merge --ff-only integ/all-20260813
git push origin master
```

## 1070 GATE 2026-08-16 — compression PROVEN, r6 has a content bug (both block the merge differently)
- **Compression patch VALIDATED in-client**: the patched box client loaded a
  fully-compressed r6 portal (45% texture saving), rendered decompressed
  textures at 1920x1080, authed + entered world. dat-decompress (NOP je @ box
  file 0x17878) works end-to-end. Phase-2 headroom is real. Resolution +
  VeryHigh detail also confirmed live. (ac-eor-patch/COMPRESSION-PATCH-FINDINGS.md)
- **r6 scenery tier FAILS the gate**: crashes the retail client on Holtburg
  load — access violation at RVA 0x13EA26 (ImgTex::CopyIntoData, the
  palettized/clipmap upload path). Isolated: reproduces on STOCK client +
  UNCOMPRESSED r6, so it's an r6 audit-fix REBAKE bug, not compression/patches.
  r6 is NOT shippable until fixed; bisect the texture_lane audit fixes.
  (dat-patch-scenery/GATE-STATUS.md)
- **Merge status unchanged**: still gated. The audit-fix commits (1ee63103) +
  r6 need the CopyIntoData bug fixed and re-gated before master. Everything
  ELSE on integ/all-20260813 (through r5, shipped+gated) remains FF-clean.

## Tier ladder (rollback order, newest last)
remacri → terrain → doors → props → dungeons → r4 creatures+envgeo →
r5 env-variants (GATED, shipped) → **r6 scenery (gate pending)**.
Packages r1–r5 exist per-lane via `release.sh`. ACE + 1070 kit run r5.

## Related open threads (so they don't get lost either)
- **Phase-2 exe patches** — compression patch DERIVED + VERIFIED 2026-08-16
  (ac-eor-patch/: patch_client.py harness, COMPRESSION-PATCH-FINDINGS.md).
  The pre-existing 6-NOP patch is notan's texture LEAK fix, not compression.
  trevis's DAT-decompression fix is now located by byte-signature: NOP the
  `je` at file 0x017B28 (VA 0x417B28) in `AsyncCache::SerializeFromCachePack`
  — the `m_iVersion != 0` guard that rejects decompressed records (Decompress
  zeroes m_iVersion; the GetCoreSDK stub is const-2 so only this test gates).
  `74 71 -> 90 90`, unique + disasm-confirmed in OUR exe. Registry key
  `dat-decompress` (enabled=False, candidate). Test exe built:
  `acclient.eor.compress-TEST.exe` (leak-fix + mip16 + decompress, checksum
  fixed). ~40-50% portal saving. STILL GATED: (a) build a DRW-compressed
  portal (texture 0x06 records only, so ACE's non-inflating loader is
  untouched); (b) 1070 load + real-client ROUND-TRIP byte-compare (paradox
  caveat: FIX A papers over the lost version — verify objects deserialize
  identically vs the uncompressed baseline before trusting the headroom).
- **Owner decision** teed up: full-frequency dungeon relief (area-based
  budget, ~+300 MiB) fits once phase-2 headroom lands — build toward 600 MiB,
  don't right-size textures twice.
- Buildbox `batch4-in` (16 scenery textures) waiting for the next upscale run.
- Wrap-padded corpus re-upscale owed (proper fix for the ESRGAN tileability
  break; edge cross-fade is only a stopgop in the bake).
