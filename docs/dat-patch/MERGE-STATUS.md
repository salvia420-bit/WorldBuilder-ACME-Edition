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
