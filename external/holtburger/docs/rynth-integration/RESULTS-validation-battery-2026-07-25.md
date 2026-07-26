# RESULTS — post-merge validation battery (2026-07-25, night)

Validates the three things merged this evening (bake-worker handle-release fix +
`?bakeBatchMax=N` in `feat/first-bake-batches`; `?surfaceBudgetMB=N[:M]` in
`feat/surface-budget-mb`) and the MaterialCache hypothesis from
`RESULTS-s5-soak-2026-07-25.md`. Same rig as the S4/S5 docs; release wasm 4.9 MB
built from merged master; every arm re-parked at Samsur; **no concurrent builds**;
full stack freshly restored (ACE + serve.py + wsbridge + mariadb — see the
infra postmortem in the S5 doc's traps and below).
Raw: `/mnt/wbterminal2/validation-battery-2026-07-25/` (4 arm JSONs, battery.log,
run-validation.sh, resume-after-mysql.sh, boot-probe.mjs).

## Arms (sequential, 19:58–21:48)

| arm | flags | sessions | deaths | settleMed(work) | capped | maxMain | maxWkr | jsPk max |
|---|---|---|---:|---:|---:|---:|---:|---:|
| armLong | none, unlimited | **1** | **0** | 17.1 s | 20 | 679 | **234** | **3586** |
| armM15 | none, `--maxStops 15` | 5 | 0 | **9.8 s** | 8 | 986 | 200 | 133 |
| armBB16 | `bakeBatchMax=16`, maxStops 15 | 5 | 0 | 12.2 s | 11 | **934** | 190 | 93 |
| armSB | `surfaceBudgetMB=24:64`, maxStops 15 | 5 | 0 | 12.6 s | 15 | 985 | 163 | 121 |

## Verdicts

1. **MaterialCache retainer: CONFIRMED.** armLong's per-stop `mats` grows
   linearly from stop 1 (6 → 479 → 1,117 → 1,777 → 1,802) and the quantized
   `usedJSHeapSize` gauge steps 117 MB → **3,586 MB at mats≈1,777** — within 1%
   of the predicted ~1,800 surfaces ≈ 3.6 GB (`DESIGN-first-bake-batches` §6 /
   S5-soak §3 accumulator 2). The discriminator's "linear from stop 1" branch
   fired. **Bounding/evicting the MaterialCache maps is the next slice** — it is
   now the only known driver of both the late-session heap and (see 3) the
   settle age-collapse.
2. **Handle-release fix (259dbd5a): positive on its scoreboard.** Worker wasm
   high-water 234 MB over a full 62-stop single session vs the pre-fix 247–301 MB
   band on shorter sessions — and armLong is the **first unlimited-session arm
   ever to finish the route with zero renderer deaths** (pre-fix baseline:
   deaths every ~7–50 stops). Deaths-zero across all four arms tonight.
3. **Age-collapse: persists, now interventional.** armLong (one long session)
   settles at 17.1 s median with 20 caps; armM15 (same code, 15-stop sessions)
   at 9.8 s with 8. Session-length capping removes most of the collapse —
   confirming the S5 doc's confounder finding by intervention, not just
   bucketing. armLong's settles degrade continuously as `mats` grows (caps from
   ~stop 19, long before the 3.6 GB step) — GC pressure from the growing
   retained set remains the best mechanism. Falsifier for the MaterialCache
   slice: a bounded-cache armLong rerun whose 31+ bucket stops capping.
4. **`bakeBatchMax=16`: REFUTED for the cold spike** — its pre-registered
   most-likely refutation branch. Per-session cold-boot maxMain 678–934 MB, the
   same lottery range as unbatched arms; plus a settle cost (12.2 vs 9.8 s).
   The main-instance boot transient is batch-size-independent. Keep the flag
   armable-but-off (it is still the right instrument for submission-size
   experiments); aim the next cold-spike attempt at **main-only allocators**:
   option E (`clone_surface_pixels` 2× transient, surface-budget design §2E)
   and the alias-leg decode path that only main runs.
5. **`surfaceBudgetMB=24:64`: gates perfectly, cost unresolved.**
   `surfaceCacheBytes` provably pinned at 24/64 MB (vs 96/96) — the ~104 MB
   resident saving — and **decodeAmp = 1.000 on both instances in every
   session** (ship criterion ≤ 1.15). The 12.6 vs 9.8 s settle delta cannot be
   re-decode (amp is exactly 1.0) and matches armBB16's identical drift (12.2 s)
   later in the evening — ambient drift suspected, but ship criterion requires
   settle-within-noise at n≥2, so: **do not arm a default yet**; repeat
   default-vs-24:64 interleaved (ABAB) before deciding. The cold spike is
   untouched by the budget (expected — residency, not transient).

## Infra postmortem (evening)

A thermal shutdown (laptop covered against rain, fans blocked) rebooted the box
at 18:01, killing ACE, serve.py, the wsbridge (its `@reboot` cron entry appears
to race the /mnt mount), and later mariadb fell to the 19:03 OOM storm caused by
an un-jailed 6.5 GB rustfmt (see S5-doc trap). Symptom ladder worth keeping:
`SERVER_DOWN` (serve.py) → ws `ERR_CONNECTION_REFUSED` (wsbridge) → login
"connect failed: timeout" with ACE logging session-created-but-no-auth
(mariadb). The recovery chain is scripted in `resume-after-mysql.sh`.

## Next moves, in order

1. **Bound MaterialCache** (materials/textures/normalTextures/heightTextures) —
   byte- or count-budget LRU with dispose on evict, default chosen after an
   armLong-style rerun; the `mats`/`texs` relay columns are the instrument.
   Expected to retire: the 3.6 GB step, the residual age-collapse, and the
   `--maxStops` workaround.
2. **Repeat armSB vs default interleaved** (ABAB, same night) to settle the
   surface-budget default question.
3. **Cold spike**: option E (Arc'd `SurfacePixels` planes) — now the strongest
   remaining candidate for the 678–986 MB boot transient.
4. Update `url-flags.md`/handoff status for `bakeBatchMax` (armable, refuted
   for cold-spike purpose).
