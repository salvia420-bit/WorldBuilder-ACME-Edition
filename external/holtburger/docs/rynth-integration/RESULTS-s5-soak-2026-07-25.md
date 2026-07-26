# RESULTS — S5 soak re-armed + the session-age reframing (2026-07-25, evening)

Executes move 1 of `HANDOFF-s4-battery-s5-preview-2026-07-25.md`: the real S5 soak —
armB's settle-neutral admission base + `decodePressure=512:768`, **without** the
48 MB shard budget — with the battery relay extended first (JS-heap peak per stop,
`decodeAdmission.*`, `shardCacheBytes`, `surfaceCacheBytes`, per instance).

**Verdict up front: three findings, one of them bigger than the arm.**
1. The cold-boot death replicates *with pressure armed and firing* (s0 died 3 stops
   in at 815 MB wasm main, pressure level 2, ÷4 caps engaged) — and the new JS-heap
   column shows the cold-boot killer is **not** renderer JS heap (87 MB at last
   sample). Pressure-at-512:768 does not save the cold spike. First-spike lever
   still needed (move 2).
2. The **late-session killer is renderer JS heap**: in the long warm session the
   JS-heap peak sat ~98 MB for ~40 stops, then jumped to **3.6 GB** (Timaru →
   Town Network) and the renderer died a few stops later — while wasm main stayed
   flat at 384–440 MB and pressure sat at level 0 the whole session. The wasm-only
   battery could never have seen this; the relay extension exists for exactly this.
3. **Settle degrades with session age, and at stops 31+ it collapses to the 45 s
   cap — in every arm that survived that long.** This is the finding that re-frames
   the S4 battery (see §3): cross-arm settle medians are confounded by session
   length, armP's "shard-budget thrash" attribution is unsafe, and part of armT's
   "gate cost" is session age, not the gate.

## 1. Rig + integrity disclosure

- Same rig as `RESULTS-s4-battery-2026-07-25.md` (62-POI `telepoi-list-2026-07-10.txt`,
  `--dwellMax 45`, release wasm in pkg/, nullRender+nosw, local ACE, tailnet1,
  wrapper relaunch on exit 3). Character re-parked at Samsur pre-arm to match the
  S4 arms' cold-boot context. Raw: `/mnt/wbterminal2/s5-soak-2026-07-25/`
  (armS5.json, battery.log, run-armS5.sh; reducer logic = scratchpad reduce-s5.py,
  described by §2's table columns).
- Relay extension landed in `scripts/net-review/battery-telepoi.mjs` before the arm:
  per-stop `jsHeapPeakMB` (max over every 500 ms poll, land + settle),
  `shard/surf{Main,Wkr}MB`, `pressureMain/Wkr`, `effJobs*`, `queued*`,
  `maxQueueMs*`, `sdTot*/sdDids*`, summary aggregates, and (from session 2 on) a
  `kind:"abort"` row that flushes the dying stop's JS-heap peak (excluded from all
  stop metrics and from the `--resume` done-set).
- ⚠ **CONTAMINATION**: two concurrent agent worktree Rust builds (capped-build,
  3.5 GB cgroup) overlapped session 1. The host also hard-rebooted later (18:01) —
  cause established as **thermal, unrelated to load**: a third party covered the
  laptop against rain with a suit cover, blocking fan circulation. The reboot is
  NOT evidence of memory/swap distress; the build-contention caveat on session 1's
  timing stands on its own. When the cover went on is unknown — if it predates the
  13:19 finish, thermal CPU throttling is a second independent contaminator of this
  arm's timing. Either way: armS5's *absolute* settle numbers are not comparable to
  the morning's S4 arms; every finding above that needs timing rests on the
  morning arms or on non-timing observations (crash sites, memory columns). The §3 age-collapse finding does NOT rest on armS5 — armT/armP ran
  uncontaminated in the morning and show the same collapse. armS5's crash/JS-heap
  observations are per-process facts, not timing, and stand.

## 2. armS5 sessions

