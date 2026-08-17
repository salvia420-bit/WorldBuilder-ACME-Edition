# dat-patch — branch & merge status (keep current; the "don't forget" doc)

## ✅ MERGED TO MASTER 2026-08-16 ~22:00 (owner sign-off granted)
`git merge --ff-only integ/all-20260813` → master = `2de9401c`, pushed to
origin (master AND the integ branch). Everything below this line is the
historical record of how it got there. New work continues on
integ/all-20260813 (kept in lockstep with master via ff-merges).
**Next lane: r7 TRUE-4x rebake (green-lit same evening).**

## Where the work lives
**All** ACME dat-patch work is on ONE branch: **`integ/all-20260813`**.
As of 2026-08-16 it is **42 commits ahead of `origin/master`, ZERO divergence**
→ a clean `git merge --ff-only`. Pushed to origin (backed up).

The other branches — `integ/lanes-20260814`, `lane/oracle-20260814`,
`lane/portal-gate-20260814`, `lane/portal-pass2-20260814`, the `parity-*`
set — are all **0 commits ahead of master**. Nothing unique is stranded on
them; they are stale/absorbed. Ignore them for the merge.

## Merge is OWED (deferred by owner: "when it makes sense, after the agents")
**UPDATE 2026-08-16 PM: the r6 gate PASSED** (VeryHigh/1920x1080, full 5-stop
tour, zero crashes — dat-patch-scenery/GATE-STATUS.md) after the terrain
cross-lane collision was root-caused (dungeon lane had DXT/2048'd two shared
terrain base textures; `ImgTex::MergeTexture` overran) and fixed via
`DatRestore` in r5 AND r6, with `terrain_protected_rs.txt` now enforced by
texture_lane. The audit-fix commits (1ee63103) are validated in-client via the
gated r6 build. **Merge is now gated only on final owner sign-off.**

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
- **The gate crash is a TERRAIN VeryHigh bug, NOT r6/scenery** (corrected via
  fork bisect + disasm of our exe): fault RVA 0x13EA26 = ImgTex::**MergeTexture**
  (terrain alpha-compositor), not CopyIntoData (earlier id was a different-build
  map error). r6 touched only 340 scenery RS; every terrain input is
  byte-identical r5->r6; all 340 scenery records are well-formed DXT. None of
  the 8 audit fixes is implicated. Trigger = the INI: first-ever run at
  LandscapeDetailTextures=True/VeryHigh exercised a terrain-lane alpha path that
  was always VeryLow before. Tier-independent (r5+VeryHigh predicted to crash
  identically). The blocker is the TERRAIN lane (suspect: undersized alpha map
  upscaled at VeryHigh -> MergeTexture OOB read), separable from r6 and from the
  audit fixes. (dat-patch-scenery/GATE-STATUS.md)
- **Merge status unchanged**: still gated. The audit-fix commits (1ee63103) +
  r6 need the CopyIntoData bug fixed and re-gated before master. Everything
  ELSE on integ/all-20260813 (through r5, shipped+gated) remains FF-clean.

## Tier ladder (rollback order, newest last)
remacri → terrain → doors → props → dungeons → r4 creatures+envgeo →
r5 env-variants (terrain-FIXED) → **r6 scenery (terrain-FIXED, VeryHigh-GATED)**.
Packages r1–r6 exist per-lane via `release.sh` (fixed r6 repackaged 2026-08-16
17:32, `acme-dats-r6-scenery.tgz` + sha, both dats verified CLEAN).
ACE serves `dat-patch-scenery/ace-r6-dats/`; the 1070 kit runs terrain-fixed r6.

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
  fixed). ~40-50% portal saving. **GATE CLEARED 2026-08-16**: DatCompress'd r6
  portal (45% texture saving, realCorruption=0 inflate-identical) loaded,
  entered world, rendered correctly on the 1070 (gate-shot13.png).
  **`dat-decompress` PROMOTED TO SHIPPED 2026-08-16 PM**: registry
  enabled=True; `acclient.eor.patched.exe` rebuilt = palette-leak ×2 +
  dat-decompress (md5 cb58167..., checksum 0x004A19DA; prior artifact kept as
  `.pre-decompress-20260816.bak`). paradox caveat stands for NON-texture
  records only.
- **mip-cap-16 REJECTED by far-pan QA 2026-08-16 evening** — with the raised
  clamp, every large upscaled DXT world texture renders white/untextured at
  all distances (A/B evidence `mipqa/`; full writeup
  `docs/dat-patch/mip-cap-16-farpan-QA-2026-08-16.md`). Compression was
  re-validated decompress-ONLY the same evening (clean, crash-free, pixel-
  equivalent to uncompressed) so the shipped patch set is untainted. Phase-2
  step 2's "mip-cap makes 4x correct" rider is void — 4x re-encode +
  compression can proceed, distance mips stay retail-capped until the fill
  path gets its own RE.
- **Upstream DRW Decompress truncation bug** — fix staged (local commit
  `7436a17` in external/DatReaderWriter, NOT pushed) + ready-to-post PR body in
  `docs/dat-patch/upstream-drw-decompress-fix.md`. Until upstream ships it, DRW
  nuget consumers (WB.Terminal included) cannot reliably READ compressed
  records — use raw bytes + manual inflate (as DatCompress's verifier does).
- **Owner decision** teed up: full-frequency dungeon relief (area-based
  budget, ~+300 MiB) fits once phase-2 headroom lands — build toward 600 MiB,
  don't right-size textures twice.
- Buildbox `batch4-in` (16 scenery textures) waiting for the next upscale run.
- Wrap-padded corpus re-upscale owed (proper fix for the ESRGAN tileability
  break; edge cross-fade is only a stopgop in the bake).
