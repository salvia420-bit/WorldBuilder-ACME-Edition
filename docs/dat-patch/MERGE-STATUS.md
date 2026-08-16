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
- **Phase-2 exe patches** ready + documented: `/mnt/wbterminal2/ac-eor-patch/
  PATCH-NOTES.md` (`acclient.eor.compress+mip16.exe`, sha 38a7e4d2…) —
  DAT compression (~40%, texture-records-only so ACE's non-inflating loader
  is untouched) + mip-cap 4→16. Gating unknown for the "4× everywhere + full
  area-based dungeon relief" plan; prove it loads on the 1070 first.
- **Owner decision** teed up: full-frequency dungeon relief (area-based
  budget, ~+300 MiB) fits once phase-2 headroom lands — build toward 600 MiB,
  don't right-size textures twice.
- Buildbox `batch4-in` (16 scenery textures) waiting for the next upscale run.
- Wrap-padded corpus re-upscale owed (proper fix for the ESRGAN tileability
  break; edge cross-fade is only a stopgop in the bake).