| sess | stops | died at | settleMed(work) | maxMain | maxWkr | jsHeapPeakMax | pressureMain |
|---|---:|---|---:|---:|---:|---:|---|
| s0 (cold, Samsur boot) | 3 | Al-Jalima | 9.8 s | **815 MB** | 31 MB | 87 MB | **2** (effJobs 1, queued 4) |
| s1 (warm relaunch) | 52 | Tufa | 23.9 s ⚠ | 440 MB | 265 MB | **3586 MB** | 0 for all 42 sampled stops |
| s2 (warm relaunch) | 8 | — (completed) | 2.7 s | 381 MB | 74 MB | 133 MB | 0 |

- s0: pressure fired exactly as designed (level 2, ÷4 caps, main queue backing up)
  and the renderer died anyway at 815 MB wasm main with a *small* JS heap. Two
  independent implications: the 250 ms sampler + cap-halving is too slow/weak for
  the cold ramp (confirming armP), and the cold-spike victim is the wasm/process
  side, not JS-heap growth.
- s1: wasm flat, shards ratcheting normally (55→80 MB), surface caches pinned at
  96 MB (as designed), pressure level 0 — **nothing wasm-side moved** while
  jsHeapPeak went 98 MB → 3.6 GB between Swank and Timaru and the renderer died
  ~4 stops later. The killer lives in the renderer process outside wasm linear
  memory: JS-heap/GC-side accumulation. (An independent code pass the same day
  found bake-worker decoded-handle releases waiting on GC —
  `feat/first-bake-batches` commit 259dbd5a — a direct mechanism candidate.)
- Pressure design note (by construction, not measured): `wasmMemoryBytes` is a
  monotone high-water, so `decodePressure` is a **one-way ratchet per instance** —
  once a spike crosses t1/t2 the instance is throttled for its remaining lifetime
  even if live occupancy falls. s0 demonstrates the crossing; no session here
  paid the steady-state tax only because warm sessions never crossed 512 MB.

## 3. The session-age collapse (uses all five arms' raw rows)

Work-guard settle medians bucketed by **in-session stop index** (not route
position; n per bucket 4–22):

| arm | 1–5 | 6–10 | 11–20 | 21–30 | 31–40 | 41+ |
|---|---:|---:|---:|---:|---:|---:|
| unbounded | 7.4 | 16.0 | 19.8 | 14.0 | — | — |
| armB | 12.2 | 17.2 | 14.4 | 10.9 | — | — |
| armT | 4.4 | 14.5 | 16.7 | 13.3 | **45.0** | **45.0** |
| armP | 14.3 | 21.6 | 12.7 | 13.8 | **45.0** | **45.0** |
| armS5 ⚠ | 3.1 | 2.7 | 25.1 | 14.3 | **45.0** | 42.1 |

- Every session that reached stop 31+ hit the dwell cap as its *median*, across
  three different arm configs and different towns. Same-town control: Zaikhal
  settles in 0.8 s at session age ~14 (armB s3) and caps at 45 s at age 52–60
  (armT s1, armP s2). unbounded/armB never show the collapse only because their
  renderers died before stop ~30 every time.
- **Re-attributions.** (a) armP's 24.5 s settle median was blamed on
  `shardBudgetMB=48` thrashing; its long session (52 stops) is exactly the
  age-collapse regime, so that refutation of 48 MB is **unsafe** — the shard
  budget needs a clean age-matched re-test before "48 thrashes on world-roam" is
  believed. (b) Part of armT's +4.4–7 s "gate cost" is age (its s1 ran 60 stops —
  the deepest-age arm of the battery); its 6–20 buckets are comparable to armB's.
  The S4 "the gate gates" verdict still holds directionally (armT's *early*
  buckets and floor-guard settles regress too) but the magnitude is inflated.
- **Cross-arm settle comparison is invalid unless sessions are age-matched.**
  The driver already has the tool: `--maxStops K` (exit-3 relaunch after K stops)
  makes every session the same length by construction. All future arms: run with
  `--maxStops 15`.
