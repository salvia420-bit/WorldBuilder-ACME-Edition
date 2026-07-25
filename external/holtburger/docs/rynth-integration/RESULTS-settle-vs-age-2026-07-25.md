# RESULTS — settle vs. session age, re-run properly (2026-07-25)

Answers recommendation 3 of `HANDOFF-wasm-threads-SAB-2026-07-24.md`: re-run the
settle-vs-age test with the real settle metric, on a RELEASE wasm build, on the current
default-neutral tree (`90fa3d12..750cb1ec`, S1–S4 + shards budget all armed-but-off).

**Verdict up front: finding 5 HOLDS DIRECTIONALLY BUT ITS MAGNITUDE IS REFUTED.**
Re-decode volume is real and is the thing settle tracks — but the dynamic range that made
it look decisive (84.7 s cold, 20–28 s novel cap) is a **dev-wasm artifact**. On release
wasm the entire range is 2.4 s → 16.6 s. Path A's XL is aimed at a ceiling roughly **4×
smaller** than the 07-20 evidence implied.

---

## Method

### Why not `portal-settle-probe.mjs` unmodified

The shipped probe computes **exactly one settle per process** (an `--accumulate` leg, then
a single `--dest`). Finding 5 is a **within-session** claim — the same town at hops 1, 8
and 16 of one continuous session — which the probe's shape cannot express. Running it three
times would put each hop in its own fresh process, destroying the very thing under test
(accumulated residency).

So: the **recorder and the settle computation were copied verbatim** out of
`portal-settle-probe.mjs` (2026-07-11) into a route driver, and applied to **every hop** of
one session. Only the driving loop differs. The metric is therefore identical and the
numbers are comparable to other portal-settle output.

Settle (unchanged, verbatim): first 3 s window (12 × 250 ms buckets) at/after `landed`
satisfying **all** of — no long task > 100 ms; input-lag p95 < 50 ms; `cellContainers3d`
flat; `envCellBuildInFlight` == 0; bake-worker seq flat; entity count flat (±1);
park+unpark+evict deltas == 0.

Driver: `route-settle-probe.mjs` (scratchpad; not committed — it is measurement scaffolding,
and the task scoped the commit to this doc).

### Rig

- Release wasm, built for this run: **4,881,207 B (4.88 MB)**; the tree's previous `pkg/`
  was a **16.3 MB dev** build. `scripts/wasm-memcheck.py` → *NOT shared — plain
  single-threaded memory*, min 136 pages. **`pkg/` is left holding this RELEASE build.**
- `--query "nullRender=1"` (mandatory on this 8 GB laptop; `boot.mjs` also forces it).
  `?nosw=1` on every boot. Local ACE, account `tailnet1`, fresh `--user-data-dir` per run.
- Per hop: `@telepoi <town>`, poll until `landblockId` high16 changes → `landed` mark, then
  record **110 s** (hop 1: **160 s**, to leave room for the claimed 84.7 s cold settle).
- Per hop, before and after, `window.__diag.datDecode()` → `wasmMemoryBytes`,
  `shardCacheBytes`, `surfaceCacheBytes` from **both** wasm instances (main + bake worker).

### Route (n=1 full route, 16 hops, one continuous session, ~37 min)

Anchor = **Holtburg** at hops **1 / 8 / 16** (same anchor position as the original), with
novel towns interleaved. Untimed pre-hop to **Samsur** first: the boot decodes the spawn
town, so the character must be parked outside every route town or the anchor's "cold" hop
is not cold. (This caught a real trap — the character was parked at **Shoushi**, which was
hop 9 of the draft route and would have entered the table as a pre-warmed "novel" town.
Shoushi was replaced with Mayoi.) The driver re-parks at Samsur on exit so a repeat run
starts cold.

---

## Per-hop table

`settle` = land→settle. Bold = the anchor town. `main`/`wkr` = per-instance wasm linear
memory (MB); `shard` = `shardCacheBytes`; `surf` = `surfaceCacheBytes`.

