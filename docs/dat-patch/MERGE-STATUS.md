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
- **Phase-2 exe patches** — CORRECTED 2026-08-16 (see ac-eor-patch/PATCHES.md +
  PATCH-NOTES.md). The pre-existing 6-NOP patch is notan's texture LEAK fix,
  NOT DAT compression (my earlier note was an unverified assumption). Built:
  `acclient.eor.leakfix+mip16.exe` = leak fix + mip-cap 4→16 only. **The
  COMPRESSION patch does NOT exist yet** — trevis's fix is at
  AsyncCache::SerializeFromCachePack (RVA 0x16AC0), still to be located by
  byte-signature and derived. The ~40% headroom the phase-2 plan assumes is
  therefore UNPROVEN until that patch is found AND load-tested on the 1070.
- **Owner decision** teed up: full-frequency dungeon relief (area-based
  budget, ~+300 MiB) fits once phase-2 headroom lands — build toward 600 MiB,
  don't right-size textures twice.
- Buildbox `batch4-in` (16 scenery textures) waiting for the next upscale run.
- Wrap-padded corpus re-upscale owed (proper fix for the ESRGAN tileability
  break; edge cross-fade is only a stopgop in the bake).