- Two accumulators, two scoreboards (corrected same day after the
  `feat/first-bake-batches` pass flagged a category error in the first draft):
  1. **Bake-worker handle leak** (fixed in 259dbd5a): deferred `.free()` retains
     the Rust `Box` in the *worker's wasm linear memory* — `performance.memory`
     never counts wasm, so `jsHeapPeakMB` is the WRONG falsifier for this fix.
     Score it on **worker `wasmMemoryBytes`** (its high-water band was
     247–301 MB across arms).
  2. **The 3.6 GB JS-heap ramp** is a different retainer. Best-evidence
     candidate (read-verified): `MaterialCache` — `materials`/`textures`/
     `normalTextures`/`heightTextures` have zero delete/clear sites, and
     `adapter.js surfacePixelsToTexture` always copies the RGBA into the
     retained `DataTexture.image.data` (~8 B/px effective per cached DID;
     ~1,800 distinct surfaces ≈ 3.6 GB). Under `nullRender=1` nothing is
     uploaded or disposed, so it is a pure JS-heap accumulator, and the
     quantized flat-then-jump `usedJSHeapSize` trace is exactly what a
     monotone retainer looks like through a step detector.
     Discriminator now in the battery relay: per-stop `mats`/`texs`
     (`materialCache.materials.size`) — linear growth from stop 1 confirms,
     flat across the jump refutes and sends the hunt to the Timaru leg.
  The age-collapse's settle side (GC/main-thread pressure growing with the
  retained set) is predicted by accumulator 2; the falsifier for the collapse
  itself is a capped-or-evicting MaterialCache arm whose 31+ bucket stops
  capping.

## 4. Disposition

1. **Do not arm `decodePressure` as a cold-spike defense** — proven insufficient
   (s0, armP s0/s1). Keep it armable; its honest value is late-session pipeline
   pacing, which the handle fix may obsolete.
2. **Validate the bake-worker handle-release fix** (`feat/first-bake-batches`
   259dbd5a) on **worker `wasmMemoryBytes`** (not `jsHeapPeakMB` — see §3), and
   pursue the MaterialCache retainer as its own slice against the late deaths /
   age collapse: one long-session arm (no maxStops) watching `mats`, `jsHeapPeakMB`
   and the 31+ bucket; then a bounded-MaterialCache arm as the fix candidate.
   Keep the two levers separately falsifiable.
3. **First-spike (cold-boot) lever remains open** and is a separate killer:
   wasm-side transient at boot (815–985 MB), JS heap innocent there. The
   `?bakeBatchMax=N` lever and/or option E (Arc'd SurfacePixels, kills the 2×
   clone transient) are the candidates; measure per-session max wasm main
   matched on cold boot at Samsur.
4. **Re-run any settle-sensitive comparison age-matched** (`--maxStops 15`) and
   **never run builds concurrently with a battery on this box** (this run's s1 is
   the cautionary tale).
5. armS5's clean re-run is folded into the post-merge validation battery (fix +
   flags land first — re-running the contaminated arm as-is would measure a
   codebase we're about to change).

## Traps (new)

- **Builds contaminate batteries**: capped-build's 3.5 GB cgroup + a battery
  chromium + the stream kiosk exceed the 8 GB box; settle numbers taken during a
  concurrent build are garbage. (The same-day host reboot was thermal — a rain
  cover blocking the fans — not build-induced; don't cite it as an OOM datum.)
- **`cargo fmt`/rustfmt needs the capped-build jail too** — same evening, a
  rustfmt run over the ~10-kloc lib.rs (outside the cgroup, inheriting the
  agent tree's oom_score_adj −900 protection) ballooned to 6.5 GB anon-RSS;
  the kernel OOM killer spared it *because* of the protection and shot
  unprotected system daemons instead — mariadb among the casualties (auth DB
  down ⇒ every subsequent ACE login hung with "session created, auth never
  runs, Network Timeout" while the world ran normally off the entity cache).
  Any Rust toolchain invocation — build, test, fmt, clippy — goes through
  `capped-build`, no exceptions; and an ACE login timeout with a healthy-looking
  world should be answered with `ss -tlpn | grep 3306` first.
- **Session length is a confounder for every per-arm median.** Compare
  age-matched (`--maxStops`) or bucket by in-session index; a "better" arm may
  just be an arm that crashed earlier.
- `performance.memory.usedJSHeapSize` is coarsely quantized (identical readings
  for ~40 stops, then a jump) — treat it as a step detector, not a gauge.
- The `kind:"abort"` row exists only from armS5 s2 onward; earlier sessions'
  die-stops have no row (the peak shown for s1's death is from its *last
  completed* stop's polls).