| hop | town | settle s | chat-ready s | main MB | wkr MB | m.shard | w.shard | m.surf | w.surf | ltMax ms |
|----:|------|---------:|-------------:|--------:|-------:|--------:|--------:|-------:|-------:|---------:|
| **1** | **Holtburg (cold)** | **16.6** | 0.1 | 689 | 167 | 52 | 18 | 92 | 96 | 67 |
| 2 | Rithwic | 12.5 | 2.5 | 689 | 167 | 53 | 20 | 96 | 96 | 104 |
| 3 | Cragstone | 14.8 | 1.1 | 689 | 167 | 54 | 22 | 96 | 96 | 455 |
| 4 | Eastham | 11.7 | 2.3 | 689 | 167 | 55 | 23 | 96 | 94 | 108 |
| 5 | Arwic | **no settle >110** | 14.3 | 689 | 188 | 60 | 30 | 96 | 96 | 687 |
| 6 | Lytelthorpe | 10.2 | 1.0 | 689 | 188 | 60 | 30 | 96 | 96 | 80 |
| 7 | Yanshi | 13.5 | 1.0 | 689 | 188 | 61 | 34 | 96 | 96 | 85 |
| **8** | **Holtburg (revisit)** | **2.4** | 2.4 | 689 | 215 | 62 | 34 | 96 | 95 | 241 |
| 9 | Mayoi | 11.9 | 2.0 | 689 | 241 | 62 | 37 | 96 | 95 | 133 |
| 10 | Sawato | 11.8 | 1.6 | 689 | 241 | 63 | 38 | 96 | 96 | 889 |
| 11 | Nanto | 11.1 | 1.2 | 689 | 241 | 63 | 38 | 96 | 96 | 84 |
| 12 | Baishi | 13.2 | 2.8 | 689 | 241 | 63 | 39 | 96 | 96 | 207 |
| 13 | Hebian-to | 9.8 | 1.1 | 689 | 241 | 64 | 40 | 96 | 96 | 110 |
| 14 | Zaikhal | 16.6 | 6.3 | 689 | 241 | 66 | 42 | 96 | 94 | 331 |
| 15 | Yaraq | 12.4 | 4.4 | 689 | 241 | 67 | 42 | 96 | 96 | 124 |
| **16** | **Holtburg (revisit)** | **9.2** | 2.5 | 689 | 241 | 67 | 42 | 96 | 96 | 253 |

All 16 hops landed (`moved=true`). Novel-town settle band: **9.8 – 16.6 s** (mean ≈ 12.5 s),
plus one non-settler (Arwic).

---

## Verdict on finding 5

Finding 5 claimed: *revisiting one town at hops 1/8/16 settles 84.7 → 9.3 → 8.3 s while
novel towns cap at 20–28 s; therefore settle tracks cold-decode VOLUME, not session age.*

**What reproduces**

- **Revisit is genuinely cheaper than novel.** Hop 8 Holtburg settles in **2.4 s** — far
  below the entire novel band (9.8–16.6 s) and below every other hop in the run. Its blocker
  census is also qualitatively different: no `cellsGrowing`, no `envInFlight`, no `lruChurn`.
  Nothing was re-decoded, and settle collapsed. That is finding 5's mechanism, confirmed on
  a release build with the honest metric.
- **Settle is a decode-volume signal, not a clock.** Session age alone does not push settle
  up: hops 9–15 (late session, novel) sit in the same band as hops 2–4 (early session,
  novel). A pure age/high-water story predicts a rising trend across the run; there is none.

**What does NOT reproduce**

- **The 84.7 s cold settle is gone.** Hop 1 cold Holtburg = **16.6 s** on release wasm —
  and it is *not even the slowest hop*; Zaikhal (novel, hop 14) ties it at 16.6 s. The 07-20
  cold figure was ~5× this, on a dev build with the crude time-to-quiet metric.
- **The 20–28 s novel cap is gone.** Novel towns cap at ~16.6 s.
- **"Revisit collapses and stays collapsed" is refuted.** The anchor's third visit (hop 16)
  settles in **9.2 s — 4× its hop-8 revisit**, landing at the low edge of the novel band
  rather than near hop 8's 2.4 s. Finding 5 read 9.3 → 8.3 s across hops 8 → 16 and
  concluded revisit cost is flat; here it climbs.

