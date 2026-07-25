# HANDOFF — S4 battery run + S5 preview + surface-budget design (2026-07-25, PM)

> Executes moves 1 (fully), 2 (previewed), and 4 (design pass) of
> `HANDOFF-A15-landed-2026-07-25.md`. No source or wasm changes this session —
> measurement + design + one docs fix only. Anchor by symbol; lines drift.

## What happened

1. **S4 full battery ran and is decided** — `RESULTS-s4-battery-2026-07-25.md`.
   Gate proven real (armT regresses +4.4–7 s settle, 3× capped stops); armB
   settle-neutral; **the smoke's 44% first-hop high-water drop is REFUTED** (sampling
   artifact — armB s0 later peaked at 985 MB, the battery's worst). **S4's default
   stays off.** Steady main is ~383 MB in every arm; the cold spike (681–985 MB) is
   untouched by admission.
2. **S5 preview (armP)** — armB base + `decodePressure=512:768` + `shardBudgetMB=48`:
   pressure sat provably at level 0 in the long session (max 405 MB < t1), so the
   observed **24.5 s settle median is `shardBudgetMB=48` thrashing on a world-roam
   route** — the handoff's "48–64 production number" is refuted at 48 for roaming.
   Cold-spike session-0 crashes happened *with* pressure armed (sampler too slow, or
   the killer transient isn't wasm linear memory). Crash-free long sessions in armT
   (60 stops) and armP (52) both correlate with a slowed decode pipeline — the lever
   is real, but must stay pressure-conditional to be settle-free.
3. **Surface-budget design pass** — `DESIGN-surface-budget-2026-07-25.md`
   (agent-drafted, citations read-verified): 96 MiB/instance is a compile-time
   constant (`SURFACE_CACHE_BUDGET_BYTES`, apps/holtburger-web/src/lib.rs);
   the JS `MaterialCache` never re-requests a materialized DID, so both caches are
   over-provisioned by construction. Recommendation: default-neutral role-asymmetric
   `?surfaceBudgetMB=N[:M]` (shard_cache precedent), ~104–112 MB resident saving at
   `24:64`; derived-plane drop as follow-on; shared-cache deferred behind threads.
   Bonus: `?surfaceCache=off` is a now-valid bracketing instrument (post-S0).
4. **Docs fix**: `apps/holtburger-web/docs/url-flags.md` `surfaceCache`/`palSurfaceCache`
   rows no longer claim the worker ignores the flags (stale since S0 63938b48).

Raw data: `/mnt/wbterminal2/s4-battery-2026-07-25/` (4 arm JSONs + battery.log).
Reducer: session-segmented (renderer deaths), guard-segmented medians — the
scratchpad `reduce.py` logic is described in the RESULTS doc's tables.

## Next moves, in order

1. **Real S5 soak, re-armed**: `decodePressure=512:768` WITHOUT the 48 MB shard
   budget (or with 96/instance); artifact = time-to-first-renderer-death on the
   62-POI route (baseline: unbounded crashed at stops ~7/32/53). Before running,
   extend the battery relay's field list with JS-heap (`performance.memory`),
   `decodeAdmission.effectiveMaxJobs/pressureLevel`, and `shardCacheBytes` — the
   cold-spike killer is currently invisible (likely JS-side; wasm main read only
   120–680 MB at death in different sessions).
2. **First-spike lever**: admission is the wrong tool (proven); try smaller
   first-bake batches per the A15 handoff's alternative.
3. **Implement `?surfaceBudgetMB=`** per the design doc's slice plan (S-A/S-B),
   bracketed first with a `?surfaceCache=off` battery arm for the ceiling.
4. Rayon-pool re-scope (§2.1c) is still parked behind the ~16 s settle ceiling
   argument — unchanged by today.

## Traps confirmed/added

- **First-hop memory samples under any admission gate are meaningless** — the gate
  stretches the ramp past the sample; compare per-session max, matched on boot town
  (session boot town swings maxMain 383↔681 MB on its own).
- Gated arms die 2–3 stops after a COLD boot (armB s0, armP s0+s1) — the cold spike
  is where renderers die, and wasm-memory-triggered throttles don't fire in time.
- `battery-telepoi.mjs` wrapper contract: exit 3 → relaunch with `--resume`
  (script self-applies the ACE quiet-gap); seed `--resume` if the out JSON already
  exists or prior rows are overwritten.
- `decodePressure` without a `decodeAdmission` base is inert by design
  (`usize::MAX / 4` — decode_admission.rs `effective_max_jobs` note).
