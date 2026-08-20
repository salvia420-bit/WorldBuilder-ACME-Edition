# Phase 4 fill — measured task list (2026-08-20)

Owner directive: fill the r8 runway this session, intelligently, per
PLAN-2026-08-18. Every number below is MEASURED, not guessed: sizes come from an
empirical model built on the 2,412 records we already ship (their retail source
format/dims -> their actual stored bytes in the r8 highres dat), applied to the
retail records we do not yet cover.

## Where the space is, and what it costs to fill

| | records | est. added bytes |
|---|---|---|
| retail 0x06 records total | 20,684 | — |
| covered by r8 today | 2,412 (11.7 %) | 597 MB shipped |
| **uncovered** | **18,193** | **969 MB to cover ALL of it** |

| tier | records | est MB | have a Remacri PNG already | need new GPU |
|---|---|---|---|---|
| **A — world surfaces ≥128²** (INDEX16 2,496 · R8G8B8 567 · DXT1 519 · A8R8G8B8 194) | 3,967 | **911** | 1,381 | 2,586 |
| B — mid 64² | 925 | 17 | 318 | 607 |
| C — icons/UI 32² (A8R8G8B8 12,488) | 12,933 | 41 | 100 | 12,833 |
| D — tiny <32² | 368 | 1 | 18 | 350 |

**The headline: tier A is the fill.** It is 94 % of the bytes, it is where the
plan's rank-#4 spend lives (2,496 INDEX16 = creature/monster/clothing surfaces,
the highest-exposure surfaces still at retail quality), and it lands the highres
dat at ~1.75 GiB of its 2.00 GiB ceiling. All four tiers = ~1.81 GiB, inside the
lane's 2.04 GB ceiling guard with ~100 MB of margin.

Second finding: **1,815 records already have a Remacri upscale on disk that was
never shipped** (`/mnt/wbterminal2/upscale-corpus/rewrap-out/out`, 4,041 PNGs vs
2,412 shipped). They are pre-deblock, so they get re-baked from deblocked inputs
rather than shipped as-is (deblock A/B: severe quilting 272 -> 57).

## What this does NOT touch
- **The portal stays as it is.** The fill is purely additive to
  `client_highres.dat`, which the client already prefers over the portal — so no
  re-split, no reconstruction, no TryDelete anywhere. Portal keeps its 1.48 GiB
  of runway for the geometry lanes (4.P1–4.P4), which are CPU-hours and do not
  fit in this session.
- **INDEX16 records are never converted to DXT.** They take `highres_lane.py`'s
  palette path (upscaled indices, nearest within the record's OWN used palette
  subset), so ClothingTable subpalette recolours keep working and no new
  clipmap-transparency sentinels appear. This is the recolour wall, and the
  tooling already solves it.

## Tasks, in execution order

| # | task | cost | blocking on |
|---|---|---|---|
| F0 | Free buildbox disk (99 % full, 2.5 GB free) — prune artefacts that exist locally | ~15 min | — |
| F1 | Deblock tier-A retail inputs locally (CPU, `deblock.py`) | ~30 min | — |
| F2 | Prove the round trip on a small batch: deblock -> Remacri -> import into a COPY of the r8 highres -> read back + walk | ~20 min | F0, F1 |
| F3 | GPU: Remacri 4× tier A (2,586 new + 1,381 rebakes) — resumable, per-chunk sentinels (SPOT preempts every 8–40 min) | ~2 h GPU | F0–F2 |
| F4 | GPU: tiers B + D (957 records, small) | ~15 min GPU | F3 |
| F5 | GPU: tier C icons (12,833 × 32²->128², fast) — ship only if the UI eye-test is clean | ~20 min GPU | F4 |
| F6 | Import: DXT/RGB via WBT `render-surface-import`, INDEX16 via the palette path; ceiling guard after every chunk | ~45 min | F3+ |
| F7 | Gates: colour ledger vs retail, dims ledger vs r8 (no downscales), walk_check, degrade-chain --check, VmSize note | ~20 min | F6 |
| F8 | Re-assemble the kit (portal + NEW highres + cell), **+ .zip alongside the .tgz** (owner request), re-run kit gates | ~30 min | F7 |
| F9 | 1070 in-client arm: mount + tour + eyeball the new coverage | ~40 min | F8 |

Fallbacks, decided in advance:
- SPOT preempts mid-run → chunked driver resumes from its own sentinels; whatever
  tiers completed still ship (tier A is ordered first for exactly this reason).
- Estimate overshoots the 2.04 GB guard → drop tier C (41 MB, lowest value).
- Icons look wrong in the UI eye-test → drop tier C, keep A/B/D.


---

## Execution log (live)

| # | task | status | actual |
|---|---|---|---|
| F0 | free buildbox disk | DONE | 2.5 GB -> 13 GB (pruned artefacts verified byte-identical locally) |
| F1 | deblock DXT-sourced inputs | DONE | 607 records, grid excess +42.0 % -> -0.4 %, detail kept 103 % mean |
| F2 | prove the round trip | DONE | DXT via WBT `allowCreate` + palette via `DatRecordInsert`, both readback-verified |
| F3 | GPU tier A | DONE | faster than planned: **16,922 records in ~30 min** on the T4 (all tiers, not just A) |
| F4 | GPU tiers B+D | DONE | included in F3 |
| F5 | GPU tier C icons | DONE (not shipped) | baked and parked on the box; see the routing decision |
| F6 | bake + import | DONE (session 2) | ALL 4,868 landed: 1,746/1,746 DXT (the 5 4096-side fails re-baked at 2048 after the root-cause fix) + 3,122/3,122 palette (readback-verified byte-identical); dat compacted 2.00 GiB -> 1.45 GiB final |
| F7 | gates | DONE | walk_check OK (entries=9,575); dims ledger vs r8: added 4,868, 0 downscales / format changes / missing; coverage 4,706 -> 9,574 highres 0x06 (2,412 -> 7,280 of 20,684 retail); colour ledger PASS on the baked sample (lum 1.1540, cast p99 0.058); degrade chains untouched by design (fill is additive to highres only) |
| F8 | kit + zip | DONE (session 2) | acme-r9 kit assembled with .tgz + .zip; patcher-table gate PASS |
| F9 | 1070 in-client arm | pending | the one mandatory gate left before announcing |