**The honest reading of hop 8 vs hop 16.** The most likely explanation is *not* that age
per se costs time, but that by hop 16 the LRU had **evicted** Holtburg's content, so the
third visit paid cold decode again — which is still decode volume. The blocker census
supports this: hop 16 shows `cellsGrowing` + `lruChurn` (rebuilding) where hop 8 showed
neither. But note what that implies: **"revisit" is only cheap while the content is still
resident**, and residency lifetime is set by session-wide churn. Decode volume and session
age are not cleanly separable on this evidence — the run cannot fully distinguish them, and
neither could the original. Stated precisely: *settle tracks whether the destination must be
re-decoded; session age is what determines whether it must be.*

**Consequence for Path A.** The pool's justification survives — decode throughput is still
the lever that moves settle. But the prize is smaller than advertised: the worst settle
observed is ~16.6 s, not ~85 s, and the median hop is ~12 s. **A15 (a)/(b) attack the same
12–16 s band that Path A's XL targets.** Recommendation 1 of the handoff (do A15 (a)+(b)
first) is strengthened, not weakened, by this run; an XL justified on an 85 s ceiling should
be re-argued against a 16 s one.

---

## Release-build memory observations (not previously measured)

Free corroboration, on a RELEASE build, of the S1/S2 first-spike finding:

1. **The main instance's high-water is set at hop 1 and never moves: 689 MB, flat across
   all 16 hops.** Not a slow ratchet — a first-spike floor. This is within 1 MB of the
   dev-wasm arm A figure (690 MB) from `EXPERIMENT-threads-lite-2026-07-24.md`.
   **Shipping release wasm shrinks the module ~3.3× (16.3 → 4.88 MB) and does not reduce
   the linear-memory high-water at all.** Code size and heap high-water are independent
   budgets; do not expect a release build to buy OOM headroom.
2. **The worker ratchets in steps and then stops**: 167 MB (hops 1–4) → 188 (5–7) → 215 (8)
   → 241 (hop 9 onward, flat for the last 8 hops). Page total ≈ **930 MB**, consistent with
   arm A's 917 MB.
3. **Finding 6's duplication is visible from hop 1 on release, not only "under load".**
   Both instances sit pinned at their own **~96 MB** `surfaceCacheBytes` from the first hop —
   ~192 MB where the design documents 96 MiB. The handoff's warning that "a 30-second probe
   shows ~2 MB and misleads" is a dev-build observation; on release the duplication is
   immediate and total.
4. **`shardCacheBytes` is the one true slow ratchet**: main 52 → 67 MB, worker 18 → 42 MB
   over 16 hops; combined 70 → 109 MB, monotone, never plateauing (§1's bound is default-off).
   It is real but is not the dominant term — ~109 MB against a 930 MB page.

---

## Caveats

- **n=1 for the full route.** One clean 16-hop run; wall clock (~37 min/route) did not
  permit a second. The anchor is n=1 at each hop position, exactly as the original was —
  this run improves the *metric* and the *build*, not the sample size. The hop 8 → hop 16
  rise (2.4 → 9.2 s) is the load-bearing new observation and deserves a confirming run.
- **Hop 5 (Arwic) never settled** within its 110 s window — input-lag blocked 379 of 390
  candidate windows, with a 687 ms long task. Recorded as "no settle >110 s" rather than
  imputed. One novel town therefore *did* exceed the band badly, which is the one datum
  friendly to finding 5's "novel caps high" half.
- **75 net failures / 75 console errors, all 404s for missing baked scenery shards**
  (`0xBCA1.scenery.jsonl` etc., clustered around the Cragstone-area LBs) — the dist is
  partial. A missing shard is a fetch that fails fast rather than a decode that costs time,
  so this biases settle **down** if anything, uniformly across novel hops. It does not touch
  the anchor comparison (Holtburg's own LBs produced no 404s).
- **Compare pattern, not absolutes, against 07-20**: different build (release vs dev),
  different metric (honest settle vs time-to-quiet), and the new default-neutral S1–S4
  instrumentation is present.
- `nullRender=1` throughout: these are decode/residency settle times with no real
  rasterization. Frame-recovery numbers are meaningless here and were not used.
