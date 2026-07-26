# RESULTS — ABAB interleave: surface-budget default question SETTLED (2026-07-26, 00:49)

Executes next-move 2 of `RESULTS-validation-battery-2026-07-25.md`: the armSB settle
delta (12.6 s vs 9.8 s) could not be re-decode (decodeAmp was exactly 1.0) and ambient
drift was suspected; ship criterion required settle-within-noise at n≥2, interleaved.
Same rig as the validation battery: release wasm 4.9 MB (Jul 25 19:16 build, merged
master `2e473ad6` + docs commit), `--maxStops 15` age-matched, park-at-Samsur + 75 s
quiet gap between arms, sequential, **no concurrent builds** (verified: both agent
worktree builds completed before arm 1 parked).
Raw: `/mnt/wbterminal2/abab-surface-budget-2026-07-25/` (4 arm JSONs, abab.log,
run-abab.sh).

## Arms (22:52–00:49, strictly interleaved A→B→A→B)

| arm | flags | settleMed(work) | capped | landed | surf max (M/W) | maxMain | maxWkr | jsPk |
|---|---|---:|---:|---:|---|---:|---:|---:|
| armA1 | default | 11.7 s | 10 | 58/62 | 96/96 | 984 | 196 | 111 |
| armB1 | `surfaceBudgetMB=24:64` | **10.3 s** | 10 | 58/62 | **24/64** | 981 | **162** | 117 |
| armA2 | default | 14.6 s | 18 | 58/62 | 96/96 | 999 | 197 | 111 |
| armB2 | `surfaceBudgetMB=24:64` | 14.9 s | 17 | 58/62 | **24/64** | 988 | **164** | 159 |

decodeAmp = **1.000** on both instances in **every** arm (`sdTot == sdDids` throughout).

## Verdict: ship criterion MET — arm `24:64` as the default

1. **Settle-within-noise at n=2: yes, with sign flip.** Within-pair deltas: pair 1
   B−A = −1.4 s (budget arm *faster*), pair 2 B−A = +0.3 s. The between-pair drift
   (A1 11.7 → A2 14.6 s on identical code and flags) is 4–5× the within-pair deltas.
   Tonight's earlier 12.6 s armSB reading is hereby attributed to ambient drift, as
   suspected.
2. **The drift is real, ambient, and symmetric** — the pair-2 mid-arm collapse
   (in-session bucket medians 34.4 s in armA2 session 2, 30.5 s in armB2 session 2)
   hit BOTH arms at the same route positions ~90 min apart. Whatever it is (thermal,
   cron, page-cache state), it is not the flag; this is exactly the confound the
   interleave was built to absorb, and why the single-sequential-arm design kept
   mis-scoring armSB/armBB16.
3. **The gate gates, again**: `surfaceCacheBytes` pinned at 24/64 vs 96/96 in both B
   arms — the ~104 MB resident saving — and worker wasm high-water is consistently
   ~33 MB lower under the budget (162/164 vs 196/197 MB).
4. **Cold spike untouched** (maxMain 981–999 across all arms) — expected; residency,
   not transient. That lever is option E + the alias-leg work (see the option E
   commit `81ad4891` and its analysis: `bakeBatchMax` was never applied to the two
   entity/alias fetch paths, so verdict 4's refutation never tested them).

## Default-arming plan (next commit)

Page-side: when `?surfaceBudgetMB` is absent, apply `24:64`; `?surfaceBudgetMB=off`
(and explicit `96:96`) restores today's constant behaviour. Rust stays untouched —
the LazyLock-init plumbing already takes whatever the page sets before init. Tests:
flip the absent-⇒-unset negative control to absent-⇒-24:64, keep an `off`-⇒-unset
control. url-flags.md row moves from armable-but-off to default-on-with-escape.

## Traps for the next reader

- The between-pair drift means **any un-interleaved settle comparison on this box is
  untrustworthy at the ±3 s level**. Interleave or bucket by wall-clock; never compare
  arms run hours apart.
- armB2's jsPk 159 MB (vs 111–117 elsewhere) is a default-build MaterialCache session
  reaching 15 stops with a dense town mix — unrelated to the surface budget (surface
  planes live in wasm, not JS heap).