### Things that bit, and the fixes
- **SPOT preempted the box mid-session.** The upscale driver skips existing
  outputs, so the restart lost nothing; the *download* was the casualty and was
  re-done as sha-verified 200 MB chunks with per-part retries.
- **The palette solve was the bottleneck** (pixels x palette-entries: ~40 s for a
  1024^2 record against a 600-colour used set). Replaced with a k-d tree solve
  that resolves exact ties back to the lowest palette index — **verified
  bit-identical** to the reference solve, 3-7x faster on the expensive class.
- **The laptop went to swap** with 3 bake workers at ~1 GB RSS each. Added resume
  (skip a record whose output already exists) so workers can be killed and
  restarted freely, which is also what made the k-d tree swap-in cheap.
- **WBT writes imported records UNCOMPRESSED.** On a fill this size that is ~1 GB
  of raw DXT, which would cross the 2 GiB HARD ceiling before the final compress
  could reclaim it. The landing driver now compresses BETWEEN the two write
  stages, not only at the end.

### Session 2 (recovery, same day) — the finisher died at the ceiling
- **Compress-then-insert was not enough: DatCompress LEAKS its savings.** DRW's
  `WriteBlock` reuses an overwritten record's chain head but never returns the
  freed tail blocks to the free chain (header FreeBlockCount stayed 0 all
  night), so every compress pass strands its savings as dead blocks and every
  new insert appends at EOF. The palette inserts therefore hit the 2^31 hard
  ceiling at 1,012/3,122 records (`AllocateEmptyBlocks` int-overflow throw),
  and the finisher died after the dims ledger with no kit, no RESULTS.md.
- **Recovery = DatCompact** (source = the 2.00 GiB stuck dat, seed = the dense
  r8 kit highres): 7,460/7,460 records copied, verify sets clean, 2.00 GiB ->
  1.33 GiB (~715 MB of dead blocks reclaimed).
- **The 5 DXT failures root-caused**: DRW's typed `TryWriteFile` packs into a
  fixed 5 MB rented buffer (its own TODO admits it); the five 4096-side bakes
  (8.4-16.8 MB records) overran it -> bare ArgumentOutOfRangeException. Two
  fixes: WBT now routes records >4.5 MB through a right-sized buffer +
  `TryWriteFileBytes` (proven: 4096^2 DXT1 imports and reads back), and the
  lane policy caps the DXT route at 2048-side (`fill_import.py --max-side`,
  last session's uncommitted intent) — the 5 records ship at 2048/1024 from
  Lanczos-downscaled bakes.
- **DatRecordInsert grew `--compress`**: palette records now land zlib-compressed
  at insert time (IsCompressed flag), so no post-insert compress pass — and no
  leaked tail blocks — is needed for the remaining 2,110 palettes.

### Session 2 continued — owner: "fill the free space in the two dats"
Icons landed and the portal-side plan items audited against what actually shipped:
- **Tier C+D icons: LANDED.** 13,301 remaining fill ids: 12,951 DXT (WBT import,
  0 failures) + 350 palette (`--compress`, readback-verified) + 13
  terrain-protected refusals. The 117 upscales missing from the box corpus were
  Remacri'd on the T4 in one 6-second pass (all P8/INDEX16 icons). Highres
  1.56 -> 1.78 GiB before final compress+compact.
- **4.P1 scenery aa+ab: ALREADY SHIPPED — the plan entry was stale.** All 340
  surfaces' RS records are in the r8 highres (take-5 landed both chunks;
  the split moved them) and their 0x05 collapses are already in the r8 portal
  (collapse pass reports all "unchanged"). Verified, no bytes owed.
- **Statics tranche: ALREADY RAN — "no full-world run" was stale too.** Fresh
  full-world enumerate (60 s, warm hcache) reproduces the dossier numbers
  (1,921 -> 881 -> 438 displace); 437 of 438 are already upgraded in the r8
  portal. The one straggler 0x010040E9 was built (228 -> 912 tris, 4.00x) and
  landed via obj-import into the r9 portal (validate.py green: physDrift 0,
  drawing carried, +51,200 bytes).
- **4.P2 band-object lane: clean NEGATIVE result.** All 5 degrade-deferred
  carriers' band-0 objects (0x01003AF2/5/7/8/9) are gate-refused — no carving
  surface (no height field / zero amp on every poly). The same gate every lane
  obeys; nothing can be displaced. Deferral closed as no-op.
- **4.P3 env re-cut: NOT turnkey — needs its own staged session.** The
  orientation veto (C2) IS wired into relief3d/env_geo since r7, but
  variant_release.sh requires the PRE-envgeo portal (re-cloning on the shipped
  r8 portal double-shells). A re-cut therefore means restaging the portal
  lineage; parked with this note.
- **4.P4 creature-subdiv spike: not attempted this session** (timeboxed
  research; queue next).
